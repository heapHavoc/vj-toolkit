# Preflight Report ({{MODE}})

**Overall verdict:** {{OVERALL_STATUS}}
**Comparing:** {{COMPARISON}}
**Verification:** {{VERIFICATION_STATUS}}
**Detected:** {{DETECTED_AT}} · **Finalized:** {{TIMESTAMP}}

GREEN means "every check that ran passed after verification," not "safe" — see **Not checked**.
INCOMPLETE means something that gates the release could not be tested — it is never a pass.

## Layer status

| Layer | Status | Raw (pre-verification) | Pass | Confirmed | Unverified | False alarm | Accepted | Skipped |
|---|---|---|---|---|---|---|---|---|
{{LAYER_STATUS_TABLE}}

## Red findings (P0 — blocks release)

Confirmed by a verifier, or not verified at all (an unverified finding keeps its raw priority).

{{RED_FINDINGS}}

## Yellow findings (P1 — needs a named, logged risk acceptance to ship)

{{YELLOW_FINDINGS}}

_Sign-off: add an entry to `config.accepted` — `{ "check": "S6", "file": "…", "reason": "…", "by": "name", "date": "YYYY-MM-DD" }` — and re-run finalize._

## Not tested (why a layer is INCOMPLETE)

{{NOT_TESTED}}

## Pages tested (performance)

{{PAGES}}

## Blast radius

What this release touches — QA's look-here list.

{{BLAST_RADIUS}}

## P2 notes (non-gating)

{{P2_FINDINGS}}

## Dismissed by verification (false alarms)

Each dismissal cites the evidence the verifier used. Audit these — a wrong dismissal is the verifier's failure mode.

{{DISMISSED}}

## Accepted (config.accepted)

{{ACCEPTED}}

## Informational (pre-existing, not gating)

Already true on the reference side before this release — reported for visibility, never counted toward the verdict above.

{{INFO_FINDINGS}}

## Other skipped checks

{{SKIPPED}}

## Verifier problems

Rejected dismissals, unknown item ids, unreadable verifier output.

{{VERIFIER_PROBLEMS}}

## Not checked

Out of scope and owned elsewhere:
- Checkout and payment flow (the journey stops at the checkout boundary)
- Discount and promo logic
- Merchandising correctness
- App behaviour beyond embed presence
- Client UAT
- Visual fidelity (owned by `/compare`)
- Platform concerns owned by Shopify (load, DNS, SSL, CDN, backups, DR, auth, database)
