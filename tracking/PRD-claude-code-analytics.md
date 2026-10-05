# PRD: Claude Code Usage Analytics

## Overview

A usage analytics system for the `shopify-theme-toolkit` Claude Code plugin that tracks skill usage, session data, token consumption, and model usage across team members and projects.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | AWS SAM + Lambda (Node.js 20.x) |
| Database | DynamoDB — single table: `claude-code-analytics` |
| Frontend | Next.js 16 (App Router) inside `shopify-learn-frontend` |
| Styling | Tailwind CSS 4 |
| Auth | NextAuth (Google OAuth) — already in place |
| Deployment | Backend: `sam deploy` / Frontend: Vercel |

---

## Data Sources

Two Claude Code hooks send data to one API endpoint.

### Hook 1: `UserPromptSubmit` — Skill Invocation

**Trigger:** User types `/shopify-theme-toolkit:skill-name`

**Payload:**
```json
{
  "event_type": "skill_invocation",
  "user_email": "aditya@devxlabs.ai",
  "user_name": "Aditya Pasikanti",
  "project": "mokobara-old",
  "skill": "clarify",
  "timestamp": "2026-04-06T18:00:00Z",
  "token": "shopify-theme-toolkit"
}
```

### Hook 2: `SessionEnd` — Session Summary

**Trigger:** User exits Claude Code or session ends

**What the hook does:**
1. Reads `transcript_path` from stdin JSON
2. Parses the `.jsonl` transcript file:
   - Sums `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens` from all assistant messages with `message.usage`
   - Collects unique `message.model` values
3. POSTs aggregated data to the API

**Payload:**
```json
{
  "event_type": "session_end",
  "user_email": "aditya@devxlabs.ai",
  "user_name": "Aditya Pasikanti",
  "project": "mokobara-old",
  "total_tokens": 31707918,
  "models_used": ["claude-opus-4-6", "claude-sonnet-4-6"],
  "timestamp": "2026-04-06T18:30:00Z",
  "token": "shopify-theme-toolkit"
}
```

---

## Database

### Single Table: `claude-code-analytics`

One row per user. No GSIs. No relations.

| Field | Type | Example | Updated By |
|---|---|---|---|
| `user_email` (Partition Key) | String | `aditya@devxlabs.ai` | Both events |
| `user_name` | String | `Aditya Pasikanti` | Both events (SET, latest wins) |
| `total_sessions` | Number | `47` | session_end: +1 |
| `total_tokens` | Number | `892451023` | session_end: +tokens |
| `total_skill_uses` | Number | `156` | skill_invocation: +1 |
| `last_active` | String | `2026-04-06T18:30:00Z` | Both events |
| `skills` | Map | `{"clarify": 23, "plan": 18, "execute": 15, ...}` | skill_invocation: +1 per skill |
| `models` | Map | `{"claude-opus-4-6": 12, "claude-sonnet-4-6": 35}` | session_end: +1 per model |
| `projects` | Map | `{"mokobara-old": {"tokens": 500000, "skills": 45, "sessions": 12}, ...}` | Both events (see below) |

### How Each Event Updates the Table

**On `skill_invocation`:**
```
UpdateItem(user_email)
  SET user_name = user_name, last_active = timestamp
  ADD total_skill_uses 1
  ADD skills.{skill} 1
  ADD projects.{project}.skills 1
```

**On `session_end`:**
```
UpdateItem(user_email)
  SET user_name = user_name, last_active = timestamp
  ADD total_sessions 1
  ADD total_tokens {total_tokens}
  ADD projects.{project}.tokens {total_tokens}
  ADD projects.{project}.sessions 1
  ADD models.{model} 1   (for each model in models_used)
```

All writes are atomic DynamoDB `UpdateItem` with `ADD` expressions. No read-before-write needed. If the user doesn't exist yet, DynamoDB creates the item automatically.

---

## API

### Endpoints

New Lambda function: `AnalyticsFunction`

