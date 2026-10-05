# Proposal: shared learnings across toolkit skills

**Author:** Vishvam Joshi · **Status:** draft for discussion · **Not implemented**

## 1. Problem
The same mistakes repeat across features and projects because nothing the skills learn reaches the next run.

- **Toolkit today:** `/assess` appends to `.claude/patterns-learned.md`, but only on PASS and at most 3 entries per feature. **No skill reads that file back.** It is write-only.
- **Fixes are lost too:** `/fix`, `/compare` and `/figma-verify` produce root-cause analyses (`fix-log.md`) that are never turned into rules.
- **dk-toolkit:** every skill appends to one `LEARNINGS.md` (with a dedup key), and `skill-updater` then **silently edits the skill files**, appending to an "Auto-Updated Rules" section. Rules do reach the next run. But:
  - there's no review step
  - project-specific facts leak into global rules
  - it's per machine, so the team doesn't share it
  - rules only ever grow

**Example from this round:** `/figma-verify` classified a mobile-only QA fix as a desktop decision. A human caught it. Without a learning, the next run can make the same mistake.

## 2. Goals
1. A learning from any skill reaches the next run of the skills it affects.
2. Project facts stay in the project, and general rules reach the whole team.
3. Nothing changes a skill without human review.
4. Learnings stay small and current, and can be pruned.

## 3. Proposal

### 3.1 Two scopes
| Scope | Where | Example | Who reads it |
|---|---|---|---|
| **Project** | `.buildspace/learnings.md` in the theme repo (committed) | "CTA inset uses the fluid `banner-inset` token: 0 at 390, 120px at 1440" | every skill, in that project |
| **Toolkit** | a proposed rule inside the skill file, delivered as a PR to the toolkit repo | "A QA fix is scoped to the breakpoint in its bug report. Don't treat it as a decision at other widths." | every project, after review |

### 3.2 Capture: where entries come from
| Skill | Trigger |
|---|---|
| `/figma-verify` | every root cause in `fix-log.md`; every misclassification the user corrects; the answer to a new closing question, "Anything I missed?" |
| `/fix` | the RCA once the fix is approved and verified |
| `/assess` | Critical/Should Fix findings with a general root cause (not only on PASS) |
| `/compare` | MISMATCH root causes after `/fix` |
| `/preflight` | verifier false alarms, which are rule-tuning candidates |
| `/clarify`, `/plan` | decisions the user overturned later |

Entry format (one block per learning):
```
### <title>
- Key: <skill>|<area>|<symptom>        (dedup)
- Scope: project | toolkit-candidate
- Skill(s): figma-verify, plan
- Symptom: what went wrong (1 line)
- Root cause: why (1–2 lines)
- Rule: what to do next time (1–2 lines, imperative)
- Evidence: feature, file:line or commit, date
- Hits: 1                                 (incremented when it recurs)
```

Entries are only written when the filter passes: "Had I known this at the start, would it have avoided a mistake or saved time?" An existing key is updated (Hits +1), never duplicated.

### 3.3 Read-back: closing the loop
Every pipeline skill gets one line in its first step:
- read `.buildspace/learnings.md`
- apply entries whose `Skill(s)` include this skill
- treat them as project decisions with the same weight as `CLAUDE.md`

The file stays small (target under 60 entries), so this costs little.

### 3.4 Promotion: reviewed, never silent
A new user-invoked skill, `/learn`:
1. Lists `toolkit-candidate` entries, grouped by skill, most hits first.
2. For each, drafts the smallest edit to the right skill file, as a rule in that skill's own words rather than an appended "auto" section.
3. You approve, edit or reject each one.
4. Approved edits are committed to the toolkit repo and opened as a PR, so the TL reviews them like any other change. The project entry is then marked `promoted` with a link to the PR.

This replaces dk-toolkit's silent `skill-updater` with the same mechanism plus a review step.

### 3.5 Pruning
- `/learn` also flags project entries that are stale: not hit in N features, or contradicted by the code.
- Entries that `CLAUDE.md` or a skill already covers are removed.
- Promoted entries are removed from the project file.

## 4. What it improves
- **Fewer repeat defects:** each verified root cause becomes a rule the next run applies. Expected to reduce `/figma-verify` rounds and `/fix` cycles on later features of the same project.
- **Less re-explaining:** project quirks such as tokens, QA decisions and content rules stop needing a re-mention every session.
- **Team-wide improvement:** general rules reach every developer through reviewed toolkit PRs, not one machine's skill files.
- **Measurable:** compare the number of `fix-log.md` entries per feature, and `figma-verify` round-1 pass rates, before and after.

## 5. Work involved
| Change | Size |
|---|---|
| Entry format and `.buildspace/learnings.md` convention | small |
| Capture step in figma-verify, fix, assess, compare, preflight | small: one step each |
| Read-back line in every pipeline skill | small |
| `/learn` skill (list, draft edit, approve, commit/PR, prune) | medium |
| Migrate the existing `.claude/patterns-learned.md` entries | small |

## 6. Open questions
1. Should the project file be committed (shared with the team on that project) or stay local?
2. Should `/learn` open the PR to the toolkit directly, or only prepare the branch?
3. Should there be a cap per skill in the toolkit, so rules can't grow without bound?
4. Should dk-toolkit's existing `LEARNINGS.md` entries (mostly performance) be imported as toolkit candidates?

## 7. Summary
- Today the toolkit writes learnings that no skill reads. dk-toolkit reads them back but edits skills silently.
- Proposed: project learnings that every skill reads, plus toolkit rules promoted through a reviewed PR via `/learn`.
- Capture comes from figma-verify, fix, assess, compare and preflight, using one dedup'd entry format.
- Goal: fewer repeat fixes, measured by fix-log entries and figma-verify round-1 pass rate.
