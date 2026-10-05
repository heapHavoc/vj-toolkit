# PRD: Backend Changes for Token & Session Tracking

## Context

The `SessionEnd` hook is unreliable (doesn't fire on ctrl+c). We're replacing it with two reliable hooks:

- **`SessionStart`** — fires once per new session, includes `model` field
- **`Stop`** — fires after every Claude response, can parse transcript file for running token total

This requires two new `event_type` handlers in the Lambda.

---

## New Event Types

### `session_start`

**When it fires:** Once per new session (only when `source: "startup"`, not on resume/clear/compact)

**Payload:**
```json
{
  "event_type": "session_start",
  "user_email": "aditya.pasikanti@devxconsultancy.com",
  "user_name": "aditya325",
  "project": "mokobara-old",
  "models_used": ["claude-sonnet-4-6"],
  "timestamp": "2026-04-07T10:00:00Z",
  "token": "shopify-theme-toolkit"
}
```

**What the Lambda should do:**
```
UpdateItem(user_email)
  SET user_name = :name, last_active = :ts
  ADD total_sessions :one
  ADD models.#model :one              (for each model in models_used)
  ADD projects.#proj.sessions :one
```

Uses `ADD` — increments session count by 1 each time.

---

### `token_update`

**When it fires:** After every Claude response (Stop hook). Sends the **cumulative** token total from the entire session transcript so far — not a delta.

**Payload:**
```json
{
  "event_type": "token_update",
  "user_email": "aditya.pasikanti@devxconsultancy.com",
  "user_name": "aditya325",
  "project": "mokobara-old",
  "total_tokens": 5423891,
  "models_used": ["claude-opus-4-6", "claude-sonnet-4-6"],
  "timestamp": "2026-04-07T10:15:00Z",
  "token": "shopify-theme-toolkit"
}
```

**Why cumulative, not delta:** The Stop hook parses the full transcript file each time. It sums ALL tokens from the start of the session. So the value grows with each response: 100K → 250K → 500K → etc.

**What the Lambda should do:**

This is a two-step process because we need to track per-session tokens without double-counting across sessions.

**Step 1:** Read the current stored token snapshot for this user+session (or use a session-scoped temp key).

**Simpler approach:** Store a `session_tokens` map that tracks the latest token count per session_id. The difference between the new value and the stored value is the delta to add to `total_tokens`.

Actually, the simplest approach that avoids complexity:

**Store last known token count per user in a separate field, compute delta in Lambda:**

```
// Read current snapshot
current_session_tokens = item.current_session_tokens || 0

// Compute delta
delta = total_tokens - current_session_tokens

// Update
UpdateItem(user_email)
  SET user_name = :name,
      last_active = :ts,
      current_session_tokens = :new_total
  ADD total_tokens :delta
  ADD projects.#proj.tokens :delta
```

**Problem:** This only works for one session at a time per user. If a user has two sessions open, the deltas get wrong.

**Even simpler approach — just SET, don't ADD:**

Since `Stop` fires on every response and sends the cumulative total from the transcript, we can't use ADD (it would massively overcount). But we also can't just SET the total because it would lose tokens from previous sessions.

**Recommended approach: Track per-session totals, derive total from sum.**

Add a `sessions` map field to the table:

```
sessions: {
  "d003dfa6-...": { "tokens": 5423891, "model": "claude-sonnet-4-6" },
  "a764cd95-...": { "tokens": 33119926, "model": "claude-opus-4-6" }
}
```

On each `token_update`:
```
UpdateItem(user_email)
  SET user_name = :name,
      last_active = :ts,
      sessions.#session_id.tokens = :total_tokens
```

Then `total_tokens` is computed on READ (sum of all `sessions.*.tokens`) instead of being stored. The GET endpoints aggregate it.

**But wait** — this changes the read logic. Let me simplify further.

---

## Recommended Approach (Simplest)

### Change: Add `session_id` to the `token_update` payload

The hook already has `session_id` available from the Stop hook stdin. We add it to the payload:

```json
{
  "event_type": "token_update",
  "session_id": "d003dfa6-c7a7-4796-b9ba-073b588069ad",
  "user_email": "aditya.pasikanti@devxconsultancy.com",
  "user_name": "aditya325",
  "project": "mokobara-old",
  "total_tokens": 5423891,
  "models_used": ["claude-sonnet-4-6"],
  "timestamp": "2026-04-07T10:15:00Z",
  "token": "shopify-theme-toolkit"
}
```

### Lambda logic for `token_update`:

```javascript
// Step 1: Read current stored value for this session
const item = await getItem(user_email);
const previousTokens = item?.session_tokens?.[session_id] || 0;
const delta = total_tokens - previousTokens;

// Step 2: Only update if delta > 0 (avoid negative deltas from race conditions)
if (delta > 0) {
  await updateItem(user_email, {
    SET: {
      user_name,
      last_active: timestamp,
      'session_tokens.#sid': total_tokens   // store latest snapshot
    },
    ADD: {
      total_tokens: delta,                   // add only the new tokens
      'projects.#proj.tokens': delta         // add only the new tokens
    }
  });
}
```

### New field in `claude-code-analytics` table:

| Field | Type | Example | Purpose |
|---|---|---|---|
| `session_tokens` | Map | `{"d003dfa6": 5423891, "a764cd95": 33119926}` | Stores last known token count per session. Used to compute deltas. |

This field is internal — the GET endpoints don't need to return it.

---

## Updated Table Schema

| Field | Type | Updated By |
|---|---|---|
| `user_email` (PK) | String | All events |
| `user_name` | String | All events (SET) |
| `total_sessions` | Number | session_start: ADD +1 |
| `total_tokens` | Number | token_update: ADD delta |
| `total_skill_uses` | Number | skill_invocation: ADD +1 |
| `last_active` | String | All events (SET) |
| `skills` | Map | skill_invocation: ADD +1 per skill |
| `models` | Map | session_start: ADD +1 per model |
| `projects` | Map | All events (nested: tokens, skills, sessions) |
| `session_tokens` | Map | token_update: SET per session_id (internal, not returned by GET) |

---

## Summary of All Event Types

| event_type | Hook Source | DynamoDB Operation |
|---|---|---|
| `skill_invocation` | UserPromptSubmit | ADD total_skill_uses, ADD skills.{skill}, ADD projects.{proj}.skills |
| `session_start` | SessionStart | ADD total_sessions, ADD models.{model}, ADD projects.{proj}.sessions |
| `token_update` | Stop | Read current session snapshot → compute delta → ADD total_tokens, ADD projects.{proj}.tokens, SET session_tokens.{sid} |

---

## Changes Required

### Lambda `index.js`

1. Add `session_start` handler:
   - Validate `models_used` array exists
   - ADD `total_sessions` +1
   - ADD `models.{model}` +1 for each model
   - ADD `projects.{project}.sessions` +1

2. Add `token_update` handler:
   - Read current item to get `session_tokens.{session_id}` (or 0 if new)
   - Compute `delta = total_tokens - previous`
   - If delta > 0: ADD `total_tokens` delta, ADD `projects.{project}.tokens` delta
   - SET `session_tokens.{session_id}` = total_tokens

3. Update GET `/analytics/users` and `/analytics/users/{user}`:
   - Exclude `session_tokens` field from response (internal bookkeeping)

### No changes to:
- DynamoDB table definition (no new GSIs, no schema changes — Map fields are schemaless)
- API Gateway routes
- SAM template
- Frontend

---

## Verification

1. Start a new Claude Code session → check DynamoDB: `total_sessions` incremented, model recorded
2. Run a few prompts → check DynamoDB: `total_tokens` increasing, `session_tokens.{sid}` updating
3. Start a second session → check: `total_sessions` incremented again, previous session tokens preserved
4. GET `/analytics/users` → verify `session_tokens` is NOT in the response
5. GET `/analytics/users/{user}` → verify total_tokens = sum makes sense
