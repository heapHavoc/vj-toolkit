# Grill Log: {Feature or PRD Name}

**Target:** [path to the plan / PRD / spec that was grilled]
**Also read:** [sibling artifacts that constrained the interview]
**Depth:** quick | standard | deep
**Date:** [YYYY-MM-DD]
**Verdict:** Shared understanding reached | Reached with open questions | Stopped early

## Decision Tree

One line per node, roots first, indented by dependency.

| # | Decision | Depends on | Entered as | Status |
|---|----------|-----------|------------|--------|
| 1 | [Variant data source] | - | ASSUMED | Resolved |
| 2 | [Schema shape] | 1 | GAP | Resolved |
| 3 | [Sold-out behavior] | 1 | CONFLICT | Resolved |
| 4 | [Swatch markup owner] | 2 | UNJUSTIFIED | Open |

## Resolved Decisions

### {Branch name}

**{Decision}**
- **Committed to:** [the decision, precise, in one or two lines]
- **Rejected:** [the alternatives and the one-line reason each lost]
- **Because:** [the developer's rationale, or "delegated to Claude" with the rationale]
- **Consequences:** [what this forces elsewhere: files, settings, fallbacks, migrations]

[Repeat per decision, grouped by branch.]

## Assumptions Now Explicit

Things the plan relied on silently and now states outright.

- [Assumption 1, and what breaks if it is false]
- [Assumption 2]

## Contradictions Found and Resolved

- **[Conflict]:** [what said A, what said B] → [which one holds, and why]

## Delegated Defaults

Decisions Claude made because the developer delegated them. Each is a live risk until reviewed.

- [Decision] → [Claude's choice] → [risk if wrong]

## Open Questions

Parked deliberately. Blocking ones are marked.

- [ ] **BLOCKING** [Question, and what phase it blocks]
- [ ] [Question, and when it needs answering]

## Objections on Record

Where Claude disagreed and the developer's decision stood.

- [Decision] → [the objection, and the evidence behind it]

## Amendments Made to the Target

- [`path:section`] [what changed and which decision drove it]

## Still Unclear After Grilling

Anything Claude cannot claim shared understanding of. Empty is the goal.

- [Item]
