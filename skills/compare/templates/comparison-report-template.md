# Comparison Report: {Feature Name}

**Iteration:** {1 or 2}
**Date:** {timestamp}
**Preview URL:** {url}
**Diff threshold:** {threshold}% (from capture-manifest.json)

## Summary
- Sections compared: {count}
- Desktop: {pass}/{total} MATCH, {minor}/{total} MINOR, {mismatch}/{total} MISMATCH
- Mobile: {pass}/{total} MATCH, {minor}/{total} MINOR, {mismatch}/{total} MISMATCH
- Auto-passed without image review: {count} of {total}
- **Overall Verdict:** PASS / NEEDS FIX

## Section: {Section Name}

### Desktop
- **Verdict:** MATCH / MINOR / MISMATCH
- **Measured:** code {w}x{h} vs figma {w}x{h} (delta {dw}, {dh}) · pixel diff {pct}%
- **Figma:** `screenshots/figma-{section}-desktop.png`
- **Code:** `screenshots/code-{section}-desktop.png`
- **Diff:** `screenshots/diff-{section}-desktop.png` (only when one was generated)
- **Notes:** {What matches well, what deviates. "Auto-passed" if the manifest cleared it.}

### Mobile
- **Verdict:** MATCH / MINOR / MISMATCH
- **Measured:** code {w}x{h} vs figma {w}x{h} (delta {dw}, {dh}) · pixel diff {pct}%
- **Figma:** `screenshots/figma-{section}-mobile.png`
- **Code:** `screenshots/code-{section}-mobile.png`
- **Diff:** `screenshots/diff-{section}-mobile.png` (only when one was generated)
- **Notes:** {What matches well, what deviates. "Auto-passed" if the manifest cleared it.}

### Issues (if MISMATCH)
1. {Specific issue: what's wrong, where in the section, what it should look like}
2. {Specific issue}

[Repeat for each section]
