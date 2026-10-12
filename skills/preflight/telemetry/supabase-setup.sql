-- Preflight telemetry: one-time setup for the Supabase project.
-- Run once in Supabase › SQL Editor. Safe to re-run.
--
-- Security model
--   * Tables and views live in the `preflight` schema, which the Data API does not expose,
--     so the publishable key cannot read, change or delete any row.
--   * The publishable key (role `anon`) can call exactly two functions:
--     public.ingest_preflight_run(payload jsonb) validates a run and stores it with its layers,
--     checks, findings and metrics in one transaction. Sending the same run_id again (a retry,
--     or finalize re-run after a sign-off) replaces that run and keeps its feedback.
--     public.record_preflight_feedback(p_run_id uuid, p_feedback text) appends the user's
--     answer to "did preflight miss or misjudge anything?" to an existing run.
--   * Reading is done from the dashboard (Table Editor / SQL Editor) or with the secret key.

create schema if not exists preflight;
revoke all on schema preflight from public, anon, authenticated;

create table if not exists preflight.runs (
  run_id             uuid primary key,
  received_at        timestamptz not null default now(),
  schema_version     int not null,
  mode               text not null check (mode in ('pre-merge', 'post-merge', 'baseline')),
  started_at         timestamptz,
  finished_at        timestamptz,
  duration_ms        int,
  overall            text check (overall in ('GREEN', 'YELLOW', 'RED', 'INCOMPLETE')),
  toolkit_version    text,
  preflight_version  text,
  user_email         text,
  user_name          text,
  project            text,
  store_domain       text,
  live_ref           text,
  live_sha           text,
  staging_ref        text,
  staging_sha        text,
  changed_files      int,
  feedback           text,
  data               jsonb not null
);

create table if not exists preflight.layers (
  run_id       uuid not null references preflight.runs (run_id) on delete cascade,
  layer        text not null,
  raw_status   text,
  final_status text,
  duration_ms  int,
  crashed      boolean not null default false,
  error        text,
  primary key (run_id, layer)
);

create table if not exists preflight.checks (
  run_id     uuid not null references preflight.runs (run_id) on delete cascade,
  layer      text not null,
  check_id   text not null,
  check_name text,
  priority   text,
  status     text not null,
  summary    text,
  primary key (run_id, layer, check_id)
);

create table if not exists preflight.findings (
  id                bigint generated always as identity primary key,
  run_id            uuid not null references preflight.runs (run_id) on delete cascade,
  item_id           text,
  layer             text not null,
  check_id          text not null,
  check_name        text,
  priority          text,
  summary           text,
  item              jsonb,
  verdict           text check (verdict in ('confirmed', 'false_alarm', 'unverified')),
  verdict_reason    text,
  verdict_evidence  text,
  accepted          boolean not null default false,
  added_by_verifier boolean not null default false
);

create table if not exists preflight.metrics (
  run_id   uuid not null references preflight.runs (run_id) on delete cascade,
  page     text not null,
  side     text not null,
  metric   text not null,
  value    double precision,
  runs     int,
  excluded int,
  primary key (run_id, page, side, metric)
);

create index if not exists findings_check_idx on preflight.findings (layer, check_id);
create index if not exists checks_check_idx on preflight.checks (layer, check_id);
create index if not exists runs_project_idx on preflight.runs (project, received_at desc);

alter table preflight.runs     enable row level security;
alter table preflight.layers   enable row level security;
alter table preflight.checks   enable row level security;
alter table preflight.findings enable row level security;
alter table preflight.metrics  enable row level security;

revoke all on all tables in schema preflight from public, anon, authenticated;
alter default privileges in schema preflight revoke all on tables from public, anon, authenticated;

