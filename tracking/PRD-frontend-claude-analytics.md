# PRD: Claude Code Analytics — Frontend

## Overview

A dashboard inside `shopify-learn-frontend` to visualize Claude Code usage analytics. Shows team-level and user-level views with charts and tables. Admin only.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) — existing `shopify-learn-frontend` |
| Styling | Tailwind CSS 4 — existing |
| Charts | Recharts (new dependency) |
| Icons | Lucide React — existing |
| Auth | NextAuth (Google OAuth) — existing, ADMIN/SUPERADMIN role gate |

### New Dependency

```
npm install recharts
```

---

## API Endpoints Consumed

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/claude-analytics/users` | All users with summary stats |
| `GET` | `/api/claude-analytics/users/[user_email]` | Single user full detail |

Both are Next.js API routes that proxy to the Lambda backend. Protected by NextAuth session + ADMIN role check using existing `requireRole` from `lib/auth/apiAuth.ts`.

### Response Shape: `GET /api/claude-analytics/users`

```json
[
  {
    "user_email": "aditya@devxlabs.ai",
    "user_name": "Aditya Pasikanti",
    "total_sessions": 47,
    "total_tokens": 892451023,
    "total_skill_uses": 156,
    "last_active": "2026-04-06T18:30:00Z",
    "skills": { "clarify": 23, "plan": 18, "execute": 15, ... },
    "models": { "claude-opus-4-6": 12, "claude-sonnet-4-6": 35 },
    "projects": {
      "mokobara-old": { "tokens": 500000000, "skills": 45, "sessions": 12 },
      "vediclab": { "tokens": 280000000, "skills": 67, "sessions": 23 }
    }
  },
  ...
]
```

### Response Shape: `GET /api/claude-analytics/users/[user_email]`

Same shape as a single item from the array above.

---

## Routes

| Route | Page |
|---|---|
| `/claude-analytics` | Team Dashboard |
| `/claude-analytics/users/[user_email]` | User Detail |

---

## Page 1: Team Dashboard (`/claude-analytics`)

Fetches `GET /api/claude-analytics/users`, aggregates all user data client-side.

### Section 1: Summary Cards

Four cards in a row.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Total Users  │  │ Total        │  │ Total Tokens │  │ Total Skill  │
│     8        │  │ Sessions: 214│  │    3.2B      │  │ Uses: 847    │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

| Card | Computation |
|---|---|
| Total Users | Count of rows |
| Total Sessions | Sum of all `total_sessions` |
| Total Tokens | Sum of all `total_tokens` |
| Total Skill Uses | Sum of all `total_skill_uses` |

### Section 2: Top Users (two charts side by side)

**Left: Top Users by Token Consumption**

- Recharts `<BarChart>` horizontal
- Y-axis: user names, X-axis: tokens
- Sorted descending
- Single color (blue-500)
- Show formatted token value at end of each bar

**Right: Top Users by Skill Uses**

- Recharts `<BarChart>` horizontal
- Y-axis: user names, X-axis: skill use count
- Sorted descending
- Single color (emerald-500)

### Section 3: Skills Distribution (full width)

- Recharts `<BarChart>` vertical
- X-axis: all 15 skill names
- Y-axis: total usage count (summed across all users)
- Bars color-coded by skill category:
  - **Blue** (`#3b82f6`): Workflow — clarify, plan, execute, test, code-review
  - **Green** (`#10b981`): Standalone — fix, figma, compare, research, understand
  - **Purple** (`#8b5cf6`): Standards — liquid-standards, section-standards, css-standards, js-standards, theme-architecture
- Legend at top showing the 3 categories
- Skills with 0 uses still shown (to visualize adoption gaps)

### Section 4: Model Distribution

- Recharts `<PieChart>` with inner label showing total sessions
- One slice per model (e.g., `claude-opus-4-6`, `claude-sonnet-4-6`)
- Aggregated from all users' `models` maps
- Custom tooltip showing: model name, session count, percentage
- Colors: distinct per model (e.g., orange for opus, blue for sonnet)

### Section 5: Projects Overview (full width table)

| Project | Tokens | Skill Uses | Sessions | Active Users |
|---|---|---|---|---|
| mokobara-old | 1.2B | 234 | 56 | 4 |
| vediclab | 800M | 178 | 43 | 3 |
| analyticx | 450M | 112 | 28 | 2 |

- Aggregated from all users' `projects` maps
- **Active Users** = count of users who have that project in their map
- Sorted by tokens descending

### Section 6: Users Table (full width, bottom)

| Name | Sessions | Tokens | Skill Uses | Last Active |
|---|---|---|---|---|
| Aditya Pasikanti | 47 | 892M | 156 | Today |
| Priya Sharma | 23 | 412M | 89 | Yesterday |
| Rahul Kumar | 11 | 198M | 34 | Apr 5 |

- Sortable by any column (click header to toggle asc/desc)
- Click row → navigates to `/claude-analytics/users/[user_email]`
- Last Active shows relative time (Today, Yesterday, Apr 5, etc.)

---

## Page 2: User Detail (`/claude-analytics/users/[user_email]`)

Fetches `GET /api/claude-analytics/users/[user_email]`.

### Section 1: Header + Summary Cards

```
← Back to Dashboard

Aditya Pasikanti
aditya@devxlabs.ai

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Sessions    │  │  Tokens      │  │  Skill Uses  │
│     47       │  │    892M      │  │     156      │
└──────────────┘  └──────────────┘  └──────────────┘
```

