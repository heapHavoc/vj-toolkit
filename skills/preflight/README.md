# /preflight — implementation reference

This is the technical reference for maintainers extending these scripts. For
how the *agent* should run this skill, see `SKILL.md`. For the original
product spec, see the implementation brief this was built from (not checked
into this repo — ask whoever requested this skill for it if you need the
full rationale behind a decision below).

## Files

```
preflight/
  SKILL.md                              agent-facing instructions
  README.md                             this file
  scripts/
    check-code.mjs                      checker 1: git + static analysis, no browser
    check-performance.mjs                checker 3: Lighthouse
    check-analytics.mjs                  checker 2: Playwright, GTM/GA4/Meta
    run-preflight.mjs                    DETECT stage: page selection, runs all three, writes raw + worklist
    finalize-preflight.mjs               VERDICT stage: merges verifier output + config.accepted, writes the report
    lib/verdict.mjs                      status model, worklist explosion, verifier-merge rules
    lib/code-rules.mjs                   context-aware S4/S6/S7 rules (pure, tested)
    lib/page-map.mjs                     theme dependency graph → which pages the diff touches
    lib/abtest.mjs                       performance engine: preview-path A/B, real throttling, warm-up, identity proof, statistics
    __tests__/regression.test.mjs        plain-Node regression tests — run after any change
  templates/
    preflight-report-template.md         Markdown report skeleton
    preflight.config.example.json        starter config, copied per-project
```

Per-project (not in this plugin — lives in the theme repo being checked):

```
.buildspace/preflight/
  preflight.config.json      committed — store, fixtures, thresholds
  preflight-baseline.json    committed — last known-good snapshot, written by --mode baseline
  preflight-raw.json         generated — detect stage output (every checker report, refs, pages)
  verification-worklist.json generated — one entry per candidate finding
  verification/<layer>.json  generated — written by the preflight-verifier agents
  preflight-final.json       generated — effective checks after verification
  preflight-report.md        generated — PENDING stub after detect, the real report after finalize
  artifacts/                 generated — analytics step screenshots, worst-run Lighthouse JSON
```

The verifier agent lives at `shopify-theme-toolkit/agents/preflight-verifier.md`.

## The output contract

Every checker script (`check-code.mjs`, `check-performance.mjs`,
`check-analytics.mjs`) prints exactly one JSON object to stdout and nothing
else meaningful (progress/error text goes to stderr). Shape:

```jsonc
{
  "checker": "code" | "performance" | "analytics",
  "mode": "pre-merge" | "post-merge" | "baseline",
  "startedAt": "ISO-8601",
  "context": { /* whatever's useful for debugging this run */ },
  "checks": [
    {
      "id": "G1",                    // stable, greppable id — see ID scheme below
      "name": "human-readable name",
      "priority": "P0" | "P1" | "P2" | "info",
      "status": "PASS" | "FAIL" | "SKIPPED" | "INFO",
      "summary": "one sentence",
      "evidence": { /* whatever proves the summary */ },
      "risk": "consequence if this ships — required on every FAIL"
    }
  ],
  "summary": { "pass": 0, "fail": 0, "skipped": 0, "p0Fail": 0, "p1Fail": 0 },
  "snapshot": { /* baseline mode only — merged into preflight-baseline.json */ }
}
```

Exit code is non-zero iff `summary.p0Fail > 0` (baseline mode always exits 0
— a snapshot write is never a gate). `run-preflight.mjs` parses each
checker's stdout, tolerates a non-JSON crash (wraps it as a SKIPPED check
rather than propagating the crash), and merges the three into one report.

### ID scheme

- `check-code.mjs`: `G0` (the diff has theme changes at all), `G1`–`G5` (git
  checks), `S1`–`S7` (static checks), `G2-DRIFT` (post-merge only).
