-- Apply AFTER company-history.sql and company-collector.sql, including on reapply.
-- Public opening results only. No member data or provider credentials are stored.
-- This migration deliberately does NOT schedule the worker: deploy archive=1's
-- 15-call maximum first, then enable the cron command described at the end.
begin;

alter table public.bid_archive_notices add column if not exists source_kind text not null default 'standard'
  check (source_kind in ('standard','opening'));
alter table public.bid_archive_entries add column if not exists source_kind text not null default 'standard'
  check (source_kind in ('standard','opening'));
create index if not exists bid_archive_notices_identity_idx
  on public.bid_archive_notices(type,number,revision);

create table if not exists public.bid_archive_opening_snapshots (
  type text not null check (type in ('공사','용역')),
  number text not null check (number ~ '^[A-Za-z0-9]{8,20}$'),
  revision text not null check (revision ~ '^[0-9]{3}$'),
  -- Completeness applies only to this notice/revision, never all company history.
  complete boolean not null default false,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now(),
  last_identity_digest text,
  primary key(type,number,revision)
);
alter table public.bid_archive_opening_snapshots enable row level security;
revoke all on public.bid_archive_opening_snapshots from public,anon,authenticated;
grant select on public.bid_archive_opening_snapshots to anon,authenticated;
drop policy if exists bid_archive_opening_snapshots_read on public.bid_archive_opening_snapshots;
create policy bid_archive_opening_snapshots_read on public.bid_archive_opening_snapshots
  for select to anon,authenticated using(true);

create or replace view public.bid_archive_effective_entries with (security_invoker=true) as
  select e.* from public.bid_archive_entries e
  join public.bid_archive_notices n on n.id=e.notice_id
  where not e.archived and (e.source_kind='opening' or not exists (
    select 1 from public.bid_archive_opening_snapshots s
    where s.type=n.type and s.number=n.number and s.revision=n.revision and s.complete
  ));
revoke all on public.bid_archive_effective_entries from public,anon,authenticated;
grant select on public.bid_archive_effective_entries to anon,authenticated;

create table if not exists bid_archive_private.notice_jobs (
  type text not null check (type in ('공사','용역')),
  number text not null check (number ~ '^[A-Za-z0-9]{8,20}$'),
  revision text not null check (revision ~ '^[0-9]{3}$'),
  queued_at timestamptz not null default now(), completed_at timestamptz,
  request_id bigint, requested_at timestamptz,
  next_attempt timestamptz not null default now(),
  failures integer not null default 0, last_error text,
  primary key(type,number,revision)
);
create index if not exists bid_archive_notice_jobs_pending_idx
  on bid_archive_private.notice_jobs(next_attempt,queued_at) where completed_at is null;
alter table bid_archive_private.notice_jobs enable row level security;
revoke all on bid_archive_private.notice_jobs from public,anon,authenticated;

