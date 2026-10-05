---
name: clickup
description: >
  Two-way ClickUp bridge for the theme pipeline. INGEST: given a task ID or URL,
  fetch title, description, comments, mockup images, custom fields, and subtasks,
  download the images, write a clickup-context.md artifact, and route to /clarify
  (features) or /fix (bugs). ACT: given a natural-language instruction, add a comment
  or threaded reply, change status, assign, or log/track time on a task. Use whenever
  work starts from a ClickUp task or you want to update one.
disable-model-invocation: true
argument-hint: "[task-id | url] OR an instruction like: add comment to TASK \"...\""
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, mcp__claude_ai_ClickUp__clickup_get_task, mcp__claude_ai_ClickUp__clickup_get_task_comments, mcp__claude_ai_ClickUp__clickup_get_threaded_comments, mcp__claude_ai_ClickUp__clickup_create_comment, mcp__claude_ai_ClickUp__clickup_update_task, mcp__claude_ai_ClickUp__clickup_add_time_entry, mcp__claude_ai_ClickUp__clickup_start_time_tracking, mcp__claude_ai_ClickUp__clickup_stop_time_tracking, mcp__claude_ai_ClickUp__clickup_resolve_assignees
---

# ClickUp: Task Context Bridge (Ingest & Act)

You are the bridge between ClickUp and the theme pipeline. You either **ingest** a task's full context into an artifact, or **act** on a task (comment, status, time) on the user's behalf.

**Do NOT write theme code or plan implementation here. Only ingest context or perform the requested ClickUp action.**

**Do NOT assume or hallucinate task content, links, statuses, or timestamps. Only use what the ClickUp API returns or what the user provides. If something is missing, ask.**

## Input
`$ARGUMENTS`

A task is referenced as: a bare ID (`86d3gp26j`), a custom ID (`DEV-1234`), a URL (`https://app.clickup.com/t/86d3gp26j`, take the part after `/t/`), or a `Clickup ID:` line. Multiple comma/newline-separated IDs are allowed (ingest only).

---

## Step 1: Verify the ClickUp MCP is connected

Make the relevant ClickUp call. If the tool is unavailable or the server is not connected, stop and tell the user:

```
ClickUp MCP server not connected.
Connect ClickUp via your Claude integrations (or `claude mcp add`), then re-run /clickup.
```

> The `allowed-tools` names match a connection called `claude_ai_ClickUp`. A different server name still works; you may just be prompted to approve the calls once.

---

## Step 2: Pick the mode

Read `$ARGUMENTS` and decide:

- **Ingest mode**: the input is only a task ID/URL (or `Clickup ID:` line) with no instruction, or it asks to "pull / get context / start work on" a task. Go to **Part A**.
- **Action mode**: the input contains an instruction to change the task. Trigger verbs include *add comment, reply, comment, notify, mark as, move to, set/change status, assign, log time, track time, start timer, stop timer*. Go to **Part B**.

Always extract the target task ID from the text. If no ID is present, fall back to the active feature's `clickup-context.md` (it records the source task ID). If still none, ask. If the intent is genuinely ambiguous, ask whether to ingest or act.

---

# PART A: Ingest mode

## A1: Fetch each task
For every parsed ID:
```
clickup_get_task(task_id, include: ["description", "custom_fields", "checklists", "subtasks", "linked_tasks", "dependencies"])
```
Capture `name`, `markdown_description` (**use this, not `text_content`**, because `text_content` strips image links), `status`, `priority`, `tags`, `assignees`, `task_type`, `list`, `folder`, `space`, `url`, `custom_fields`, `checklists`, `linked_tasks`, `dependencies`, and `subtasks`. If an ID errors, report it and continue with the rest.

## A2: Resolve scope
- **One leaf task**: it is the feature/bug. Proceed.
- **Multiple IDs**: `AskUserQuestion`. Either **Merge into one feature** (single context doc) or **Treat as separate features** (one folder each; report a suggested order at the end).
- **Parent with subtasks**: parent is the umbrella; choose subtasks to deep-fetch (A3).

## A3: Deep-fetch subtasks (when present)
The `subtasks` array has each child's `id`, `name`, `status`, `task_type`, but an **empty `description`**. To get a subtask's body and mockups, call `clickup_get_task(subtask_id, include: ["description"])`.
Use `AskUserQuestion` (unless the input already says): **All**, **None** (list titles only), or **Specific** IDs. Recurse if a subtask has `subtasks_count > 0`.

## A4: Fetch comments
For each ingested task/subtask: `clickup_get_task_comments(task_id)`. For any comment with `reply_count > 0`, call `clickup_get_threaded_comments(comment_id)`. Capture commenter, timestamp, text. Scan comment text for `![](…)` image URLs (A5).