- `check-performance.mjs`: `PERF-{page}-IDENTITY` (theme + template proof),
  `PERF-{page}-LCP/FCP/TBT/CLS` (timing tier), `PERF-{page}-COUNTED`
  (bytes/requests/render-blocking/DOM, both tiers), plus `PERF-CONFIG`/
  `PERF-DEPS`/`PERF-THEMES`/`PERF-URL`/`PERF-BASELINE` for infra-level SKIPs. `run-preflight.mjs`
  adds `PERF-COVERAGE-{template}` (SKIPPED — a changed template no page
  measures) and `PERF-COVERAGE-UNMAPPED` (info).
- `check-analytics.mjs`: `A1`–`A8` and `A-THEME` (journey ran on the intended themes; suffixed `-{journey}` when more than one
  journey is configured), plus `A-CONFIG`/`A-URL`/`A-DEPS`/`A-JOURNEY`/
  `A-BASELINE`/`A-NOTES` for infra-level SKIPs.
- Worklist item ids: `{layer}:{checkId}` or `{layer}:{checkId}#{n}` when a
  check's evidence holds several findings (`findings`, `offenses`, `commits`,
  `blocks`, `dangling`, `regressedSteps`).

IDs are referenced in the merged report and in conversation with the user —
don't renumber existing ones when adding a check; append.

## The two axes, concretely

Every checker implements both:

| | Branch axis (`pre-merge`) | Time axis (`baseline` → `post-merge`) |
|---|---|---|
| `check-code.mjs` | diffs `origin/<live>` vs `origin/<staging>` via temp worktrees | snapshots live's app-embed block list + theme-check count; post-merge re-snapshots and diffs the embed list only |
| `check-performance.mjs` | measures live URL and preview URL, diffs medians | measures live URL once, stores medians; post-merge re-measures live and diffs against the stored medians |
| `check-analytics.mjs` | runs the journey on both URLs, diffs captured event/script state | runs the journey on live once, stores normalized captured state; post-merge re-runs and diffs |

`check-performance.mjs` and `check-analytics.mjs` both factor their
live-vs-preview comparison logic into a generic reference/current function
(`evaluateMetrics` / `evaluateAnalytics`) parameterized by labels, so
pre-merge and post-merge share one implementation of the threshold/parity
logic — there is exactly one place that decides "is this a regression",
not two copies that can drift apart.

`check-code.mjs` does **not** share logic this way for the time axis: G1,
G3, G4, S1–S7 are inherently branch-diff checks (they compare two refs'
*code*) and have no meaningful time-axis equivalent — on the time axis the
code hasn't changed, only the store's state has. Only G2 (app embeds) has a
real time-axis analog (`G2-DRIFT`), because embeds are store state, not code.
Don't try to force S1–S7 into baseline/post-merge; they're pre-merge only by
design.

## Hard-won correctness rules (do not regress these)

These were each found by actually running the scripts against real or
realistic data during development, not by inspection. If you're modifying
these scripts, re-run an equivalent check before merging your change.

