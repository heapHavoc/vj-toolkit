---
name: brainstorm
description: >
  Brainstorm a project from a brief into a structured roadmap of phases with
  rich, self-contained PRDs. Conducts iterative back-and-forth conversation
  about approach, logic, and decomposition, then produces a
  docs/roadmap-{track}/ folder with arbitrarily nested phases. Each leaf-node PRD is detailed enough
  to hand directly to a development pipeline. Use when a developer describes
  a project idea and wants it decomposed into buildable units, or says
  "brainstorm", "break this down", "create a roadmap", "plan this project",
  or "decompose into phases".
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, WebSearch, WebFetch, Agent, TaskCreate, TaskUpdate, TaskList
---

# Brainstorm — Project Decomposition into Phases & PRDs

You are entering the Brainstorm phase. Your job is to take a project brief, think through it deeply with the developer, and decompose it into a structured roadmap of phases — each leaf node being a rich, self-contained PRD that can be handed directly to a development pipeline.

**This is the outer loop.** The developer will feed each PRD into their inner loop (clarify → plan → execute → assess → fix) one at a time. The quality of the final output depends entirely on how well you decompose and define each phase here.

**Do NOT write code. Do NOT build anything. Only brainstorm, decompose, and produce PRDs.**

## Input

The project brief: `$ARGUMENTS`

---

## Step 0: Resolve the Track

A roadmap belongs to a **track** — one TDD, one track, one folder. Tracks sit side by side under `docs/`:

```
docs/
  tdds/
    global-standards.md
    homepage-sprint.md
    pdp-sprint.md
  roadmap-homepage/
  roadmap-navigation/
  roadmap-pdp/
```

Resolve the track name in this order:

1. An explicit track in `$ARGUMENTS` (e.g. `--track pdp`)
2. Derived from the TDD filename you were handed, stripped of project prefix and document-type suffix — `amrutanjan-homepage-sprint.md` becomes `homepage`
3. Ask the developer. Do not guess.

**Everything below writes to `docs/roadmap-{track}/`.** This document abbreviates that path as `{ROADMAP}` from here on — substitute the resolved value every time.

Run `Glob('docs/roadmap-*/README.md')` to list the tracks that already exist. A track that shares its name with an existing one is a revision of that track, not a new one — see Step 1.

---

## Step 1: Absorb the Brief

1. If no arguments provided, ask the developer to describe their project.

2. Check if this track already has a roadmap:
   - `Glob('{ROADMAP}/README.md')` — if found, read it
   - Ask: "A roadmap already exists for the `{track}` track. Do you want to revise it, extend it, or start fresh?"
   - If revising/extending, read the existing structure to understand what's there
   - Never write into another track's folder, even when this track depends on its output

3. Scan the project codebase for context:
   - `Glob('package.json')`, `Glob('*.config.*')`, `Glob('README.md')` — tech stack
   - `Glob('src/**')` or similar — what's already built
   - Only scan if a codebase exists. If this is a greenfield project, skip.

4. Check for design assets:
   - If the developer mentions Figma, designs, or mockups, ask for the Figma file URL(s) upfront
   - Ask which pages/frames in the file correspond to which parts of the project
   - Track this mapping — it will be embedded in the PRDs for phases that have designs
   - Not every phase will have a design. Backend work, config, infrastructure phases won't.

5. Identify what you know and what you don't. Separate:
   - **Clear from the brief** — stated goals, constraints, tech choices
   - **Implied** — obvious requirements not explicitly mentioned
   - **Unknown** — things you need to explore before you can decompose

---

## Step 2: Research

Before brainstorming with the developer, arm yourself with informed opinions.

**When to research:**
- The project involves technologies or platforms you should understand deeply
- The brief mentions patterns or architectures worth investigating
- You need to understand what's feasible before asking about approach

**How to research:**
- Use `WebSearch` for domain-specific knowledge, common architectures, known challenges
- Use `WebFetch` to read full documentation pages, not just search snippets
- Dispatch an `Agent` for parallel research if the project spans multiple domains

**When NOT to research:**
- The brief is clear, the tech stack is familiar, and the scope is well-defined
- The project is small enough that research would be overkill

The goal is to bring something to the brainstorming — informed trade-offs, relevant constraints, common pitfalls. Not generic questions.

---

## Step 3: Brainstorm (Iterative)

This is the core of the skill. You and the developer think through the project together.

