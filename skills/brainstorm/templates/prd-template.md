# PRD: {phase-number} — {phase-name}

**Phase:** {full-path-in-tree}
**Priority:** {P0 / P1 / P2}
**Depends on:** {list of phase numbers with titles, or "None — can start immediately"}
**Estimated scope:** {Small (1-3 files) / Medium (4-7 files) / Large (8+ files)}

## Design Reference

<!-- Include this section ONLY when a Figma design exists for this phase. Omit entirely otherwise. -->

- **Desktop:** {Figma URL for the desktop frame}
- **Mobile:** {Figma URL for the mobile frame, or "Same file as desktop"}
- **Frames:** {Which sections/frames in the Figma file correspond to this phase}

> Run `/figma` with these URLs before running `/clarify` for this PRD.

## Context

{2-4 sentences. What state the project is in when a developer picks this up.
What was built in prior phases that this builds on. Reference prior phase paths
explicitly, e.g., "After completing 1.1 (docs/roadmap-{track}/phase-1-foundation/1.1-project-setup.md),
the base project structure and dependencies are in place."}

## Goal

{1-2 sentences. What this phase achieves when done. Written as a deliverable,
not a process. "A working user registration flow with email verification"
not "Implement user registration."}

## Requirements

### Functional
- {Specific, testable behavior}
- {Specific, testable behavior}
- {Specific, testable behavior}

### Non-Functional
- {Performance, security, accessibility, or quality requirement — only if relevant}

## Approach

{4-8 sentences. The recommended technical approach. Specific enough that a developer
or AI pipeline knows HOW to build this — name technologies, patterns, file structures,
architectural direction. Not pseudocode — clear direction.}

## Expected Output

- {File or artifact 1 — with purpose}
- {File or artifact 2 — with purpose}

## Dependencies

### Upstream (must be done first)
- {Phase X.Y — what it provides that this phase needs}

### Downstream (unblocked by this phase)
- {Phase X.Y — what it can start once this is done}

## Constraints

- {Technical constraint relevant to this phase}
- {Platform limitation or decision from brainstorming that limits approach}

## Acceptance Criteria

- [ ] {Verifiable criterion — a developer can check this off}
- [ ] {Verifiable criterion}
- [ ] {Verifiable criterion}
- [ ] {Edge case handling criterion}
