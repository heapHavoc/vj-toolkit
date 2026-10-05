# Figma workflow: issues by category

**Author:** Vishvam Joshi · **Scope:** the Figma part of shopify-theme-toolkit, both reading the design (`/figma`) and checking the build against it (`/compare`). · **Base:** 3.5.0 · **Detail:** [improvements.md](improvements.md)

Each category lists what went wrong before and what we changed. Numbers are given only where they are facts, such as quota limits, sizes and round counts. Token usage was **not measured**; we can measure it on the next feature if needed.

---

## 1. Access and quota (the blocker)

| Issue | Impact | Fix |
|---|---|---|
| The official Figma Dev Mode MCP allows **6 calls/month** on Starter/View/Collab seats | One page uses up the month. After that `/figma` can't run at all. | `/figma-rest` uses the REST API with a personal access token: per-minute rate limit, no monthly cap |
| A big frame truncates the MCP response, so it needs `get_metadata` plus a call per child | Even more quota used per page | **One REST call per frame.** The response is cached on disk, so re-runs and lookups cost **zero calls**. |
| figma-rest v1 needed a second MCP server (Framelink) installed and connected | Extra setup; it breaks if the server isn't running | Plain scripts, no MCP needed. Framelink is only a fallback for single nodes. |

## 2. Tokens and context cost

| Issue | Impact | Fix |
|---|---|---|
| The MCP returns generated code for the **whole frame** into the conversation | Large context per page and truncation on big frames | Extraction runs in **scripts outside the conversation** and writes one file per section. Claude reads only the section it is building. |
| Framelink v1 returns the whole node tree into context | Large, and still missing data (see section 3) | Compact Dev Mode-style dumps. Repeated items (cards, swatches) are compressed to one entry plus a count; selected/active variants are kept. |
| Re-reading Figma for one value meant another full call | Wasted tokens and quota for small lookups | The cache makes lookups free, and the hook allows one-section lookups. |
| `/compare` had the model look at every Figma/code image pair | Image tokens on every section, including correct ones | *3.5.0 already reduced this* with pixel-diff triage. `/figma-verify` **measures in a script** and the model reads only the failures plus their side-by-side images. |

## 3. Accuracy: missing design data, so a wrong build

| Issue | Impact | Fix |
|---|---|---|
| Framelink v1 drops **prototype interactions** | Sliders, accordions, hover and sticky behaviour weren't known. This is why devs felt "dk-toolkit reads Figma better". | Raw REST JSON keeps interactions, with destinations resolved by name and timings in ms |
| Mixed-style text and variables lost or unresolved | Wrong weight or colour on part of a heading; raw hex instead of tokens | Mixed-style runs are kept, variables resolved, and values matched to the project's theme settings |
| Sections were picked by hand from the frame's direct children | Whole desktop treated as one section; helper/annotation layers built as sections; a real section ("Size & Value Guide") dropped | Automatic section detection. It skips helper layers, unwraps wrappers, groups columns, and recognises header and footer. |
| plan and execute only saw a `design-context.md` summary | Values estimated from screenshots. Found in testing: CTA icon **16px vs Figma 10/12px**, letter-spacing **0.16px vs 0.32px** | Each section's exact values (per frame width) go into the plan and are used by execute |
| Behaviour was guessed from layer names | False signals: "performs" read as a form, star ratings as slider dots | Word-boundary matching plus geometry checks |
| Sections without a background exported **black** | Unusable screenshots for review | These export as JPG on white |
| Figma's desktop and mobile frames sometimes contradict each other (e.g. different labels) | Claude silently picked one | The plan lists **Deviations from Figma**, and contradictions go to the developer |

## 4. Efficiency and time

| Issue | Impact | Fix |
|---|---|---|
| Developers had to find node IDs, build node lists and follow a strict `Desktop:` / `Mobile:` format | Manual setup on every feature | Paste anything: links, labelled or not, or the Dev Mode "Copy prompt". A hook routes it automatically. |
| A pasted link and a pasted Dev Mode prompt behaved differently | Inconsistent results between developers | Both now produce the same result |
| `/compare` → `/fix` loop **stalled**. `/fix` is user-only and waits for approval, so compare's automatic call can't complete. | The developer has to notice, run `/fix` and re-run `/compare` by hand | `/compare` hands off clearly. `/figma-verify` has **one approval, then fixes and re-verifies automatically** (max 5 rounds; stops on no progress or regression). |
| The loop was capped at 2 iterations | Leftovers handed back to the developer | Up to 5 measured rounds, re-checking only the sections that changed |
| *3.1.0:* the dev server URL was asked for every run (3.5.0 added `preview-url.txt`) | Repeated prompts | Detected automatically or reused from `preview-url.txt`, shared with `/compare` |

## 5. Verification quality: what slipped through

| Issue | Impact | Fix |
|---|---|---|
| Verdicts by eye (MATCH / MINOR / MISMATCH), with "minor" accepted | Small but real errors pass, e.g. 0.16px vs 0.32px letter-spacing | **Measured** font, size, weight, line height, letter spacing, colour and position, with tight tolerances (±0.5px font, ±2px position) |
| Always checked at fixed 1440 / 390 | A design drawn at 402 or 375 was compared at the wrong width | Checks at **the Figma frame's actual widths** |
| No other screen widths | Overflow and clipped text at tablet or large screens only found in QA | **11 widths swept** (320 to 2560): overflow, clipped text, broken images, console errors |
| No interaction testing | Broken sliders, accordions and sticky bars only found in QA | **Interaction tests** written from Figma prototypes and clarify decisions |
| A QA-approved change could be "fixed" back to Figma, or a defect could be excused as a decision | Real miss found in testing: the desktop CTA position was wrongly treated as a decision | Before fixing, it checks plan/execute deviations, git history and QA fix logs. Remaining differences are listed as **Unfixed mismatches**, 1–2 lines each, and never hidden. |

## 6. Frustration and developer experience

| Issue | Impact | Fix |
|---|---|---|
| The quota runs out mid-feature, with no warning | Work stops and developers fall back to eyeballing Figma | No quota |
| The loop silently stops after `/compare` | Developers think it's still running, or that it passed | Clear hand-off and a final report |
| *3.1.0:* compare uninstalled Playwright after every run, removing the project's own dependency | Tests broke in projects that use Playwright | *Already fixed upstream in 3.5.0.* `/figma-verify` never uninstalls. |
| Leftover differences weren't reported | TL/QA found them later | A mandatory "Unfixed mismatches" list at the end of every run |
| The README told developers to copy the hooks into project settings | Hooks ran twice. One project still has a stale, no-op copy. | The README now says not to copy |

---

## Summary
- **Biggest blocker:** the 6-calls/month quota. It's gone; figma-rest runs on the REST API with caching.
- **Accuracy:** interactions, mixed text styles, variables and correct sections are now captured. Plan and execute use exact values, not screenshot estimates.
- **Efficiency:** paste anything; one approval, then an automatic measured fix loop instead of a stalled manual one.
- **Quality:** measured checks at the real Figma widths, 11-width sweep and interaction tests catch what eyeballing missed.
- **Not yet measured:** token usage and time per feature. We suggest measuring both on the next Figma feature, comparing the old flow with the new one.