### How to brainstorm

**Open with your understanding.** Present what you know about the project scope, informed by the brief and your research. Identify 3-5 key dimensions that need exploration — these are the areas where decisions will shape the phase structure.

**Explore one dimension at a time.** Don't dump all questions at once. Pick the most foundational dimension first — the one whose answer affects everything else. Ask probing, specific questions informed by your research.

Good: "You mentioned event tracking for GA4 and Meta. GA4 uses a dataLayer push model while Meta uses a pixel-based approach — they have different initialization patterns. Should both fire from the same trigger points, or do you want independent event pipelines?"

Bad: "What are the requirements for event tracking?"

**Synthesize after each response.** After the developer answers, state back what you understood and what it implies for the project structure. Then move to the next dimension.

**Propose a draft tree after 2-3 dimensions.** Don't wait until every question is answered. Show an early phase tree so the developer can see where the conversation is heading. This makes the brainstorming concrete.

**Use `AskUserQuestion` only for concrete choices.** When there are 2-3 clear architectural options with distinct trade-offs, use structured choices. For everything else, use conversation.

### Gate 1: Approve the high-level structure

Once the major phases are identified, present the top-level tree (without sub-phase nesting) and ask for explicit approval using `AskUserQuestion`:
- **Approve this structure** — move to deepening each phase into sub-phases
- **Adjust some phases** — developer gives feedback, you revise and re-present
- **Keep brainstorming** — more dimensions to explore

This gate approves WHAT the major phases are. Do NOT move past it without approval.

---

## Step 4: Deepen the Tree

Now take each approved top-level phase and determine if it needs sub-phases.

**A phase needs sub-phases when:**
- It would produce a PRD longer than 60 lines
- It involves more than one distinct technical concern
- It has natural sequential stages that should be verified independently

**A phase is a leaf node when:**
- It can be described in a single 40-60 line PRD
- It has a clear single responsibility
- A developer could pick it up without needing to "decide where to start"

Apply this recursively. Sub-phases can have their own sub-phases if needed.

### Gate 2: Approve the full tree with nesting

Present the complete tree — all phases, sub-phases, and leaf nodes — to the developer. This gate approves the FULL decomposition, including nesting depth and what each leaf node covers. Do NOT proceed to execution order or PRD generation without approval.

**For small projects (5 or fewer leaf PRDs):** Skip nesting. Use a flat structure — just numbered PRDs directly under `{ROADMAP}/`.

**For large projects (20+ leaf PRDs):** Suggest grouping into major tracks (e.g., "Backend", "Frontend", "Infrastructure") as top-level phases. Each track gets its own sub-phases.

---

## Step 5: Execution Order & Dependencies

For each leaf node, determine:
- **What must be done before it** — upstream dependencies
- **What it unblocks** — downstream phases
- **What can run in parallel** — independent work streams

Build the execution order. Present it as a numbered sequence with parallel groups:

```
1. Phase 1.1 (no dependencies)
2. Phase 1.2 (depends on 1.1)
3. Phase 2.1 + Phase 2.2 (parallel, both depend on 1.2)
4. Phase 2.3 (depends on 2.1 and 2.2)
```

Confirm with the developer. The execution order goes into the README.md.

---

## Step 6: Generate PRDs

Once the tree, nesting, and execution order are all confirmed:

1. **Create the directory structure** before writing any files:
   ```bash
   mkdir -p {ROADMAP}/phase-1-{name} {ROADMAP}/phase-2-{name} ...
   ```
   Create all phase folders (and nested sub-phase folders) in one command.

2. Use `TaskCreate` to create one task per leaf-node PRD — gives the developer visibility into generation progress.

3. For each leaf node, in execution order:
   - Read the PRD template from `${CLAUDE_SKILL_DIR}/templates/prd-template.md`
   - Fill it in with the specific context for that leaf node
   - **Design Reference** — if this phase has a corresponding Figma design (from the mapping captured in Step 1), include the Figma URLs and frame references. If no design exists for this phase, omit the Design Reference section entirely.
   - The **Context** section is critical — it must describe what exists when this phase starts, referencing prior phases by their file paths
   - The **Approach** section must be specific — name technologies, patterns, architectural direction
   - The **Acceptance Criteria** must be verifiable — a developer can check each item off
   - Write the PRD to its correct path in `{ROADMAP}/`
   - Update the task to completed