create or replace function bid_archive_private.ingest_opening(p_body jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  typ text; num text; rev text; fetched timestamptz;
  g jsonb; p jsonb; notice_id text; entry_id text; bidder text;
  opening_at timestamptz; bidding_at timestamptz; amount numeric; rate numeric;
  winner text; award boolean; winner_amount numeric; declared integer;
  total integer:=0; ids text[]:='{}'; group_ids text[]:='{}'; digest text;
  fully_covered boolean:=true; previous public.bid_archive_opening_snapshots%rowtype;
  have_previous boolean; confirmed boolean; archived_count integer:=0;
begin
  if jsonb_typeof(p_body) is distinct from 'object'
    or p_body->'complete' is distinct from 'true'::jsonb
    or p_body->'warnings' is distinct from '[]'::jsonb
    or jsonb_typeof(p_body->'groups') is distinct from 'array'
    or jsonb_typeof(p_body->'participantCount') is distinct from 'number'
    or coalesce(p_body->>'participantCount','') !~ '^[0-9]+$' then
    raise exception 'Incomplete or malformed opening response';
  end if;
  typ:=p_body->>'type'; num:=p_body->>'number'; rev:=p_body->>'revision';
  if typ is null or typ not in ('공사','용역') or num is null or num !~ '^[A-Za-z0-9]{8,20}$'
    or rev is null or rev !~ '^[0-9]{3}$'
    or jsonb_typeof(p_body->'fetchedAt') is distinct from 'string'
    or coalesce(p_body->>'fetchedAt','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'Invalid opening response identity';
  end if;
  fetched:=(p_body->>'fetchedAt')::timestamptz;
  if not isfinite(fetched) or fetched>now()+interval '5 minutes' then raise exception 'Invalid fetched timestamp'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bid-opening:'||typ||':'||num||':'||rev,0));
  select * into previous from public.bid_archive_opening_snapshots s
    where s.type=typ and s.number=num and s.revision=rev for update;
  have_previous:=found;
  if have_previous and fetched<previous.fetched_at then
    return jsonb_build_object('status','stale','stored',0,'complete',previous.complete);
  end if;

  -- Validate and write in one transaction. Any malformed later group rolls back
  -- ALL earlier upserts. Only explicitly allowlisted public fields are written.
  for g in select value from jsonb_array_elements(p_body->'groups') loop
    if jsonb_typeof(g) is distinct from 'object'
      or jsonb_typeof(g->'classification') is distinct from 'string'
      or coalesce(g->>'classification','') !~ '^[0-9]{1,10}$'
      or jsonb_typeof(g->'rebid') is distinct from 'string'
      or coalesce(g->>'rebid','') !~ '^[0-9]{1,10}$'
      or jsonb_typeof(g->'participants') is distinct from 'array'
      or jsonb_typeof(g->'title') is distinct from 'string'
      or jsonb_typeof(g->'agency') is distinct from 'string'
      or jsonb_typeof(g->'openingAt') is distinct from 'string'
      or jsonb_typeof(g->'winnerBusinessNumber') is distinct from 'string'
      or jsonb_typeof(g->'winningAmount') not in ('null','number')
      or not (g ? 'winningAmount') then raise exception 'Malformed opening group'; end if;
    notice_id:='opening:'||typ||':'||num||':'||rev||':'||(g->>'classification')||':'||(g->>'rebid');
    if g->>'id' is distinct from substring(notice_id from 9) or notice_id=any(group_ids) then
      raise exception 'Duplicate or mismatched opening group identity';
    end if;
    group_ids:=array_append(group_ids,notice_id);
    opening_at:=null;
    if g->>'openingAt'<>'' then
      if g->>'openingAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Opening timestamp requires timezone'; end if;
      opening_at:=(g->>'openingAt')::timestamptz;
      if not isfinite(opening_at) then raise exception 'Invalid opening timestamp'; end if;
    end if;
    if not (g ? 'participantCount') or jsonb_typeof(g->'participantCount') not in ('null','number')
      or (g->>'participantCount' is not null and g->>'participantCount' !~ '^[0-9]+$') then
      raise exception 'Invalid group participant count';
    end if;
    declared:=(g->>'participantCount')::integer;
    -- Some rebid responses return only the latest participant list, although an
    -- older group advertises a positive count. Save available rows, but never
    -- suppress standard records or reconcile missing rows from that response.
    if declared is not null and declared<>jsonb_array_length(g->'participants') then fully_covered:=false; end if;
    winner:=g->>'winnerBusinessNumber';
    if winner<>'' and winner !~ '^[0-9]{10}$' then raise exception 'Invalid winner business number'; end if;
    winner_amount:=(g->>'winningAmount')::numeric;
    if winner_amount<0 then raise exception 'Negative winning amount'; end if;
    insert into public.bid_archive_notices(id,number,revision,type,title,agency,opening_at,participant_count,source_kind)
      values(notice_id,num,rev,typ,g->>'title',g->>'agency',opening_at,declared,'opening')
      on conflict(id) do update set title=excluded.title,agency=excluded.agency,
        opening_at=excluded.opening_at,participant_count=excluded.participant_count;
    for p in select value from jsonb_array_elements(g->'participants') loop
      if jsonb_typeof(p) is distinct from 'object'
        or jsonb_typeof(p->'businessNumber') is distinct from 'string'
        or coalesce(p->>'businessNumber','') !~ '^[0-9]{10}$'
        or jsonb_typeof(p->'companyName') is distinct from 'string'
        or jsonb_typeof(p->'rank') is distinct from 'string'
        or jsonb_typeof(p->'biddingAt') is distinct from 'string'
        or not (p ?& array['bidAmount','bidRate','awarded'])
        or jsonb_typeof(p->'bidAmount') not in ('null','number')
        or jsonb_typeof(p->'bidRate') not in ('null','number')
        or jsonb_typeof(p->'awarded') not in ('null','boolean') then raise exception 'Malformed opening participant'; end if;
      bidder:=p->>'businessNumber'; amount:=(p->>'bidAmount')::numeric; rate:=(p->>'bidRate')::numeric;
      award:=(p->>'awarded')::boolean; bidding_at:=null;
      if amount<0 then raise exception 'Negative bid amount'; end if;
      if p->>'biddingAt'<>'' then
        if p->>'biddingAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Bid timestamp requires timezone'; end if;
        bidding_at:=(p->>'biddingAt')::timestamptz;
        if not isfinite(bidding_at) then raise exception 'Invalid bid timestamp'; end if;
      end if;
      -- UTC epoch makes the ID independent of the SQL session timezone. Amount
      -- is deliberately excluded: an updated amount updates the same bid record.
      entry_id:='opening:'||md5(jsonb_build_array(notice_id,bidder,extract(epoch from bidding_at))::text);
      if entry_id=any(ids) then raise exception 'Duplicate opening participant identity'; end if;
      ids:=array_append(ids,entry_id); total:=total+1;
      insert into public.bid_archive_companies(business_number,name,updated_at)
        values(bidder,p->>'companyName',now()) on conflict(business_number) do update
        set name=coalesce(nullif(excluded.name,''),public.bid_archive_companies.name),updated_at=now();
      insert into public.bid_archive_entries(id,notice_id,business_number,bidding_at,bid_amount,bid_rate,rank,awarded,winning_amount,source_kind)
        values(entry_id,notice_id,bidder,bidding_at,amount,rate,p->>'rank',award,
          case when award is true and winner=bidder then winner_amount else null end,'opening')
        on conflict(id) do update set bid_amount=excluded.bid_amount,bid_rate=excluded.bid_rate,
          rank=excluded.rank,awarded=excluded.awarded,winning_amount=excluded.winning_amount,archived=false,updated_at=now();
    end loop;
  end loop;
  if total<>(p_body->>'participantCount')::integer then raise exception 'Opening participant total mismatch'; end if;
  if total=0 then
    -- A successful empty response is not evidence that previously public bids
    -- disappeared. Preserve every previous record and source preference.
    return jsonb_build_object('status','empty','stored',0,'complete',false);
  end if;
  select md5(string_agg(v,',' order by v)) into digest from unnest(ids) as x(v);
  confirmed:=fully_covered and have_previous and previous.last_identity_digest=digest
    and fetched>previous.fetched_at;
  if confirmed then
    update public.bid_archive_entries e set archived=true,updated_at=now()
      from public.bid_archive_notices n where n.id=e.notice_id
      and n.type=typ and n.number=num and n.revision=rev and n.source_kind='opening'
      and e.source_kind='opening' and not e.archived and not (e.id=any(ids));
    get diagnostics archived_count=row_count;
  end if;
  insert into public.bid_archive_opening_snapshots(type,number,revision,complete,fetched_at,last_identity_digest)
    values(typ,num,rev,fully_covered,fetched,case when fully_covered then digest else null end)
    on conflict(type,number,revision) do update set
      -- A newly added rebid may be absent from the precise participant response.
      -- Preserve old opening rows, but restore standard-source visibility until
      -- the CURRENT set of groups is complete again.
      complete=excluded.complete,
      fetched_at=excluded.fetched_at,updated_at=now(),last_identity_digest=excluded.last_identity_digest;
  return jsonb_build_object('status',case when fully_covered then 'stored' else 'partial' end,
    'stored',total,'complete',fully_covered,'archived',archived_count);
end $$;

-- Patch only the two read sources. Reapplying is harmless; fail loudly if the
-- installed function differs rather than silently leaving one source unpatched.
do $$
declare definition text;
begin
  select pg_get_functiondef('public.bid_company_history(text,date,date,integer,integer,text)'::regprocedure) into definition;
  definition:=replace(definition,'public.bid_archive_entries e','public.bid_archive_effective_entries e');
  if position('from public.bid_archive_effective_entries e' in definition)=0
    or position('join public.bid_archive_effective_entries e' in definition)=0 then
    raise exception 'Company history function needs manual source review';
  end if;
  execute definition;
  select pg_get_functiondef('bid_archive_private.ingest(text,date,integer,jsonb)'::regprocedure) into definition;
  if position('e.source_kind=''standard'' and nt.source_kind=''standard''' in definition)=0 then
    if position('where e.notice_id=nt.id and nt.type=p_type' in definition)=0 then
      raise exception 'Daily ingest function needs manual source review';
    end if;
    definition:=replace(definition,'where e.notice_id=nt.id and nt.type=p_type',
      'where e.notice_id=nt.id and e.source_kind=''standard'' and nt.source_kind=''standard'' and nt.type=p_type');
    execute definition;
  end if;
end $$;

-- This narrowly scoped definer accepts identifiers only. Callers cannot write
-- source rows, URLs, settings, payloads, or any private/member data.
create or replace function public.bid_queue_opening_notice(p_type text,p_number text,p_revision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j bid_archive_private.notice_jobs%rowtype; recent timestamptz;
begin
  if p_type is null or p_type not in ('공사','용역') or p_number is null or p_number !~ '^[A-Za-z0-9]{8,20}$'
    or p_revision is null or p_revision !~ '^[0-9]{3}$' then raise exception 'Invalid public notice identifier' using errcode='22023'; end if;
  -- Serialize the queue cap and new inserts, not the slower HTTP worker.
  perform pg_advisory_xact_lock(62614002);
  select * into j from bid_archive_private.notice_jobs
    where type=p_type and number=p_number and revision=p_revision for update;
  if found then
    if j.completed_at is null then return jsonb_build_object('status','pending','queued',false); end if;
    if j.next_attempt>now() then return jsonb_build_object('status','deferred','queued',false); end if;
    if j.completed_at>now()-interval '5 minutes' then return jsonb_build_object('status','cached','queued',false); end if;
  end if;
  select s.updated_at into recent from public.bid_archive_opening_snapshots s
    where s.type=p_type and s.number=p_number and s.revision=p_revision and s.complete;
  if recent>now()-interval '5 minutes' then return jsonb_build_object('status','cached','queued',false); end if;
  if (select count(*) from bid_archive_private.notice_jobs where completed_at is null)>=1000 then
    return jsonb_build_object('status','full','queued',false);
  end if;
  insert into bid_archive_private.notice_jobs(type,number,revision) values(p_type,p_number,p_revision)
    on conflict(type,number,revision) do update set queued_at=now(),completed_at=null,
      request_id=null,requested_at=null,next_attempt=now(),failures=0,last_error=null;
  return jsonb_build_object('status','queued','queued',true);
end $$;
revoke all on function public.bid_queue_opening_notice(text,text,text) from public,anon,authenticated;
grant execute on function public.bid_queue_opening_notice(text,text,text) to anon,authenticated;

create or replace function bid_archive_private.tick_openings()
returns void language plpgsql security invoker set search_path='' as $$
declare cfg bid_archive_private.settings%rowtype; j bid_archive_private.notice_jobs%rowtype;
  r record; b jsonb; result jsonb; reqid bigint;
  today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  -- Same lock and settings row as the daily collector: a shared quota, never a
  -- second allowance. Each launch conservatively reserves all 5*3 API calls.
  if not pg_try_advisory_xact_lock(62614001) then return; end if;
  select * into strict cfg from bid_archive_private.settings where singleton for update;
  if not cfg.enabled then return; end if;
  if cfg.calls_day is distinct from today then
    update bid_archive_private.settings set calls_day=today,calls=0 where singleton;
    cfg.calls:=0;
  end if;
  -- Do not ingest or request additional data beyond the existing storage cap.
  if pg_database_size(current_database())>=cfg.storage_ceiling then return; end if;
  for j in select * from bid_archive_private.notice_jobs where request_id is not null loop
    begin
      select status_code,content,timed_out,error_msg into r from net._http_response where id=j.request_id;
      if not found then
        if j.requested_at>now()-interval '3 minutes' then continue; end if;
        raise exception 'Opening proxy response expired';
      end if;
      if r.status_code is distinct from 200 or r.timed_out is true or r.error_msg is not null then
        raise exception 'Opening proxy response not successful';
      end if;
      b:=r.content::jsonb;
      if b->>'type' is distinct from j.type or b->>'number' is distinct from j.number
        or b->>'revision' is distinct from j.revision then raise exception 'Opening proxy identity mismatch'; end if;
      if b->'archiveLimitExceeded'='true'::jsonb then
        -- Repeating the same capped request cannot recover the missing pages.
        -- The interactive endpoint remains available; defer background work for
        -- at least a day, including fresh anonymous enqueue attempts.
        update bid_archive_private.notice_jobs set request_id=null,requested_at=null,
          completed_at=now(),next_attempt=now()+interval '1 day',
          last_error='Participant pagination exceeds background budget; deferred'
          where type=j.type and number=j.number and revision=j.revision;
        delete from net._http_response where id=j.request_id;
        continue;
      end if;
      result:=bid_archive_private.ingest_opening(b);
      update bid_archive_private.notice_jobs set request_id=null,requested_at=null,
        completed_at=case when result->>'status'='partial' then null else now() end,
        next_attempt=case when result->>'status'='partial' then now()+interval '1 day' else now() end,
        failures=case when result->>'status'='partial' then failures+1 else 0 end,
        last_error=case when result->>'status'='partial' then 'Provider omitted participants from an older opening group' else null end
        where type=j.type and number=j.number and revision=j.revision;
      delete from net._http_response where id=j.request_id;
    exception when others then
      update bid_archive_private.notice_jobs set request_id=null,requested_at=null,failures=failures+1,
        next_attempt=now()+make_interval(secs=>case when failures>=3 then 86400 else 300*power(2,failures)::integer end),
        last_error=left(sqlerrm,200) where type=j.type and number=j.number and revision=j.revision;
      delete from net._http_response where id=j.request_id;
    end;
  end loop;
  if cfg.calls+15>cfg.daily_budget then return; end if;
  -- At most ONE in-flight request, so slow/missing responses cannot pile up.
  if exists(select 1 from bid_archive_private.notice_jobs where request_id is not null) then return; end if;
  select * into j from bid_archive_private.notice_jobs
    where completed_at is null and request_id is null and next_attempt<=now()
    order by next_attempt,queued_at,type,number,revision limit 1 for update;
  if not found then return; end if;
  reqid:=net.http_get(url:='https://construction-bid-nine.vercel.app/api/opening-results',
    params:=jsonb_build_object('type',j.type,'number',j.number,'revision',j.revision,'archive','1'),timeout_milliseconds:=55000);
  update bid_archive_private.notice_jobs set request_id=reqid,requested_at=now()
    where type=j.type and number=j.number and revision=j.revision;
  update bid_archive_private.settings set calls=calls+15 where singleton;
end $$;
revoke all on all functions in schema bid_archive_private from public,anon,authenticated;
revoke all on all tables in schema bid_archive_private from public,anon,authenticated;

commit;
-- AFTER deploy + rollback tests + a verified ingest, the administrator may run:
-- select cron.schedule('bid-company-opening-archive','* * * * *',
--   'select bid_archive_private.tick_openings()');
-- Existing settings.enabled, daily_budget and storage_ceiling are unchanged.
