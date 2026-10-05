# Why REST instead of the official Figma MCP

## The quota
The official Figma MCP server (remote `mcp.figma.com` or the desktop Dev Mode server) limits tool calls by seat and plan. Starter plans and View/Collab seats get **6 calls per month**. One section needs `get_design_context` + `get_screenshot`, often `get_metadata` too, so a single page uses up the monthly allowance.

The Dev Mode "Copy prompt" text (`Implement this design from Figma. @<link>`) contains no design data. It is a link, and on machines with the official MCP the agent fetches that link through the quota-limited tools. This skill fetches the same link through REST.

## What the official MCP gives, and how this skill covers it

| Official MCP (`get_design_context`) | figma-rest |
|---|---|
| Figma-generated code: layout as flex/grid, sizes, spacing | `extract-figma-sections.js` turns raw node JSON into CSS-like props (auto-layout → flex/grid, fill/hug/fixed sizing, absolute children, clipping, borders, radius, shadows, blur, gradients) |
| Text styles, mixed text runs | `font:` shorthand + per-run overrides (`run …`) |
| Variable names (`var(--Text/Primary, #0F0F0F)`) | Names on Enterprise plans; otherwise variable IDs with resolved values, plus matches against the theme's own `settings_data.json` colors and fonts |
| Component / variant names | Instance component + variant properties |
| Screenshot | `save-figma-screenshots.js` (REST image export, saved to disk) |
| Prototype interactions | **More than the MCP**: raw `interactions` (trigger → action → destination), scroll containers, sticky/fixed layers |
| — | Behaviour inference: clipped overflow → slider, dots/progress track → slider indicator, repeated rows + icon → accordion, swatches, inputs, hidden alternate states, visually distinct sibling = selected/active state |

Framelink (`figma-developer-mcp`) also uses REST, but it simplifies the response and drops interactions and variable bindings. It is kept only as a fallback.

## Limits that remain
- REST calls are still rate-limited per seat and plan, per minute. The scripts cache every response under `raw/` and back off on HTTP 429.
- If the file belongs to a team on a Starter plan, Figma may still restrict REST access to that file. This is a Figma-side restriction.
- Variable **names** need the Variables API, which requires an Enterprise plan.
