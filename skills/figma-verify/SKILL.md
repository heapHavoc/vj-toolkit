---
name: figma-verify
description: >
  Verify a built Shopify feature against its Figma design and intended behaviour
  in a real browser, then fix it automatically until it matches. Runs on the
  local theme dev server with Playwright: exact match at the Figma frame widths
  (side-by-side screenshots + measured fonts/colours/spacing/positions from the
  figma-rest specs), layout health at 11 breakpoints, and interaction tests
  (accordions, sliders, hover, sticky, marquee, selected states). Writes
  verify-report.md, asks once, then loops fix → re-verify. Use after /execute
  when the feature was extracted with figma-rest, or when the user asks to
  verify/QA a built page or section against Figma.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, AskUserQuestion
---

# Figma Verify — Measure, Test, Fix

You are entering the verify phase. Prove that the built feature matches the Figma design **exactly at the Figma frame widths**, holds up at every other width, and **behaves** as designed and decided. Then fix whatever fails, re-verify, and repeat until it passes.

Scripts: `${CLAUDE_SKILL_DIR}/scripts/`. They use the project's own Playwright (`@playwright/test` or `playwright`). Never uninstall it.

## Input
`$ARGUMENTS`. This can be a feature name, a dev server URL, a route, or section names to limit the run. Everything else is resolved below.

`check-only` in `$ARGUMENTS` runs Steps 1–5 and the Step 7 report with no fix loop and no edits. `/assess` uses it to re-check the design after its own fixes.

---

## Step 1: Resolve the Feature

1. Read `.buildspace/current-feature`, or use the feature named in `$ARGUMENTS`. If several features could apply, ask.
2. Read these from `.buildspace/artifacts/{feature}/`:
   - `sections.json`: the sections, their Figma screenshots, dumps and behaviour. It must come from **figma-rest**, with `dumps` per section and a `.json` spec next to each dump. If the specs are missing, re-run the figma-rest extractor for the frames. This is free from the cache.
   - `selectors.json`: `[{ "name", "selector" }]`, with names matching `sections.json`. Optional per entry:
     - `"route"`: the page this section lives on, when it isn't `--route` (e.g. one legal page per section, `/search?q=jeans` for results)
     - `"before"`: steps (same format as `behaviour.js`) that put the section into the state Figma draws before it is captured, measured and swept: open the megamenu, the search drawer, the size guide, a filter. Use an array, or `{ "desktop": [...], "mobile": [...], "mobileBelow": 1024 }` when the steps differ by breakpoint. Add `{ "do": "waitFor", "selector": "..." }` so capture waits until the panel is visible.

     Sections with `route` or `before` get their own fresh page, so an open menu never leaks into other sections. If a `before` step fails, the section is reported as `BEFORE_FAILED`; fix the steps, not the theme.

     If `selectors.json` is missing, build it:
     - read the template and the section files from `execution-log.md`
     - pick a stable selector that wraps each section (prefer `data-*` or the section class)
     - write the file
   - `clarify.md`: your decisions. They are the source of intended behaviour wherever the design is silent.
   - `plan.md` → **Deviations from Figma**, and `execution-log.md` → **Deviations**: differences that were decided on purpose. Treat each one as a decision, never as a failure to fix.
   - `execution-log.md`: the files this feature created or changed. **Edit scope = these files plus any snippet rendered only by them.** Code is often refactored into new snippets after a feature ships. Check with `grep -rn "render '<snippet>'" sections snippets blocks templates`: a snippet rendered by an in-scope section and nothing else is in scope.
   - `figma-dumps/*-index.json`: the Figma frame widths, used as the exact-match viewports.

## Step 2: Dev Server & Route