| Method | Route | Description | Source |
|---|---|---|---|
| `POST` | `/analytics/ingest` | Receives hook data | Validates token, updates DynamoDB |
| `GET` | `/analytics/users` | All users list | Scan `claude-code-analytics` |
| `GET` | `/analytics/users/{user}` | Single user detail | GetItem by `user` PK |

### `POST /analytics/ingest`

```
Receive JSON body
  → Validate token == "shopify-theme-toolkit"
  → Validate event_type is "skill_invocation" or "session_end"
  → Run the appropriate UpdateItem (see above)
  → Return { success: true }
```

### `GET /analytics/users`

```
Scan claude-code-analytics table
  → Return all rows sorted by total_tokens descending
  → Each row includes: user_email, user_name, total_sessions, total_tokens, total_skill_uses, last_active
```

### `GET /analytics/users/{user}`

```
GetItem by user_email PK
  → Return full row: user_email, user_name, total_sessions, total_tokens,
    total_skill_uses, last_active, skills (full map), models (full map), projects (full map)
```

### Authentication

- **Ingest endpoint:** Token in request body (`"token": "shopify-theme-toolkit"`)
- **GET endpoints:** NextAuth session — proxy through Next.js API routes, ADMIN/SUPERADMIN only

---

## Frontend

See separate PRD: `PRD-frontend-claude-analytics.md`

---

## SAM Template Addition

Add to existing `shopify-learn-backend/template.yaml`:

```yaml
AnalyticsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: claude-code-analytics
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: user_email
        AttributeType: S
    KeySchema:
      - AttributeName: user_email
        KeyType: HASH

AnalyticsFunction:
  Type: AWS::Serverless::Function
  Properties:
    Handler: index.handler
    Runtime: nodejs20.x
    CodeUri: src/lambda-functions/analytics/
    Policies:
      - DynamoDBCrudPolicy:
          TableName: !Ref AnalyticsTable
    Environment:
      Variables:
        ANALYTICS_TABLE: !Ref AnalyticsTable
    Events:
      IngestApi:
        Type: Api
        Properties:
          Path: /analytics/ingest
          Method: POST
      UsersApi:
        Type: Api
        Properties:
          Path: /analytics/users
          Method: GET
      UserDetailApi:
        Type: Api
        Properties:
          Path: /analytics/users/{user}
          Method: GET
```

---

## Hook Implementation

### File: `shopify-theme-toolkit/hooks/hooks.json`

**`UserPromptSubmit`** — extracts skill from prompt, POSTs to Lambda:
```
Extract skill from prompt
Collect: user_email (git config user.email), user_name (git config user.name), project (git repo name)
→ POST to /analytics/ingest with event_type: "skill_invocation"
```

**`SessionEnd`** (new) — parse transcript, POST token summary:
```
Read transcript_path from stdin JSON
→ python3 parses .jsonl file:
    for each line where type == "assistant" and message.usage exists:
      total_tokens += input_tokens + output_tokens + cache_read + cache_creation
      models.add(message.model)
→ POST to /analytics/ingest with event_type: "session_end"
```

---

## Implementation Order

### Phase 1: Backend
1. Add DynamoDB table + Lambda to `template.yaml`
2. Create `src/lambda-functions/analytics/index.js`
3. Implement `POST /analytics/ingest` (validate token, UpdateItem)
4. Implement `GET /analytics/users` (Scan, sort by total_tokens)
5. Implement `GET /analytics/users/{user}` (GetItem)
6. Deploy with `sam deploy`

### Phase 2: Hooks
1. Update `UserPromptSubmit` hook — POST to Lambda endpoint
2. Add `SessionEnd` hook with transcript parsing
3. Test both hooks

### Phase 3: Frontend
See `PRD-frontend-claude-analytics.md` for full frontend implementation details.

---

## Verification

1. Invoke `/shopify-theme-toolkit:research` → check DynamoDB for updated user row
2. End a Claude Code session → check DynamoDB for incremented total_tokens
3. Open `/claude-analytics` → verify users list shows data
4. Click a user → verify detail page shows skills, models, projects breakdown
