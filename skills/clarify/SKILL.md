---
name: clarify
description: >
  Define requirements clearly before planning or building. Extracts what needs
  to be done, researches Shopify capabilities, challenges user if needed,
  asks clarifying questions. Use as the first step for feature development.
disable-model-invocation: true
model: claude-opus-5
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, WebSearch, WebFetch
---

# Clarify — Requirements Definition

You are entering the Clarify phase. Your job is to make "what needs to be done" crystal clear so /plan has zero ambiguity.

**Do NOT write code. Do NOT plan implementation. Do NOT suggest technical approaches. Only extract, research, challenge, and confirm requirements.**

**Do NOT assume anything. Do NOT hallucinate. If you don't know, research or ask.**

## Input
The request: `$ARGUMENTS`

## Artifact Setup
1. Derive a short kebab-case feature name from the request (e.g., `hero-banner`, `product-filtering`, `cart-drawer`). If `.buildspace/current-feature` already names a feature (e.g. `/clickup` ran first), use that name instead of deriving a new one.
2. Use `Glob('.buildspace/artifacts/*/clarify.md')` to check for existing features
3. Create `.buildspace/artifacts/{feature-name}/` if it doesn't exist
4. **Save the feature name** to `.buildspace/current-feature` — this tracks the active feature across the pipeline so subsequent skills (/plan, /execute, /assess, /fix, /compare) know which feature to work on without asking.
5. If `design-tokens.json` exists, read it for available tokens
6. If `design-context.md` exists, read it for design specifications
7. If `clickup-context.md` exists, read it. It holds the originating ClickUp task (title, description, mockups in `clickup-images/`, comments). Treat it as the primary statement of the request, and view the mockups with `Read` to inform requirements.

---

## Process

### Step 1: Understand the Request
Read the user's input carefully.

Separate what you read into:
- **Clear requirements** — explicitly stated, no ambiguity
- **Implied requirements** — not said but obviously needed (e.g., a section always needs to work in theme editor)
- **Ambiguous areas** — things that could go multiple ways
- **Missing information** — things you need answered to proceed

### Step 2: Research
Before asking the user anything, research what you're uncertain about.

**When to research:**
- The request involves Shopify features or APIs you're not confident about
- The request involves platform capabilities that might have limitations
- The request describes a pattern you haven't seen before
- Something about the request seems like it might not be possible on Shopify

**How to research:**
1. Use `WebSearch` to search shopify.dev specifically (prefix queries with `site:shopify.dev`)
2. Use `WebFetch` to read the full documentation page — not just search snippets
3. Cross-reference with the project codebase using `Glob` and `Grep` to check if similar features already exist

**What you're looking for:**
- Does Shopify support what the user is asking for?
- Are there platform limitations that affect the requirements?
- Are there official recommended approaches for this feature?
- Are there known gotchas or constraints?

If research reveals that something the user wants is NOT possible or has significant limitations, you MUST flag it in Step 3.

**When NOT to research:**
- The request is straightforward and you're confident about Shopify's capabilities
- Similar features already exist in the codebase (check with Glob/Grep first)
- The feature doesn't involve any Shopify-specific APIs or platform behavior

### Step 3: Challenge the User (if needed)
If your research found issues, push back with evidence:

- **"You asked for X, but Shopify doesn't support that."** — Provide the shopify.dev source. Suggest an alternative that achieves the same goal within platform constraints.

- **"This approach has a known limitation."** — Explain what the limitation is, how it would affect the feature, and whether it matters for this use case.

- **"A better approach might be Y."** — Only if you have evidence. Explain WHY it's better (performance, reliability, maintainability). Not opinion — evidence.

- **"This already exists in your codebase."** — If Grep/Glob found a similar feature, point it out. Ask if the user wants to extend the existing one or build new.

Do NOT challenge without evidence. Do NOT challenge for the sake of challenging. If the request is solid, say so and move on.

### Step 4: Ask Clarifying Questions
Present your understanding back to the user. Ask everything in ONE round — not drip-fed questions across multiple messages.

For each ambiguous area, ask a specific question. Use `AskUserQuestion` with structured choices when there's a small set of clear options. Use conversation for open-ended questions.

```
## Here's What I Understand

[Restate the task in your own words — what is the end goal?]

**Feature name:** `{feature-name}`

## What's Clear
- [Requirement 1]
- [Requirement 2]

## What I Found During Research
- [Research finding 1 — if applicable]
- [Platform limitation — if found]

## What I'm Assuming (confirm or correct)
- [Assumption 1]
- [Assumption 2]

## What I Need to Know
1. [Specific question with context for why you need it]
2. [Specific question]
```

If the request is already crystal clear and research confirmed it's fully feasible, skip the questions and produce the requirements document directly. Tell the user it was clear — don't manufacture ambiguity.

### Step 5: Save the Requirements
Once the user confirms (or if the request was clear from the start), write the requirements to `.buildspace/artifacts/{feature-name}/clarify.md`.

Read the template structure from `${CLAUDE_SKILL_DIR}/templates/clarify-template.md` and fill it in with the feature's requirements.

### Step 6: Hand Off
Tell the user:
- Where the requirements were saved
- A 1-2 line summary

**Do NOT output the full requirements in conversation. The artifact file is the source of truth.**

### Next Step
Tell the user:
```
→ Run /plan to create the technical specification.
  Remaining: /plan → /execute → /compare (if built from Figma) → /assess
```

**Context tip:** If your conversation is getting long, you can `/clear` before running `/plan` — it reads from artifacts, not conversation history.

---

## Rules
- Research before asking questions — so your questions are informed
- Challenge with evidence only — never opinion
- One round of questions — ask everything at once, not drip-fed
- If design context exists, use it
- If similar code exists in the codebase, point it out