Use the URL from `$ARGUMENTS` if given, otherwise `.buildspace/artifacts/{feature}/preview-url.txt` (shared with `/compare`) if it exists and responds. Otherwise detect it:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/detect-server.js
```
Write the URL you use to `preview-url.txt`, so `/compare` and later runs reuse it. Never store a password on disk.
- If no server is found, ask the user to start it (`npm run shopify` / `shopify theme dev`) and give them the `!` command. Don't start it yourself.
- Route: take it from `plan.md`/`clarify.md` (template + a handle with real data, e.g. `/products/<handle>`). Ask if it's unclear. For a template-specific route, add `?view=` if the plan uses an alternate template.
- If the storefront is password-protected, use `--password` (ask once, never write it to a file). The scripts unlock the store and reopen the route. To verify on the user's preview theme rather than the local server, use the store URL with `?preview_theme_id=<id>` in the route. That also avoids the dev server's CORS blocks on `type="module"` scripts.

Shared flags for every script: `--feature {feature} --url {url} --route {route} --round {n}`. Add `--sections a,b` to re-check only some sections. Write the flags out in each command. The shell is zsh, which doesn't word-split a `$FLAGS` variable.

## Step 3: Behaviour Tests

Write tests only from evidence: prototype data, dump signals, the Figma geometry (e.g. a 4th card clipped at the frame edge means the carousel is meant to peek and scroll on desktop too) and `clarify.md`. **Never from assumptions about how it "should" work.** A test that encodes an assumption will fail correct code.

Write `.buildspace/artifacts/{feature}/verify/tests.json` once (round 1). Then keep it, and extend it only if you discover new behaviour.

For every section, turn its `behaviour` (sections.json), its dump's **Behaviour signals** and the relevant `clarify.md` decisions into concrete tests:
- **scope every selector to its section** (prefix it with the section's selector from `selectors.json`). Drawers, menus and quick-add panels render hidden copies of the same components, so a bare `[data-*]` often matches an invisible element first and the test times out.
- read the section's Liquid/JS to get real selectors (prefer `data-*` hooks; `selectors.json` → `hooks` lists them when `/execute` wrote it)
- test explicit prototype interactions and states first, then inferred ones that `clarify.md` confirmed
- **never test behaviour that clarify left out of scope**

The format is documented at the top of `scripts/behaviour.js`. Typical tests:

| Behaviour | Steps → Expect |
|---|---|
| Accordion | snapshot item → click trigger → `attr open`/`aria-expanded=true`, answer `visible`, `changed height` |
| Single-open accordion | open A, open B → A `hidden`/closed |
| Slider / carousel | snapshot track → click next / `swipe` → `changed transform` or `scrollLeft`; first/last state of arrows |
| Marquee / autoplay | `moving` (no interaction) |
| Sticky / fixed | `stuck` with `scrollBy` |
| Hover state | snapshot → `hover` → `changed background-color` (or the property the Figma Hover variant changes) |
| Selected state | click option → `attr aria-checked`/class + `style` equals the Figma selected colour |
| Input | `fill` + `press Enter` → result/visible message |

Add `"screenshot": "<selector>"` for states that have a Figma variant. If needed, export that variant's Figma image with figma-rest's `save-figma-screenshots.js` (`--nodes` with the variant id from the dump's `⚡` lines) and compare the two images.

## Step 4: Verify (round n)

Run all four checks:

```bash
S=${CLAUDE_SKILL_DIR}/scripts
node $S/capture.js   --feature F --url U --route R --round N
node $S/measure.js   --feature F --url U --route R --round N
node $S/sweep.js     --feature F --url U --route R --round N
node $S/behaviour.js --feature F --url U --route R --round N
```

1. **Visual, at the Figma widths:** open every `verify/round-N/compare-{section}-{viewport}.png` (Figma | Code) with `Read`. Look for:
   - layout and structure
   - missing or extra elements
   - image crop and fit
   - icons
   - visual rhythm
   Sub-pixel anti-aliasing is not a difference.
2. **Measured, at the Figma widths** (`measure.json`). Every listed issue is a failure:
   - font family, size, weight, line height, letter spacing, colour, case, decoration
   - text position (±2px)
   - section width, height and background
   - image count and size

   **Unmatched** Figma texts aren't automatically failures:
   - if they're dynamic store data (product titles, prices, review counts), note them and move on
   - if the copy is missing or wrong, that's a failure
3. **Layout health** (`sweep.json`) at 320, 375, 390, 414, 768, 820, 1024, 1280, 1440, 1920 and 2560. These fail:
   - page overflow
   - elements outside the viewport (not inside a slider or clipped container)
   - cut-off text
   - broken images
   - console errors
   - failed asset requests

   Open the saved `sweep-*.png` for each failure.
4. **Behaviour** (`behaviour.json`): every failed check fails, and so does every test that errored. Open the state screenshots.

### Verdict per section

`PASS` only when all four checks pass for that section. There is no "minor": at the Figma widths the design must match.

## Step 5: Write verify-report.md

Write `.buildspace/artifacts/{feature}/verify-report.md`, replacing it each round and keeping the history in `verify/round-N/`:

```markdown
# Verify Report: {feature} — Round {N}