1. **Never let a missing metric coerce into arithmetic.** `null` coerces to
   `0` in JS arithmetic. A Lighthouse run against a broken preview page
   (bad theme ID, dead fixture, password gate) still returns a result
   object with every audit `null` — if that flows into a percentage-delta
   calculation, a completely broken page reports as a "100% speed
   improvement" and silently passes. Every metric comparison in
   `check-performance.mjs` requires both sides to be non-null before
   computing a delta; if either side is null, the check is `SKIPPED` for
   that metric, and if the whole page failed to measure at all, that's an
   explicit P0 FAIL (`measureUrl`'s `isValidRun` gate).

2. **A multi-page browser journey must accumulate capture state after every
   navigation, not read it once at the end.** `check-analytics.mjs` installs
   its GTM/GA4/Meta capture hooks on `window` via `addInitScript`, which
   re-runs (and resets) on every `page.goto()`. An event that fires on the
   PDP (e.g. `add_to_cart`) is gone by the time the journey reaches `/cart`
   unless it's pulled into a Node-side accumulator first. `runJourney`'s
   `pullCapture()` is called after every step for exactly this reason —
   don't move the final `page.evaluate()` back to a single call at the end.

3. **A global `function name(){}` declaration silently replaces an
   `Object.defineProperty` accessor already installed on `window`.** This
   was confirmed empirically (see git history / original dev session), not
   assumed. It means `window.gtag`'s accessor-based capture in
   `captureInitScript` does not reliably fire for the real-world
   `gtag.js` snippet (`function gtag(){dataLayer.push(arguments)}`), because
   that's a function declaration, not an assignment. This is **not a bug to
   fix** — the actual event data still flows through the `dataLayer.push`
   hook (which is assignment-based and unaffected), which is what
   `extractEvents()` reads. The `gtag`-specific capture array exists only as
   defense-in-depth for sites that call `window.gtag(...)` without a local
   declaration. Don't remove the `dataLayer` capture path thinking the
   `gtag` one is the reliable one — it's the other way around.

4. **`.mjs` requires ESM syntax; `lighthouse` is ESM-only and needs
   unwrapping.** A bare `require('lighthouse')` (even via `createRequire`,
   which Node allows for ESM as of the Node version this was built against)
   returns the module namespace object with the real function on `.default`,
   not a callable. `check-performance.mjs`'s `resolvePackage()` unwraps this
   unconditionally (`unwrapDefault`); it's a no-op for CJS packages like
   `chrome-launcher`, which have no `.default`.

5. **git subprocess stderr must be suppressed on expected-failure paths.**
   `check-code.mjs` calls `git show <ref>:<path>` speculatively in a dozen
   places, expecting many of them to fail (the path doesn't exist at that
   ref). Node's `execFileSync` inherits the parent's stderr by default, so
   without explicit `stdio: ['ignore', 'pipe', 'ignore']` on the common
   `git()` helper, every one of those expected failures prints a `fatal:`
   line to the terminal. Use the separate `gitVerbose()` helper only for
   operations whose failures should actually be visible (fetch, worktree
   add/remove).

6. **`report.checks: []` is truthy — a crashed checker must set an explicit
   flag, never be inferred from an empty array.** Found in a real
   production run: `check-code.mjs` crashed (see rule 7 below for why), and
   `run-preflight.mjs`'s `layerStatus()` only guarded against `!report` /
   `!report.checks` — an empty array passes both, `.some(...)` over it finds
   no `FAIL`, and the layer reads `GREEN`. **A hard crash and "18 checks
   passed" were indistinguishable.** `runChecker()` now sets `crashed: true`
   whenever it can't get valid checks (exception with unparseable stdout, or
   a parsed report that itself carries a top-level `error` — several of
   `check-code.mjs`'s own early-exit paths, like an unresolvable git ref, do
   exactly this). `layerStatus()` checks `report.crashed` before it looks at
   `checks` at all. If you add a new way for a checker to fail without
   populating `checks`, set `crashed: true` on that output too — don't rely
   on `checks.length === 0` meaning anything by itself.

7. **`check-code.mjs`'s `git worktree add`/`remove` calls are not safe to run
   concurrently against the same repo twice — defended against regardless of
   whether it's ever actually the cause of a crash.** An agent running this
   skill once deviated from `SKILL.md` and invoked `check-code.mjs` itself,
   concurrently, more than once against the same working tree, which is a
   real way to race on git's repo-global worktree metadata. *(Correction:
   this was originally written up as the confirmed cause of a specific
   production crash — it was not; see rule 8, the actual cause. This
   defensive property is still correct and still worth keeping, just don't
   trust a plausible-sounding hypothesis as confirmed until you've actually
   reproduced it — rule 8 is the example of what reproducing it for real
   looks like.)* The fix is at the orchestrator level: `run-preflight.mjs`
   invokes each entry in `CHECKERS` exactly once per run via a single
   `Promise.all`, so `check-code.mjs` itself is never invoked twice
   concurrently, while the three *different* checkers (which share no state)
   run concurrently with each other. Verified empirically — `check-code.mjs`
   alone takes ~6.5s; adding two 2-second dummy checkers in parallel only
   added ~0.5s total, not the ~4s sequential execution would have added.
   **Never add a second `CHECKERS` entry pointing at `check-code.mjs`, and
   never call `runChecker` for the same script twice within one
   `Promise.all`.** If a future change needs `check-code.mjs` invoked more
   than once in a single process (e.g. a new mode), it must serialize those
   specific calls, not just trust `Promise.all` to do the right thing.