## A5: Download embedded images
Mockups are markdown `![](URL)` links on ClickUp's public CDN (`*.clickup-attachments.com`), **downloadable with no auth**.
1. Extract every URL containing `clickup-attachments.com` from `markdown_description` and comment text.
2. Download each:
   ```bash
   mkdir -p .buildspace/artifacts/{feature}/clickup-images
   curl -sS -o .buildspace/artifacts/{feature}/clickup-images/{source}-{n}.png "{URL}"
   ```
   Name by source: `description-1.png`, `comment-1.png`, `{subtask-slug}-1.png`.
3. `Read` each downloaded image to confirm it loaded and note what it shows.
4. If a download fails (non-200 or 0 bytes), report the URL and keep its link in the context doc.
If there are no images, note it and move on.

## A6: Set up the artifact folder
Derive a kebab-case feature name from the title (`Build UI for PIN Code TAT check` becomes `pin-code-tat`).
```bash
mkdir -p .buildspace/artifacts/{feature}/clickup-images
echo "{feature}" > .buildspace/current-feature
```
`Glob('.buildspace/artifacts/*/clickup-context.md')`. If the name exists, confirm before overwriting. For batch mode, repeat per task and don't set `current-feature` until the user picks the starting task.

## A7: Write clickup-context.md
Read `${CLAUDE_SKILL_DIR}/templates/clickup-context-template.md` and fill it with the real data. Write to `.buildspace/artifacts/{feature}/clickup-context.md`. One block per source task; for a parent, parent first then a block per deep-fetched subtask. Reference downloaded images by path. Omit empty rows and never invent values.

## A8: Classify and route
`task_type == "Bug"` is a bug; otherwise it's a feature; if ambiguous, ask. Then:

**Feature:** `→ Run /clarify (it reads clickup-context.md automatically). Then /plan → /execute → /assess`
**Bug:** `→ Run /fix (it reads clickup-context.md automatically). Then /assess`
**Batch:** list each folder and a suggested order; note `current-feature` is unset until they choose.

Give only a 1-2 line summary per task in conversation. The artifact is the source of truth.

---

# PART B: Action mode (writes to ClickUp)

These actions change a **shared** task others can see. Always follow this order: draft, then confirm with `AskUserQuestion`, then write. Never write without explicit confirmation. Do each requested action in order, each with its own confirmation.

## Add a comment / reply
1. Extract the comment text (usually quoted).
2. **Mentions / notifications:** a literal `@Name` in the text posts as plain text and does **not** create a real ClickUp mention or notify that person. If the user wants to notify someone, resolve them with `clickup_resolve_assignees` and either set `notify_all: true` or the comment `assignee`. Tell the user which you'll use.
3. **Missing references:** if the comment mentions something you don't have (for example "here is the link" but no URL was given), ask for it, or offer to pull it from the feature's artifacts (preview/PR URL in `execution-log.md`). **Never invent a link.**
4. Show the final comment text, target task, and notify setting, then confirm.
5. `clickup_create_comment(comment_text, entity_type: "task", entity_id: task_id, notify_all?, assignee?)`. For a threaded reply, set `reply_to_id`.

## Change status / assign / priority
1. Call `clickup_get_task(task_id, expand_statuses: true)` to get the valid statuses for that list.
2. Map the requested status to a valid value (for example "QA" to `qa`, "done" to `complete`). If it matches none, show the valid options and ask.
3. For assignees, resolve names/emails/"me" via `clickup_resolve_assignees` first.
4. Confirm the change (old to new), then `clickup_update_task(task_id, status: "...", assignees?, priority?)`.

## Log / track time
- **Live timer:** "start timer" calls `clickup_start_time_tracking(task_id)`; "stop timer" calls `clickup_stop_time_tracking()`. Only one timer runs at a time. No timestamps needed, so this is preferred for real-time work.
- **Manual entry:** `clickup_add_time_entry(task_id, start, duration | end_time)`. `start`/`end_time` must be `YYYY-MM-DD HH:MM`. You do **not** reliably know the current clock time, so if the user gives only a duration ("log 2h"), ask for the start time (or start+end). Never guess a timestamp.
- Confirm the entry before writing.

---

## Rules
- Two modes: detect ingest vs action from the input; ask if ambiguous
- Ingest writes only local artifacts; Action writes to the shared ClickUp task, so Action always confirms first
- Never write theme code; this skill only bridges ClickUp
- Never guess task content, links, statuses, or timestamps; use the API or ask
- Always use `markdown_description` (has image links), never `text_content`
- Subtask list view has empty descriptions, so deep-fetch a subtask by ID for its body
- ClickUp attachment URLs are public; download with plain `curl`, no token
- A literal `@Name` is not a real mention; resolve plus notify_all/assignee to actually notify
- Route ingested bugs to /fix and features to /clarify
