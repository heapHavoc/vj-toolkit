# /clickup Usage Guide

A two-way bridge between ClickUp and the theme pipeline. Use it to **pull a task's full context in** (so you can build/fix from it) or to **push updates back** (comment, status, time).

> Invoked as `/shopify-theme-toolkit:clickup` (or `/clickup` if there's no name clash).

---

## Prerequisites

- **ClickUp connected as an MCP server.** The simplest route is the claude.ai ClickUp integration (Settings, then Connectors). No self-hosted server needed.
- Check with `/mcp`. ClickUp should show as connected. If not, the skill tells you how to connect.
- Nothing to install per-project; the connection is account-level.

---

## Two modes (auto-detected)

The skill reads what you type and picks the mode:

| You give it | Mode | What happens |
|---|---|---|
| A task **ID or URL** | **Ingest** | Pulls context, writes an artifact, routes to `/clarify` or `/fix` |
| An **instruction** ("add comment...", "mark as...", "log time...") | **Action** | Performs the ClickUp write, after showing you a draft and confirming |

If it's ambiguous, it asks.

---

## Ingest mode: start work from a task

Pull a task's title, description, mockup images, comments, custom fields, and subtasks into `.buildspace/artifacts/{feature}/`, then hand off to the right pipeline step.

**Single task (any of these forms):**
```
/clickup 86d3gp26j
/clickup DEV-1234
/clickup https://app.clickup.com/t/86d3gp26j
/clickup
Clickup ID: 86d3gp26j
```

**Multiple tasks.** It asks whether to *merge into one feature* or *treat as separate features*:
```
/clickup 86d3gp26j, 86d3c625r
```

**A parent with subtasks.** It asks which subtasks to deep-fetch (All / None / specific IDs), because the subtask list alone has empty descriptions:
```
/clickup 86d3c625r
```

**What you get:**
- `.buildspace/artifacts/{feature}/clickup-context.md`: structured task context (source of truth)
- `.buildspace/artifacts/{feature}/clickup-images/`: downloaded mockups
- `.buildspace/current-feature`: set so the rest of the pipeline knows the active feature

**Where it routes:**
- Task type **Bug** goes to `/fix` (which auto-reads `clickup-context.md`), then `/assess`
- Otherwise (feature) goes to `/clarify`, then `/plan`, `/execute`, `/assess`

So a typical feature run:
```
/clickup 86d3gp26j      # ingests, routes to /clarify
/clarify                # reads clickup-context.md automatically
/plan
/execute
/assess
```

And a bug:
```
/clickup 86d3dmnbp      # ingests a Bug, routes to /fix
/fix                    # reads clickup-context.md automatically
/assess
```

A bug bucket (parent with N bug subtasks): ingest in batch, then run `/fix` once per bug.

---

## Action mode: update a task

All actions are drafted, shown to you, and **confirmed before anything is written** to the shared task.

**Add a comment:**
```
/clickup Add comment to 86d3gp26j - "Build is done on staging, ready for QA."
```

**Comment that should notify someone:**
```
/clickup Comment on 86d3gp26j and notify Rahul - "QA can start, preview: <link>"
```
- A literal `@Rahul` is just text. It does **not** ping him. To actually notify, the skill resolves the person and uses `notify_all` / assigns the comment. It confirms which.
- If you reference "the link" but don't supply a URL, it asks (or offers to pull the preview/PR URL from `execution-log.md`). It won't invent one.

**Change status:**
```
/clickup Mark 86d3gp26j as QA
/clickup Move DEV-1234 to complete
```
The skill first reads the list's **valid** statuses and maps yours to one. If it doesn't match, it shows the options.

**Log / track time:**
```
/clickup Start timer on 86d3gp26j        # live timer (start)
/clickup Stop timer                      # live timer (stop)
/clickup Log 2h on 86d3gp26j starting 2026-06-30 09:30   # manual entry
```
- Live timer needs no timestamps, so it's preferred for real-time work (only one timer runs at a time).
- A manual entry needs a start time (`YYYY-MM-DD HH:MM`). If you give only a duration, it asks for the start. It won't guess the clock.

---

## Good to know

- **Mockup images are public.** ClickUp embeds them as CDN links the skill downloads with plain `curl` (no token needed), then views them to confirm they loaded.
- **`markdown_description` vs `text_content`.** The skill always reads `markdown_description` because `text_content` strips out image links.
- **Subtask bodies.** A parent's subtask list returns names/status only; the skill deep-fetches each chosen subtask by ID to get its description and mockups.
- **Re-running** for the same feature name asks before overwriting the artifact.
- **Headless/CI:** the claude.ai ClickUp integration is interactively authenticated, so it may be unavailable in fully headless runs (cron/CI). Fine for normal interactive use.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "ClickUp MCP server not connected" | Connect ClickUp in your Claude integrations, then re-run |
| Permission prompt on each ClickUp call | Your server is connected under a different name than `claude_ai_ClickUp`; approve once (the skill still works) |
| Status change rejected | The status isn't valid for that list; the skill shows the valid set, pick one |
| Comment didn't notify the person | Use "notify <name>" so the skill sets `notify_all`/assignee; a plain `@name` is only text |