8. **`console.log(json); process.exit(n);` truncates output over ~64KB —
   this was the actual cause of the "check-code crashed" production
   incident rule 7 originally (and wrongly) attributed to a worktree race.**
   When a Node process's stdout is a pipe (exactly what happens when
   `run-preflight.mjs` invokes a checker via `execFile`), writes larger than
   the OS pipe buffer (65536 bytes — `2^16` — on both Linux and macOS) are
   asynchronous. `process.exit()` does not wait for pending stdout writes to
   flush before killing the process, so any JSON payload over ~64KB printed
   immediately before `process.exit()` gets cut off mid-object, in the
   *child*, before the parent ever receives the rest — independent of exit
   code (confirmed: reproduces identically on both `process.exit(0)` and
   `process.exit(1)`), independent of `maxBuffer` (that option governs a
   different code path — killing the process because too much output
   accumulated — not this one), and 100% deterministic once the payload
   exceeds the pipe buffer, not a race or a memory/timeout issue (both were
   hypothesized and ruled out by direct reproduction before this was found).
   **The fix is `process.exitCode = n;` instead of `process.exit(n);`, on
   every exit path, in all three checkers and in `run-preflight.mjs` itself**
   (its own merged output, which embeds all three checkers' full reports, is
   if anything the *most* likely of the four to exceed 64KB on a real run —
   confirmed: a real `check-code.mjs` payload from a messy repo was
   136,553 bytes). Setting `exitCode` instead of forcing an immediate exit
   lets Node's event loop drain pending I/O before the process actually
   exits, which is Node's own documented reason `process.exitCode` exists.
   **Never reintroduce `process.exit(n)` immediately after a
   `console.log()` of a JSON payload in any of these four scripts** — if a
   future change needs to guarantee an exit code, set `process.exitCode` and
   let the function return normally.
   `scripts/__tests__/regression.test.mjs` guards this: it forces a >64KB
   payload through the real `runChecker()` on both exit 0 and exit 1 and
   asserts full recovery, plus one test that reproduces the *old* buggy
   pattern to prove the test actually exercises real behavior. Run it after
   touching any exit path in these files: `node scripts/__tests__/regression.test.mjs`.

9. **An empty comparison is untested, never green.** Found in a real run:
   the default `--staging-branch stage` had already been merged into live, so
   `git diff live...stage` was empty and every diff-scoped check "passed" on
   nothing — 11/11 PASS, GREEN, blank blast radius. `check-code.mjs` now emits
   `G0` as a SKIPPED P0 when no theme file differs, which makes the layer
   INCOMPLETE.

10. **A layer where nothing was tested is INCOMPLETE, not GREEN.** The same run
    showed performance and analytics as GREEN with 0 passes and 1 skip each
    (no config). `layerStatus()` used to fall through to GREEN for anything
    that wasn't a crash or a FAIL. Now: any SKIPPED P0, or no PASS/FAIL at all,
    is INCOMPLETE — and INCOMPLETE outranks YELLOW in the overall verdict,
    because an untested P0 could be a RED.

11. **Unknown flags are rejected.** `run-preflight.mjs --help` used to be
    silently ignored (as was any typo), so it ran the full pipeline on default
    branches and overwrote the report. `parseArgs()` is strict: `--help`
    prints usage and exits 0 without running anything; an unknown flag exits
    2. The resolved refs + SHAs are printed on stderr before anything runs.

12. **Never write a verdict before the findings are verified.** The old
    orchestrator rendered the final report straight from raw checker output,
    and the skill's triage step happened afterwards in chat and never made it
    back into the file — a report said RED for a CLS regression that didn't
    reproduce on re-measurement. Detect now writes only raw data and a PENDING
    stub; `finalize-preflight.mjs` is the only writer of a verdict. Verifier
    authority is asymmetric (see `lib/verdict.mjs`): it can confirm, escalate,
    or add freely, but a dismissal or downgrade without concrete evidence
    (file:line, measurement, artifact) is rejected, and an item no verifier
    returned stays `unverified` at its raw priority. A failed verifier can
    never turn RED into GREEN.

