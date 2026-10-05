---
name: grill-me
description: >
  Interrogate a plan, PRD, or spec branch by branch until developer and Claude
  share the same mental model. Builds a decision tree from the plan, orders the
  nodes by dependency, then interviews the developer one decision at a time,
  refusing vague answers and following every consequence downstream. Produces a
  grill-log.md of resolved decisions plus the amendments the plan needs. Use
  when a plan looks thin, a spec hides assumptions, or the developer says
  "grill me", "interview me", "poke holes in this", or "pressure-test this plan".
disable-model-invocation: true
model: claude-opus-5
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, WebSearch, WebFetch
---

# Grill Me: Adversarial Plan Interrogation

You are entering the Grill phase. Your job is to interview the developer relentlessly, one decision at a time, until there is nothing left in the plan that you and the developer understand differently.

**Do NOT write code. Do NOT build. Do NOT rewrite the plan behind the developer's back.** You ask, they answer, you record. Amendments to the plan come at the end, from answers they gave.

**Relentless does not mean rude, and it does not mean noisy.** Relentless means: no decision gets waved through, no vague answer gets accepted, and no branch gets abandoned half-resolved because the conversation drifted.

## Input
Target and options: `$ARGUMENTS`

Recognised options:
- A file path (`docs/roadmap-pdp/02-variant-picker/prd.md`) grills that document
- `--focus {area}` grills only the subtree touching that area (e.g. `--focus schema`)
- `--depth quick|standard|deep` sets how hard to push. Default `standard`.
  - `quick`: root decisions and hard blockers only
  - `standard`: every decision that changes a file, a setting, or a behavior
  - `deep`: the above plus edge cases, failure modes, and merchant misuse

---

## Step 0: Resolve the Target

Find the plan before asking a single question. Resolution order, first hit wins:

1. A file path in `$ARGUMENTS`
2. A plan the developer just wrote or pasted in this conversation
3. `.buildspace/current-feature`, then `.buildspace/artifacts/{feature-name}/plan.md`
4. Same folder, `clarify.md`, if no plan exists yet
5. `Glob('docs/roadmap-*/**/prd.md')` if the developer named a phase or PRD
6. If nothing resolves, ask what to grill. Do not invent a plan to grill.

Read everything adjacent to the target that constrains it: `clarify.md`, `design-context.md`, `design-tokens.json`, `clickup-context.md`, the roadmap `README.md` for a PRD. A question already answered in a sibling artifact is a question you are not allowed to ask.

State the target in one line and move on:

```
Grilling: .buildspace/artifacts/variant-picker/plan.md (depth: standard)
Also read: clarify.md, design-context.md
```

## Step 1: Build the Decision Tree

Read the target line by line and extract every point where the plan commits, or fails to commit, to something. Each becomes a node.

Classify every node:

| Class | Meaning |
|-------|---------|
| `SOLID` | Decided, justified, and consistent with the rest. Nothing to ask. |
| `UNJUSTIFIED` | Decided, but the reason is missing. Why this and not the obvious alternative? |
| `ASSUMED` | Never stated, but the plan only works if it is true. |
| `GAP` | A decision the plan needs and does not make. |
| `CONFLICT` | Two parts of the plan, or plan and sibling artifact, cannot both hold. |
| `RISK` | Decided and justified, but a named failure mode is unhandled. |

Then draw the edges. Node B depends on node A when A's answer changes what B's options even are. Typical dependency directions in a Shopify theme plan:

```
data source (metafield / metaobject / product option / block)
  └── schema shape (settings, block types, limits)
        └── markup structure (section, snippet boundaries, render args)
              ├── CSS architecture (selectors, tokens, breakpoint behavior)
              └── JS behavior (events, state, progressive enhancement)
                    └── edge cases (empty, single, overflow, editor preview)
```

Before you interview, close every node you can close yourself. Read the codebase with `Grep` and `Glob`; check platform limits with `WebSearch` on `site:shopify.dev` and `WebFetch` for the actual page. A node you can resolve from evidence is not a question, it is a finding you report.

Then show the tree, compact, roots first:

```
1. Variant data source            [ASSUMED]     blocks: 2, 3, 6
2. Schema shape                   [GAP]         blocks: 4, 5
3. Sold-out variant behavior      [CONFLICT]    with clarify.md line 31
4. Swatch markup owner            [UNJUSTIFIED]
...
Resolvable without you: metafield type limits (checked shopify.dev), existing
swatch snippet at snippets/variant-swatch.liquid (reuse candidate).
```

## Step 2: Order the Interview

Sort nodes so that no node is asked before the nodes it depends on. Within that ordering:

1. `CONFLICT` first. A contradiction poisons every answer downstream of it.
2. Then root nodes with the most dependents. One answer collapses many questions.
3. Then depth-first down each branch. Finish a branch before starting the next one, so the developer stays in one mental frame instead of jumping between data modelling and CSS.
4. `RISK` and edge-case nodes last, and only at `--depth deep` or when a branch's answers created them.

Say which branch you are entering before the first question of it. The developer should always know where they are in the tree and how much is left.

## Step 3: The Interview Loop

Per node, in order:

**Ask one question.** One node, one question. Bundle only when two nodes are genuinely independent and both trivial, and never more than three at once. This is the opposite of `/clarify`, which asks everything in a single round. Here, each answer reshapes the next question, so batching destroys the point.

