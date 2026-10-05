# Assessment Report: {Feature Name}

## Automated Checks
- **Theme Check:** PASS / FAIL (details)
- **Schema Validation:** PASS / FAIL (details)

## Requirements Coverage
<!-- For each requirement from clarify.md -->
- [ ] {Requirement} — **Met** / **Partially Met** / **Not Implemented**
  {How it's implemented or what's missing}

### Test Cases (if plan exists)
- [ ] {Test case} — **Pass** / **Fail** {reason}

### Edge Cases
- {Edge case not handled: description, impact}

## Standards Compliance

### Critical Issues (must fix)
<!-- Breaks standards, will cause problems -->
- **File:** {path}
  **Issue:** {what's wrong}
  **Standard:** {which skill and rule it violates}
  **Why it matters:** {production impact}

### Should Fix
<!-- Improves quality noticeably -->
- **File:** {path}
  **Issue:** {what's wrong}
  **Impact:** {why this matters}

### Observations (non-blocking)
- {suggestion with brief explanation}

## Cross-File Concerns
- {Unused snippets / CSS conflicts / Schema ID collisions / Orphaned assets}

## Integration
- **Template registration:** {registered / not registered}
- **CSS loading:** {loaded / not loaded}
- **Snippet wiring:** {all correct / issues}
- **Asset files:** {all exist / missing}

## First-Principles Findings
- {Any concerns from first-principles thinking}

## Verdict
**PASS** — Ready to ship (zero critical issues, all requirements met)
**NEEDS WORK** — {count} critical issues, {count} requirements partially/not met

## Root Cause Summary (if NEEDS WORK)
<!-- For each critical issue: explain the root cause from first principles.
Not "line 42 has a bug" but "the schema structure doesn't account for X because Y."
This is what /fix needs to understand to make a proper repair, not a patch. -->