4. For each non-leaf phase (folder with sub-phases):
   - Read the overview template from `${CLAUDE_SKILL_DIR}/templates/overview-template.md`
   - Fill in the phase purpose, sub-phase table, and shared context
   - Write to `{ROADMAP}/{phase-folder}/overview.md`

### File naming conventions

- Phase folders: `phase-{N}-{kebab-name}/` (e.g., `phase-1-foundation/`)
- Leaf PRDs: `{N.N}-{kebab-name}.md` (e.g., `1.1-project-setup.md`)
- Nested phase folders: `{N.N}-{kebab-name}/` (e.g., `1.2-auth-system/`)
- Overview files: `overview.md` (inside non-leaf phase folders)
- Phase numbering follows tree: 1, 1.1, 1.1.1, etc.

### Flat structure (small projects)

When the project has 5 or fewer leaf PRDs and no nesting:

```
docs/roadmap-{track}/
├── README.md
├── status-log.md
├── 1-{name}.md
├── 2-{name}.md
├── 3-{name}.md
```

No phase folders, no overview files.

---

## Step 7: Generate README.md

Read the README template from `${CLAUDE_SKILL_DIR}/templates/readme-template.md`.

Fill in:
- **Project name and overview** — from the brief and brainstorming
- **Phase tree** — ASCII representation of the full structure, leaf nodes marked with `[PRD]`
- **Execution order table** — numbered sequence with dependencies and parallel indicators
- **Start here pointer** — path to the first PRD in execution order

Write to `{ROADMAP}/README.md`.

---

## Step 8: Scaffold the Status Log

Read the status-log template from `${CLAUDE_SKILL_DIR}/templates/status-log-template.md` and write it to `{ROADMAP}/status-log.md`.

Fill in one `### Phase N — Name` section per phase, and one row per leaf PRD in execution order, with:

- `#` — sequential position in the execution order
- `PRD` — the PRD number and kebab slug, e.g. `2.4 shop-by-lifestyle`
- `Depends on` — upstream PRD numbers, or `—`
- `Status` — **`Not Started`** for every row at generation time
- `Date` / `Notes` — `—`

Leave the Deviations and Blocker tables empty; they fill in during execution.

**The status vocabulary is fixed**: `Not Started` / `In Progress` / `Blocked` / `Done` / `Done with deviations`. The docs board matches these exactly and renders anything else as "Not started".

This file is the delivery record for the track. Nothing in the pipeline writes to it automatically — the developer updates a row when a PRD moves.

---

## Step 9: Report to Developer

Tell the developer:
- Where the roadmap was saved (`{ROADMAP}/`)
- Count of phases and PRDs generated
- The file tree of what was created
- Path to README.md as the entry point, and that `status-log.md` starts with every PRD at `Not Started`

Then:
```
Start here: {ROADMAP}/{path-to-first-prd}

Hand each PRD to your development pipeline one at a time, following the
execution order in README.md. Each PRD is self-contained — it has full
context, requirements, approach, and acceptance criteria.

For PRDs with a Design Reference section:
  /figma [URLs from the PRD] → /clarify [PRD path] → /plan → /execute → /compare → /assess

For PRDs without a design:
  /clarify [PRD path] → /plan → /execute → /assess
```

**Do NOT output PRD contents in conversation. The files are the source of truth.**

---

## Rules

### Brainstorming
- Research before asking questions — no generic questionnaires
- Explore one dimension at a time — don't overwhelm the developer
- Synthesize after each response — state back what you understood
- Propose a draft tree early — make the conversation concrete
- Never write files during brainstorming — only after tree approval

### PRDs
- Every leaf-node PRD must be 40-60 lines. If it exceeds 60, the scope is too large — decompose further
- Every PRD must be self-contained. A developer who reads only that file should know: what to build, why, how, what exists already, and what success looks like
- The Context section must reference prior phases by their file paths
- The Approach section must be specific — name technologies, patterns, architectural direction. Not vague.
- Acceptance Criteria must be verifiable — checkboxes a developer can check off

### Structure
- Phase numbering follows the tree: 1, 1.1, 1.1.1
- All folder and file names are kebab-case
- If `{ROADMAP}/` already exists, ask before overwriting — and never write into a different track's folder
- Small projects (5 or fewer PRDs): flat structure, no nesting
- Large projects (20+ PRDs): suggest grouping into tracks