13. **Rules must know where the code is used.** Text-only rules produced most
    of the noise on the first real run: `{{ x.price }}` in `data-price` / JSON
    flagged as an unformatted price, `.product-hero .notes-tab.active`
    flagged as colliding with every `.active` in the theme, schema-default
    lorem ipsum ranked the same as lorem ipsum saved into a live template.
    `lib/code-rules.mjs` compares full (nesting-resolved) selectors and only
    rules this diff added, guards the price rule by context, and classifies
    placeholders by location. P2-only findings (comments) never gate.

14. **A journey step that didn't happen can't vouch for its events.** The
    analytics journey couldn't find a non-`<button>` add-to-cart control on
    either side, so `add_to_cart`/`begin_checkout` "did not fire on reference
    either" and A4 passed — nothing had been compared. Steps now record real
    outcomes (cart `item_count` via `/cart.js`, checkout intent), A8 fails when
    a step works on live but not preview, and an event whose step didn't run
    on both sides makes A4 SKIPPED (P0 → INCOMPLETE). Preview params are now
    carried on every step URL, not only the first navigation.

15. **Performance is an A/B experiment, not a Lighthouse score.** On two
    real stores (2026-10) the Lighthouse-simulate method:
    - flipped verdicts between identical 5-run batches
    - reported CLS 1.0 vs 0 depending on the machine (CLS is observed, not simulated)
    - put PSI 35 points away from local on the same URL
    - missed a 21% LCP improvement

    Shopify-specific causes were also measured:
    - preview pages are rendered uncached (`server-timing: processing` 300–700 ms cold vs ~30 ms warm)
    - the preview redirect and an extra hot-reload script make live-URL-vs-preview-path skew FCP by ~300 ms on the same theme

    `lib/abtest.mjs` therefore:
    - loads both themes through the preview path
    - sets the preview cookie before the measured navigation
    - warms the render cache and drops cold-render runs
    - proves the theme (server-timing) and template (body class) on every run
    - uses real CDP throttling with a CPU slowdown calibrated from Lighthouse's benchmark
    - alternates A/B
    - decides with Mann-Whitney U + a bootstrap 95% CI against a practical threshold, extending 10 → 20 runs per side while unsettled

    The same Store B comparison, repeated, gave the same verdicts. Lighthouse runs once per side, only on non-passing pages, for its insights. Don't reintroduce simulated timings into a verdict, and don't compare against the live URL directly.

## Extension points (brief §13 — do not build without being asked)

`check-runtime.mjs` (fixed template matrix, `Liquid error`/`Translation
missing`/console errors/4xx-5xx, preview minus live) and `check-features.mjs`
(committed Playwright specs, gate only executes, never generates) are
planned but explicitly out of scope. To add either:

1. Write `scripts/check-<name>.mjs` following the same output contract above
   (same `Checks` accumulator shape as the other three — copy, don't
   reinvent).
2. Add one entry to `CHECKERS` in `run-preflight.mjs`.
3. Add one row to the layer table in `SKILL.md`'s Step 1.

Nothing else in the orchestrator, report template, or status model changes.

## Status model (changed with sign-off, 2026-09-27)

Per layer, never blended, computed by `finalize-preflight.mjs` from verified
findings (`lib/verdict.mjs`):

- **RED**: any P0 finding confirmed or unverified.
- **INCOMPLETE**: the checker crashed, any P0 check was SKIPPED, or nothing on
  the layer was actually tested.
- **YELLOW**: any P1 finding confirmed or unverified, not covered by
  `config.accepted`.
- **GREEN**: none of the above. P2/info findings are notes, not gates.

Overall verdict is the worst layer, ordered RED > INCOMPLETE > YELLOW > GREEN —
never an average, never a blended score. `finalize-preflight.mjs` exits 1 on
RED or INCOMPLETE. Don't change this again without asking.