- URL: {url}{route} · Figma widths: {desktop}px / {mobile}px · Date: {timestamp}
- Result: {X}/{Y} sections PASS · Behaviour {a}/{b} · Sweep {c}/11 widths clean

## {section} — PASS | FAIL
| Check | Desktop {w}px | Mobile {w}px |
|---|---|---|
| Visual | ✓ / ✗ {what differs} | … |
| Measured | ✓ / ✗ {n} issues | … |
| Behaviour | ✓ / ✗ {failed tests} | … |
| Sweep | ✓ / ✗ {widths} | |

**Failures to fix**
1. [measured] `<h2.section__title>` font-size 28px → Figma 32px (desktop) — `sections/x.liquid` / Tailwind class
2. [behaviour] FAQ: second item does not close the first (clarify: single-open)
3. [sweep] 320px: `.cards` overflows by 24px

**Not fixed — needs a decision** (contradicts clarify.md, or the design is undecided)
- …

**Notes:** dynamic texts (unmatched): …
```

Tell the user the result in short form: how many sections pass and the biggest failures.

## Step 5b: Check for Later Decisions Before Fixing

`clarify.md` isn't the only source of decisions. QA rounds and follow-up fixes often change things on purpose after clarify, and they can deviate from Figma. For every failure you plan to fix:
1. Find the code line responsible.
2. Run `git log -L <start>,<end>:<file> --oneline` (or `git log -S'<class>' --oneline -- <file>`) and read the commit messages that touched it.
3. Check `plan.md` → Deviations from Figma and `execution-log.md` → Deviations.
4. Search other features' `fix-log.md`, `comparison-report.md`, `assessment-report.md` and `clickup-context.md` (QA bug batches) for the element.

If a later commit or fix deliberately set the current value (e.g. "CTA sits flush to the edge"), it's a **decision**. Move it to "Not fixed — needs a decision", quote the commit, and don't revert it. Fix only deviations nobody chose: plan estimates ("matches the screenshot"), omissions and bugs.

## Step 6: One Gate → Automatic Fix Loop

If everything passes, or the run is `check-only`, skip to Step 7. Otherwise ask **once** with `AskUserQuestion`:
- **Fix automatically (recommended):** fix everything below, re-verify, and repeat
- **Show me first:** stop here with the report

If the answer is fix, run the loop **without further questions**:

1. **Fix** every failure in the report:
   - Load the standards before editing: `shopify-theme-toolkit:liquid-standards` / `css-standards` / `js-standards` (and `section-standards` for section files).
   - Fix the root cause (the class, setting, breakpoint or JS logic). Don't add one-off overrides.
   - Follow the project's conventions (CLAUDE.md), e.g. Tailwind utilities first, `base.css` only when needed, `data-*` hooks for JS.
   - Use the dump values as the target: exact px, colours and fonts from the dump/spec.
   - **Only edit in-scope files** (Step 1). If the real cause is elsewhere (a shared snippet, theme settings, a template JSON, `settings_data.json`), don't edit it; move it to "needs a decision".
   - Skip anything Step 5b classified as a decision.
   - Never commit, push or change branches.
2. **Log** each change in `fix-log.md`: round, section, failure, root cause, file:line, and what changed.
3. **Rebuild CSS if needed:** if Tailwind classes changed, run the project's CSS build (`npm run build`, or confirm `npm run dev` is watching). Then wait about 2 seconds for the dev server to sync.
   - **Template or settings changed** (`templates/*.json`, `sections/*-group.json`, `config/settings_data.json`)? `shopify theme dev` can fail to upload them, so the local server shows the new value while the development theme the user previews keeps the old one. Push only the changed file to the development theme (`shopify theme push --development --only <file> --nodelete`, never the live theme) and say so in the fix log.
4. **Re-verify** only the sections touched in this round (`--sections`) with `--round N+1`.
   - Run a full sweep and all behaviour tests on the final round, to catch regressions.
5. **Stop** when any of these happens:
   - all checks pass
   - a round fixes nothing new (no progress)
   - something that passed now fails (regression): revert that change and report it
   - **5 rounds** are reached

Items that need a decision never block the loop. Collect them for the final report.

## Step 7: Final Report & Hand-off

**Figma screenshots of grouped sections:** when you crop them out of a full-frame export, compute the scale from the image (`image width ÷ frame width`). Figma downscales exports past its render-size limit; a 10,360px desktop frame came back at 1.5× instead of 2×, so 2×-based crops showed the wrong region.

**Before reporting, look.** Open the final `compare-{section}-{viewport}.png` of every section fixed in this run, and of every section the user asked to fix. Check the empty space too (padding above/below, gaps to the next section), not only the content: measured text positions can all pass while a section carries extra padding. Anything that still looks different goes back into the loop or into Unfixed mismatches.

Update `verify-report.md` with the final round and show the user:
1. the result per section, across rounds (e.g. `R1 3/7 → R3 7/7`)
2. what was fixed (count by type: measured / behaviour / sweep / visual) → `fix-log.md`
3. compare images for the fixed sections, before and after (the R1 and final `compare-*.png`)
4. **Unfixed mismatches (always last, never omitted).** List every remaining difference from Figma or intended behaviour that the loop did not fix, whatever the reason: a decision, out of scope, a Figma inconsistency, or dynamic data treated as a defect. Use 1–2 lines each:
   - what differs, with the section and width (Figma vs code)
   - why it wasn't fixed, and what the user can choose (fix it, keep it, or ask the designer)

   For example:
   - `women-categories @390`: labels differ (Figma: Sweater/Co-ords/Shorts/Jeans; code: Polos/Shirts/Jeans/Sweaters). Not fixed: Figma desktop and mobile disagree, and per-breakpoint labels are out of scope (clarify). Choose: use the mobile set, add mobile labels, or keep.

   Write the same list in `verify-report.md` under **Unfixed mismatches**. If there are none, say "No unfixed mismatches". Never call a run fully resolved while this list has entries.

```
→ Run /assess for code-quality and requirements verification.
```

## Rules
- At the Figma frame widths the design must match. There is no "close enough" category; only measured tolerance applies (font ±0.5px, line height ±1px, position ±2px, colour ±3/255).
- Never guess intended behaviour. Use the prototype data, `sections.json` behaviour and `clarify.md`. Anything else is a decision for the user.
- Edit only files in `execution-log.md`. Never touch templates, `settings_data.json` or other features.
- Never commit, push or switch branches. Never uninstall Playwright.
- Dynamic store data (titles, prices, counts) differing from Figma placeholder copy is not a defect.
- Keep all output in `.buildspace/artifacts/{feature}/verify/round-N/`.