- Back link returns to `/claude-analytics`
- User name as heading, email as subtitle
- Three summary cards

### Section 2: Skills Breakdown (two columns)

**Left: Bar Chart**

- Recharts `<BarChart>` vertical
- X-axis: skill names, Y-axis: count
- Bars color-coded by category (blue/green/purple — same as team dashboard)
- Only shows skills with count > 0
- Tooltip shows skill name + count

**Right: Table**

| Skill | Category | Uses |
|---|---|---|
| **Workflow** | | |
| clarify | Workflow | 23 |
| plan | Workflow | 18 |
| execute | Workflow | 15 |
| test | Workflow | 10 |
| code-review | Workflow | 8 |
| **Standalone** | | |
| research | Standalone | 12 |
| fix | Standalone | 9 |
| figma | Standalone | 7 |
| ... | ... | ... |

- Grouped by category with group headers
- Sorted by count descending within each group
- Skills with 0 uses are hidden

### Section 3: Models Used (two columns)

**Left: Pie Chart**

- Recharts `<PieChart>`
- One slice per model
- Percentage label on each slice
- Center label: total sessions count

**Right: Table**

| Model | Sessions | % |
|---|---|---|
| claude-sonnet-4-6 | 35 | 74% |
| claude-opus-4-6 | 12 | 26% |

### Section 4: Projects (full width table)

| Project | Tokens | Skill Uses | Sessions |
|---|---|---|---|
| mokobara-old | 500M | 45 | 12 |
| vediclab | 280M | 67 | 23 |
| analyticx | 112M | 44 | 12 |

- From the user's `projects` map
- Sorted by tokens descending

---

## Navigation

Add "Claude Analytics" to the existing sidebar component.

- **Icon:** `BarChart3` from `lucide-react`
- **Label:** "Claude Analytics"
- **Position:** New section in sidebar
- **Visibility:** Only shown for users with role `ADMIN` or `SUPERADMIN`
- **Active state:** Highlighted when on `/claude-analytics` or `/claude-analytics/*`

---

## Shared Components

### `StatCard`

Reusable card for summary numbers.

**Props:** `label` (string), `value` (string | number), `icon` (optional Lucide icon)

### `TokenDisplay`

Formats raw token numbers to human-readable:
- < 1,000 → as-is (e.g., `847`)
- < 1,000,000 → K (e.g., `892K`)
- < 1,000,000,000 → M (e.g., `892M`)
- >= 1,000,000,000 → B (e.g., `3.2B`)

### `RelativeTime`

Formats ISO timestamp to relative display:
- Same day → "Today"
- Yesterday → "Yesterday"
- Within 7 days → "3 days ago"
- Older → "Apr 5" (short date)

### `SkillCategoryColor`

Maps skill names to their category color:
- Workflow skills → `#3b82f6` (blue)
- Standalone skills → `#10b981` (green)
- Standards skills → `#8b5cf6` (purple)

---

## Responsive Behavior

| Breakpoint | Layout |
|---|---|
| Desktop (>= 1024px) | Summary cards in 4-column row. Charts in 2-column grid. |
| Tablet (768–1023px) | Summary cards in 2x2 grid. Charts stack to single column. |
| Mobile (< 768px) | Summary cards stack vertically. Charts full width. Tables scroll horizontally. |

---

## File Structure

```
src/
├── app/
│   ├── claude-analytics/
│   │   ├── page.tsx                    # Team Dashboard
│   │   └── users/
│   │       └── [user_email]/
│   │           └── page.tsx            # User Detail
│   └── api/
│       └── claude-analytics/
│           ├── users/
│           │   └── route.ts            # Proxy → Lambda GET /analytics/users
│           └── users/
│               └── [user_email]/
│                   └── route.ts        # Proxy → Lambda GET /analytics/users/{user}
├── components/
│   └── claude-analytics/
│       ├── StatCard.tsx
│       ├── UsersTable.tsx
│       ├── SkillsBarChart.tsx
│       ├── ModelsPieChart.tsx
│       ├── TopUsersChart.tsx
│       ├── ProjectsTable.tsx
│       └── UserSkillsBreakdown.tsx
└── lib/
    └── claude-analytics/
        ├── types.ts                    # TypeScript interfaces for API responses
        ├── formatTokens.ts             # Token formatting utility
        ├── formatTime.ts               # Relative time utility
        └── skillCategories.ts          # Skill → category/color mapping
```

---

## Implementation Order

1. Create `lib/claude-analytics/` — types, utilities, skill category mapping
2. Create API routes (`/api/claude-analytics/users`, `/api/claude-analytics/users/[user_email]`)
3. Build shared components — `StatCard`, `UsersTable`, `ProjectsTable`
4. Build chart components — `SkillsBarChart`, `ModelsPieChart`, `TopUsersChart`
5. Build Team Dashboard page (`/claude-analytics/page.tsx`)
6. Build User Detail page (`/claude-analytics/users/[user_email]/page.tsx`)
7. Add sidebar navigation entry
8. Test with real data from DynamoDB

---

## Verification

1. Open `/claude-analytics` → summary cards show correct aggregated numbers
2. Skills bar chart → all 15 skills visible, color-coded by category
3. Models pie chart → shows correct distribution
4. Click a user row → navigates to user detail page
5. User detail → skills, models, projects match the user's DynamoDB record
6. Non-admin user → cannot access `/claude-analytics` (redirected or 403)
7. Mobile view → layouts stack correctly, tables scroll horizontally