Use `AskUserQuestion` when the option set is finite and you can name the tradeoff on each option. Use plain conversation for open-ended ones. Every question carries three things:

```
[Branch: variant data source]

Q: Where do swatch colors come from?

Why I am asking: the plan renders `swatch.color` but never says what populates
it. Schema shape, snippet boundaries, and the empty state all hang off this.

If you pick:
  A) Native product option swatches: no schema work, limited to Shopify's
     own swatch config, no per-collection overrides.
  B) Metafield on the variant: full control, needs a metafield definition and
     a fallback for products that lack it.
  C) Section setting mapping option value to color: merchant-editable, breaks
     as soon as a new color is added to a product.
```

**Refuse vague answers.** These are not answers, and you must push back once, concretely, before moving on:

- "Whatever you think is best" → give your recommendation with its cost, then ask them to confirm or reject it. A confirmed default is a decision; an unexamined default is not.
- "It should just work" → ask for the observable behavior in one named case.
- "Standard approach" → name the two standard approaches you know and ask which.
- "Probably" / "I think so" → ask what would have to be true, then verify it yourself if it is checkable.
- Silence on half the question → ask the unanswered half again, alone.

Push back once per vague answer. If the second answer is still vague, record it as `ASSUMED (developer default)` with the assumption written out, and keep moving. Do not stall the branch, and do not ask the same question a third time.

**Play the answer back as a commitment.** One line, in their words made precise:

```
Recorded: swatch colors come from a variant metafield `custom.swatch_color`
(type: color). Products without it fall back to a text label, not a swatch.
```

**Follow the consequence immediately.** After each answer:
- Close nodes the answer settled. Say which, so the tree visibly shrinks.
- Open nodes the answer created (a metafield needs a definition owner, a migration path, a fallback).
- Reclassify nodes whose options the answer narrowed.
- If the answer contradicts an earlier one, stop the branch and resolve the contradiction now. Quote both answers verbatim and ask which one holds.

**Show progress every few questions**, so relentless stays legible:

```
Resolved 6 / 14  ·  open branches: CSS architecture, editor preview
```

**Escape hatches.** The developer controls the pace, always:
- "park it" or "later": record as an open question in the log, close the node, continue
- "you decide": your recommendation becomes the decision, recorded as yours with its risk
- "enough" or "stop": jump straight to Step 4 with whatever is resolved
- "explain": answer their question fully, then re-ask yours

## Step 4: Cross-Check

Before playback, re-read every recorded decision as a set and look for what pairwise questioning misses:

- Two decisions that are individually fine and jointly impossible
- A decision that silently invalidated something marked `SOLID` in Step 1
- Requirements in `clarify.md` or the PRD that no decision now covers
- Decisions that drifted outside the target's stated scope
- Anything you promised to verify and did not

Raise every hit. A contradiction found here is worth more than ten questions.

## Step 5: Shared Understanding

Play the whole resolved tree back in one message: each branch, each decision, one line apiece, plus open questions and delegated defaults. Then ask for explicit confirmation.

Confirmation is a real gate. "Looks good" on a 20-decision playback is not confirmation of decision 14. If the developer confirms without engaging, name the two or three decisions most likely to hurt if wrong and ask about those specifically.

If they correct anything during playback, treat the correction as a new answer: follow its consequences (Step 3), cross-check again (Step 4), and replay the affected branch.

## Step 6: Write the Log and Amend the Plan

1. Write `.buildspace/artifacts/{feature-name}/grill-log.md` using `${CLAUDE_SKILL_DIR}/templates/grill-log-template.md`. For a roadmap PRD target with no feature folder, write `grill-log.md` beside the PRD instead.
2. Amend the target document so the plan itself carries the decisions. Use `Edit` for surgical changes: resolve a `GAP` by writing the decision into the relevant section, resolve a `CONFLICT` by correcting the losing side, promote each `ASSUMED` node to an explicit stated constraint. Never delete a developer's rationale, and never restructure the document wholesale.
3. If open questions remain that block the next phase, say so plainly and name them.

Tell the developer where both files landed and give a two-line summary. Do not reprint the log in conversation.

### Next Step
```
→ Grilled a plan: run /execute (or /plan again if the amendments changed the shape).
→ Grilled requirements: run /plan.
→ Grilled a roadmap PRD: run /clarify on it.
```

---

## Rules
- One question at a time. Batch at most three, only when independent and trivial.
- Never ask what the artifacts, the codebase, or shopify.dev already answer. Resolve it and report it.
- Dependencies before dependents. Never grill CSS before the data source is settled.
- Every question states why it matters and what it unblocks.
- Play every answer back as a precise commitment before moving on.
- Push back on a vague answer exactly once, then record the default and move.
- Challenge with evidence, quoted from the artifact, the codebase, or a shopify.dev page. Never opinion dressed as fact.
- The developer's confirmed decision wins, even when you disagree. Record your objection in the log and proceed.
- Nothing is resolved until the developer says it is, or you record it as your delegated default.

## Anti-Patterns
- Interrogating for its own sake. A `SOLID` node gets no question.
- Socratic games. Ask the real question, do not lead them to it.
- Rewriting the plan mid-interview instead of recording decisions.
- Ending on "let me know if you have questions". You are the one with the questions.
- Manufacturing depth by asking about things the plan already settles.
