# Preflight run log

Every `/preflight` run is archived locally and sent to one shared Supabase (Postgres) project, so the skill can be improved from real runs: which checks raise false alarms, which never fire, why checks get skipped, how long each checker takes, what slips through to post-merge, and what users say it missed.

## How data flows

```
run-preflight.mjs ──(baseline, or a previous run that was never finalized)──┐
finalize-preflight.mjs ──(every finalized run)──────────────────────────────┤
record-feedback.mjs ──(the user's answer to "did preflight miss anything?")─┤
                                                                            ▼
            lib/telemetry.mjs: scrub → archive to .buildspace/preflight/runs/ → POST
                                                                            ▼
     Supabase  public.ingest_preflight_run(payload)  /  public.record_preflight_feedback(run_id, text)
                                                                            ▼
                   preflight.runs · layers · checks · findings · metrics  (+ analysis views)
```

- Sending uses the project's **publishable** key, which is public by design. It can only call the two functions above; it cannot read, change or delete any row (the tables live in the `preflight` schema, which the Data API does not expose).
- A send that fails (offline, timeout, server error) is queued in `.buildspace/preflight/pending/` and retried at the start of the next run. One the server rejects as invalid goes to `.buildspace/preflight/rejected/` with the reason.
- Re-running finalize for the same run (e.g. after adding a `config.accepted` sign-off) replaces that run in the log and keeps its feedback.
- Nothing here can change a verdict or an exit code.

## What is sent

| Group | Fields |
|---|---|
| Run | run id, mode, stage (finalized / detect-only / baseline), start, finish, duration, overall verdict |
| Versions | toolkit version (`plugin.json`), preflight version (`scripts/package.json`), Node, OS, CI flag |
| Who and where | git user email and name, project (git remote name), store domain, theme ids, pages tested |
| Git | live and staging refs and SHAs, number of changed files |
| Layers | per checker: raw and final status, duration, crashed, error |
| Checks | every check: id, name, priority, status (PASS / FAIL / SKIPPED / INFO / DISMISSED / ACCEPTED), summary |
| Findings | every candidate: check, priority before and after verification, item (file, line, rule), verifier verdict, reason and evidence, accepted |
| Metrics | performance medians per page, side (live / preview / baseline) and metric (LCP, FCP, TBT, CLS), runs, excluded runs |
| Detail | full checker reports, verifier problems, skipped checks, config (minus secrets) in `runs.data` |
| Feedback | the user's answer, verbatim |

## What is never sent

- Passwords, tokens, cookies, API keys, authorization headers (any key matching those names is replaced by `[redacted]`).
- Shopper data: email, phone, client / user / customer ids, names, addresses, IPs, `_ga` / `fbp` / `fbc`. Analytics events are already reduced to their key names by the checker; email addresses anywhere in text become `[email]`.
- URL query strings, except `preview_theme_id`, `pb`, `view`, `variant`, `page`, `sort_by`; token-like path segments (e.g. checkout tokens) become `:token`.
- Home-folder paths (shortened to `~`).
- Screenshots, full Lighthouse reports, traces and source code. These stay in the local run folder only.
- Strings longer than 4,000 characters are cut, and a run over ~1.8 MB has its largest evidence trimmed.

## Turning it off

- Per machine: `export PREFLIGHT_TELEMETRY=0`
- Per project (e.g. a client whose contract forbids it): `"telemetry": { "enabled": false }` in `.buildspace/preflight/preflight.config.json`

Local history is always kept.

## Settings

| Env var | Default | Purpose |
|---|---|---|
| `PREFLIGHT_SUPABASE_URL` | the toolkit's project | send to a different Supabase project |
| `PREFLIGHT_SUPABASE_KEY` | the toolkit's publishable key | its publishable key |
| `PREFLIGHT_KEEP_RUNS` | 20 | local run folders kept per project |
| `PREFLIGHT_TELEMETRY` | on | `0` turns sending off |
| `PREFLIGHT_DEPS_DIR` | `$CLAUDE_PLUGIN_DATA/preflight-deps` or `~/.cache/shopify-theme-toolkit/preflight-deps` | where Playwright / Lighthouse are installed |

## Setting up a Supabase project

Only needed for a new project (the toolkit's is already set up).

1. Create a project. Keep **Enable Data API** on, turn **Automatically expose new tables** off, turn **Enable automatic RLS** on.
2. SQL Editor → paste `supabase-setup.sql` → Run. It's safe to re-run, and must be re-run after it changes.
3. Put the project URL and publishable key (`sb_publishable_…`) in `lib/telemetry.mjs` (`DEFAULT_URL`, `DEFAULT_KEY`) or the env vars above. Never use the secret key here.

Moving the project to another Supabase organization (Project Settings → General → Transfer project) keeps its URL and keys, so nothing in the plugin changes.

## Reading the data

In Supabase: **Table Editor** → schema `preflight`, or **SQL Editor**:

| View | Answers |
|---|---|
| `preflight.check_accuracy` | false-alarm %, confirmed, unverified and accepted per check: which checks to tighten |
| `preflight.check_activity` | how often each check passes, fails or is skipped: checks that never fire |
| `preflight.skip_reasons` | why checks are skipped, most common first: setup and environment gaps |
| `preflight.layer_health` | crashes, incomplete runs, average and max duration per checker |
| `preflight.post_merge_findings` | open findings from post-merge runs: what pre-merge missed |
| `preflight.feedback` | every answer to "did preflight miss anything?" |
| `preflight.by_version` | runs and verdicts per toolkit / preflight version: did a change help |
| `preflight.recent_runs` | the latest runs |

Example:

```sql
select * from preflight.check_accuracy where findings >= 5 order by false_alarm_pct desc;
```

For one machine's runs without Supabase access:

```bash
node skills/preflight/scripts/analyze-runs.mjs --root <theme repo> [--root <another>] [--since 2026-10-01]
```

## Deleting data

Run in the SQL Editor (deleting a run removes its layers, checks, findings and metrics):

```sql
delete from preflight.runs where project = '<project>';
delete from preflight.runs where received_at < now() - interval '1 year';
```