create or replace function public.ingest_preflight_run(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_old_feedback text;
  v_replaced boolean := false;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload must be a JSON object';
  end if;
  if octet_length(payload::text) > 2000000 then
    raise exception 'payload larger than 2 MB';
  end if;
  if (payload ->> 'schema_version') is null or (payload ->> 'schema_version') !~ '^\d+$' then
    raise exception 'schema_version is required';
  end if;
  if coalesce(payload ->> 'run_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'run_id must be a uuid';
  end if;
  if coalesce(jsonb_array_length(case when jsonb_typeof(payload -> 'findings') = 'array' then payload -> 'findings' end), 0) > 5000
     or coalesce(jsonb_array_length(case when jsonb_typeof(payload -> 'checks') = 'array' then payload -> 'checks' end), 0) > 2000
     or coalesce(jsonb_array_length(case when jsonb_typeof(payload -> 'metrics') = 'array' then payload -> 'metrics' end), 0) > 5000 then
    raise exception 'too many rows in payload';
  end if;

  v_run_id := (payload ->> 'run_id')::uuid;

  select feedback into v_old_feedback from preflight.runs where run_id = v_run_id;
  if found then
    delete from preflight.runs where run_id = v_run_id;
    v_replaced := true;
  end if;

  insert into preflight.runs (
    run_id, schema_version, mode, started_at, finished_at, duration_ms, overall,
    toolkit_version, preflight_version, user_email, user_name, project, store_domain,
    live_ref, live_sha, staging_ref, staging_sha, changed_files, feedback, data
  ) values (
    v_run_id,
    (payload ->> 'schema_version')::int,
    payload ->> 'mode',
    (payload ->> 'started_at')::timestamptz,
    (payload ->> 'finished_at')::timestamptz,
    (payload ->> 'duration_ms')::int,
    payload ->> 'overall',
    left(payload ->> 'toolkit_version', 40),
    left(payload ->> 'preflight_version', 40),
    left(payload ->> 'user_email', 200),
    left(payload ->> 'user_name', 200),
    left(payload ->> 'project', 200),
    left(payload ->> 'store_domain', 200),
    left(payload ->> 'live_ref', 200),
    left(payload ->> 'live_sha', 64),
    left(payload ->> 'staging_ref', 200),
    left(payload ->> 'staging_sha', 64),
    (payload ->> 'changed_files')::int,
    coalesce(left(payload ->> 'feedback', 5000), v_old_feedback),
    payload
  );

  insert into preflight.layers (run_id, layer, raw_status, final_status, duration_ms, crashed, error)
  select v_run_id, l ->> 'layer', l ->> 'raw_status', l ->> 'final_status',
         (l ->> 'duration_ms')::int, coalesce((l ->> 'crashed')::boolean, false), left(l ->> 'error', 5000)
  from jsonb_array_elements(coalesce(payload -> 'layers', '[]')) l
  on conflict do nothing;

  insert into preflight.checks (run_id, layer, check_id, check_name, priority, status, summary)
  select v_run_id, c ->> 'layer', c ->> 'check_id', c ->> 'check_name', c ->> 'priority',
         c ->> 'status', left(c ->> 'summary', 5000)
  from jsonb_array_elements(coalesce(payload -> 'checks', '[]')) c
  on conflict do nothing;

  insert into preflight.findings (
    run_id, item_id, layer, check_id, check_name, priority, summary, item,
    verdict, verdict_reason, verdict_evidence, accepted, added_by_verifier
  )
  select v_run_id, f ->> 'item_id', f ->> 'layer', f ->> 'check_id', f ->> 'check_name', f ->> 'priority',
         left(f ->> 'summary', 5000), f -> 'item',
         f ->> 'verdict', left(f ->> 'verdict_reason', 5000), left(f ->> 'verdict_evidence', 5000),
         coalesce((f ->> 'accepted')::boolean, false), coalesce((f ->> 'added_by_verifier')::boolean, false)
  from jsonb_array_elements(coalesce(payload -> 'findings', '[]')) f;

  insert into preflight.metrics (run_id, page, side, metric, value, runs, excluded)
  select v_run_id, m ->> 'page', m ->> 'side', m ->> 'metric',
         (m ->> 'value')::double precision, (m ->> 'runs')::int, (m ->> 'excluded')::int
  from jsonb_array_elements(coalesce(payload -> 'metrics', '[]')) m
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'run_id', v_run_id, 'replaced', v_replaced);
end;
$$;

revoke all on function public.ingest_preflight_run(jsonb) from public;
grant execute on function public.ingest_preflight_run(jsonb) to anon, authenticated;

create or replace function public.record_preflight_feedback(p_run_id uuid, p_feedback text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_run_id is null or coalesce(btrim(p_feedback), '') = '' then
    raise exception 'run_id and feedback are required';
  end if;
  update preflight.runs
     set feedback = left(case when feedback is null or feedback = '' then btrim(p_feedback)
                              else feedback || E'\n---\n' || btrim(p_feedback) end, 20000)
   where run_id = p_run_id;
  if not found then
    raise exception 'run % not found', p_run_id;
  end if;
  return jsonb_build_object('ok', true, 'run_id', p_run_id);
end;
$$;

revoke all on function public.record_preflight_feedback(uuid, text) from public;
grant execute on function public.record_preflight_feedback(uuid, text) to anon, authenticated;

drop view if exists preflight.check_accuracy;
create view preflight.check_accuracy as
select f.layer, f.check_id, max(f.check_name) as check_name,
       count(*) as findings,
       count(*) filter (where f.verdict = 'confirmed') as confirmed,
       count(*) filter (where f.verdict = 'false_alarm') as false_alarms,
       count(*) filter (where f.verdict = 'unverified') as unverified,
       count(*) filter (where f.accepted) as accepted,
       round(100.0 * count(*) filter (where f.verdict = 'false_alarm') / nullif(count(*), 0), 1) as false_alarm_pct
from preflight.findings f
group by f.layer, f.check_id
order by false_alarm_pct desc nulls last, findings desc;

drop view if exists preflight.check_activity;
create view preflight.check_activity as
select c.layer, c.check_id, max(c.check_name) as check_name,
       count(*) as runs,
       count(*) filter (where c.status = 'FAIL') as failed,
       count(*) filter (where c.status = 'PASS') as passed,
       count(*) filter (where c.status = 'SKIPPED') as skipped
from preflight.checks c
group by c.layer, c.check_id
order by failed, skipped desc;

drop view if exists preflight.skip_reasons;
create view preflight.skip_reasons as
select c.layer, c.check_id, c.summary as reason, count(*) as times, max(r.received_at) as last_seen
from preflight.checks c
join preflight.runs r using (run_id)
where c.status = 'SKIPPED'
group by c.layer, c.check_id, c.summary
order by times desc;

drop view if exists preflight.layer_health;
create view preflight.layer_health as
select l.layer,
       count(*) as runs,
       count(*) filter (where l.crashed) as crashed,
       count(*) filter (where l.final_status = 'INCOMPLETE') as incomplete,
       round(avg(l.duration_ms) / 1000.0, 1) as avg_seconds,
       round(max(l.duration_ms) / 1000.0, 1) as max_seconds
from preflight.layers l
group by l.layer;

drop view if exists preflight.recent_runs;
create view preflight.recent_runs as
select r.received_at, r.mode, r.data -> 'data' ->> 'stage' as stage, r.overall, r.project, r.store_domain, r.user_email,
       r.toolkit_version, round(r.duration_ms / 1000.0, 1) as seconds, r.feedback, r.run_id
from preflight.runs r
order by r.received_at desc;

drop view if exists preflight.post_merge_findings;
create view preflight.post_merge_findings as
select r.received_at, r.project, f.layer, f.check_id, f.check_name, f.priority, f.summary, f.verdict, f.run_id
from preflight.findings f
join preflight.runs r using (run_id)
where r.mode = 'post-merge' and coalesce(f.verdict, 'unverified') <> 'false_alarm' and not f.accepted
order by r.received_at desc;

drop view if exists preflight.feedback;
create view preflight.feedback as
select r.received_at, r.project, r.user_email, r.mode, r.overall, r.feedback, r.run_id
from preflight.runs r
where coalesce(r.feedback, '') <> ''
order by r.received_at desc;

drop view if exists preflight.by_version;
create view preflight.by_version as
select r.toolkit_version, r.preflight_version, count(*) as runs,
       count(*) filter (where r.data -> 'data' ->> 'stage' = 'detect-only') as never_finalized,
       count(*) filter (where r.overall = 'INCOMPLETE') as incomplete,
       count(*) filter (where r.overall = 'RED') as red,
       count(*) filter (where r.overall = 'YELLOW') as yellow,
       count(*) filter (where r.overall = 'GREEN') as green,
       round(avg(r.duration_ms) / 60000.0, 1) as avg_minutes
from preflight.runs r
group by r.toolkit_version, r.preflight_version
order by r.toolkit_version desc nulls last;

revoke all on all tables in schema preflight from public, anon, authenticated;
