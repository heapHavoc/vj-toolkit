# Plan: {Feature Name}

**Complexity:** Low / Medium / High
**Files to create:** [count]
**Files to modify:** [count]

## Approach
[2-3 sentences: WHY this approach was chosen. Reference codebase patterns
discovered during analysis. If alternatives were considered, explain why
this one won.]

## Codebase Context
[Key findings from codebase-analyzer that influence decisions:]
- Naming: [convention found]
- Schema IDs: [pattern found, e.g., prefixed with section name]
- CSS: [scoping approach, responsive strategy]
- Reusable: [snippets/patterns to reuse]
- Conflicts: [potential issues to avoid]

## File Specs

### {file-path} (create / modify)

**Figma:** {sections.json name} · Dumps: `figma-dumps/...` · Wrapper selector: `{[data-section-x] / .section-class}` (or "no Figma source")

**Design values:** (per Figma frame width)
| Element | Property | {mobile width}px | {desktop width}px | Token / class |
|---------|----------|------------------|-------------------|---------------|
| {title} | font-size / line-height | {28/34} | {40/48} | {text-h2 md:text-h1} |

**Settings:**
| ID | Type | Label | Group |
|----|------|-------|-------|
| {section_setting_id} | {type} | {Label} | {Content/Style/Advanced} |

**Blocks:** (if applicable)
| Block Type | Block Name | Settings |
|------------|-----------|----------|
| {type} | {Name} | {list of settings with types} |

**CSS:** {asset-file-path}
- Loading: {preload / lazy}
- Classes: {.section-name, .section-name__element, ...}
- Tokens: {--token-name (purpose), ...}

**JS:** {asset-file-path or "none"}
- Pattern: {none / DOMContentLoaded / Web Component}
- Purpose: {what the JS does, if applicable}

**Null checks:** {setting-id (behavior when blank), ...}

**Reuse:** {existing snippets or patterns to use}

**Interactions:** {from Figma prototype / behaviour / clarify — e.g. "carousel: drag + arrows, 4th card peeks at 1440" — or "none"}

[Repeat for each file]

### {template-file-path} (modify)
[What to add/change in the template JSON]

## Deviations from Figma
[Every intentional difference from the design, with the reason. /figma-verify treats these as decided.]
| Section | Width | Figma | Build | Reason |
|---------|-------|-------|-------|--------|
| {name} | {390} | {what Figma shows} | {what we build} | {clarify decision / out of scope / Figma contradiction resolved by user} |

Or "None".

## TODO Steps
[Ordered list. Each TODO = one file. References the File Spec above.]
- [ ] TODO 1: Create {file-path} — see File Spec
  - Files: {file-path}
- [ ] TODO 2: Create {file-path} — see File Spec
  - Files: {file-path}
- [ ] TODO 3: Modify {template-path} — add section reference
  - Files: {file-path}

## Test Cases
[What /test should verify. Derived from requirements acceptance criteria + implementation decisions.]

### Functional
- [ ] [Test case from requirements]
- [ ] [Test case]

### Edge Cases
- [ ] [Empty state handling]
- [ ] [Max content handling]
- [ ] [Missing media handling]

### Responsive
- [ ] [Exact match at each Figma frame width, e.g. 402px and 1440px]
- [ ] [No overflow or clipped text at other widths: 320–2560px]

### Interactions
- [ ] [Each interaction from the File Specs, with the expected result]

### Theme Editor
- [ ] [Settings appear correctly]
- [ ] [Live preview updates on setting change]
- [ ] [Section addable via "Add section" if preset exists]

## Risks
[Anything that could go wrong, or "None identified"]
