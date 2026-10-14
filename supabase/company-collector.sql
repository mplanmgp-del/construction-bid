-- Apply after company-history.sql. Collector runs as the cron owner (postgres).
-- It reads the application's public G2B proxy. No provider/service-role secret is
-- copied into SQL, cron, browser clients, or the public schema.
begin;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create schema if not exists bid_archive_private;
revoke all on schema bid_archive_private from public, anon, authenticated;

create table if not exists bid_archive_private.settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  daily_budget integer not null default 600 check(daily_budget between 1 and 5000),
  storage_ceiling bigint not null default 419430400,
  calls_day date,
  calls integer not null default 0
);
insert into bid_archive_private.settings(singleton) values(true) on conflict do nothing;
create table if not exists bid_archive_private.jobs (
  type text not null check(type in ('공사','용역')), day date not null,
  page integer not null default 1, expected_total integer,
  started_at timestamptz not null default now(), completed_at timestamptz,
  request_id bigint, requested_at timestamptz, next_attempt timestamptz not null default now(),
  failures integer not null default 0, last_error text,
  primary key(type,day)
);
create table if not exists bid_archive_private.seen (
  type text not null, day date not null, entry_id text not null,
  primary key(type,day,entry_id)
);
alter table bid_archive_private.settings enable row level security;
alter table bid_archive_private.jobs enable row level security;
alter table bid_archive_private.seen enable row level security;
-- This table contains only operational status, never credentials or raw errors.
create table if not exists public.bid_archive_health (
  singleton boolean primary key default true check(singleton),
  status text not null, message text not null, updated_at timestamptz not null default now()
);
alter table public.bid_archive_health enable row level security;
revoke all on public.bid_archive_health from public, anon, authenticated;
grant select on public.bid_archive_health to anon, authenticated;
drop policy if exists bid_archive_health_read on public.bid_archive_health;
create policy bid_archive_health_read on public.bid_archive_health for select to anon,authenticated using(true);
insert into public.bid_archive_health values(true,'preparing','공개 입찰 이력 수집을 준비하고 있습니다.',now()) on conflict do nothing;

create or replace function bid_archive_private.ingest(p_type text,p_day date,p_page integer,p_body jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare j bid_archive_private.jobs%rowtype; n integer; expected integer; has_more boolean;
begin
  select * into strict j from bid_archive_private.jobs where type=p_type and day=p_day for update;
  if j.completed_at is not null then raise exception 'Completed snapshot cannot accept another page'; end if;
  if j.page<>p_page or p_body->>'type'<>p_type or p_body->>'day'<>p_day::text or (p_body->>'page')::int<>p_page
    or (p_body->>'pageSize')::int<>999 then raise exception 'Page identity mismatch'; end if;
  n := (p_body->>'sourceCount')::int; expected := (p_body->>'totalCount')::int;
  has_more := (p_body->>'hasMore')::boolean;
  if n is null or expected is null or expected<0 or has_more is null
    or n<>greatest(0,least(999,expected-(p_page-1)*999))
    or has_more<>(p_page*999<expected) then raise exception 'Incomplete provider page'; end if;
  if j.expected_total is not null and j.expected_total<>expected then
    update bid_archive_private.jobs set page=1,expected_total=null,request_id=null,requested_at=null,
      started_at=now(),next_attempt=now()+interval '1 minute',last_error='Provider total changed; restarting snapshot' where type=p_type and day=p_day;
    delete from bid_archive_private.seen where type=p_type and day=p_day;
    return;
  end if;
  if jsonb_typeof(p_body->'entries')<>'array' or jsonb_typeof(p_body->'notices')<>'array' or jsonb_typeof(p_body->'companies')<>'array' then raise exception 'Malformed snapshot'; end if;
  if exists(select 1 from jsonb_array_elements(p_body->'entries') e join bid_archive_private.seen s
    on s.type=p_type and s.day=p_day and s.entry_id=e->>'id') then
    update bid_archive_private.jobs set page=1,expected_total=null,request_id=null,requested_at=null,
      started_at=now(),next_attempt=now()+interval '2 minutes',last_error='Provider page ordering changed; restarting snapshot' where type=p_type and day=p_day;
    delete from bid_archive_private.seen where type=p_type and day=p_day;
    return;
  end if;
  insert into public.bid_archive_companies(business_number,name,updated_at)
    select business_number,name,now() from jsonb_to_recordset(p_body->'companies') as c(business_number text,name text)
    on conflict(business_number) do update set name=coalesce(nullif(excluded.name,''),public.bid_archive_companies.name),updated_at=excluded.updated_at;
  insert into public.bid_archive_notices(id,number,revision,type,title,agency,opening_at,method,participant_count)
    select id,number,revision,type,title,agency,opening_at,method,participant_count from jsonb_to_recordset(p_body->'notices')
      as c(id text,number text,revision text,type text,title text,agency text,opening_at timestamptz,method text,participant_count integer)
    on conflict(id) do update set title=excluded.title,agency=excluded.agency,method=excluded.method,participant_count=excluded.participant_count;
  insert into public.bid_archive_entries(id,notice_id,business_number,bidding_at,bid_amount,bid_rate,rank,awarded,winning_amount,updated_at)
    select id,notice_id,business_number,nullif(bidding_at,'')::timestamptz,bid_amount,bid_rate,rank,awarded,winning_amount,now()
    from jsonb_to_recordset(p_body->'entries') as c(id text,notice_id text,business_number text,bidding_at text,bid_amount numeric,bid_rate numeric,rank text,awarded boolean,winning_amount numeric)
    on conflict(id) do update set bid_amount=excluded.bid_amount,bid_rate=excluded.bid_rate,rank=excluded.rank,
      awarded=excluded.awarded,winning_amount=excluded.winning_amount,updated_at=excluded.updated_at,archived=false;
  insert into bid_archive_private.seen select p_type,p_day,e->>'id' from jsonb_array_elements(p_body->'entries') e;
  insert into public.bid_archive_coverage(type,day,complete,updated_at) values(p_type,p_day,false,now())
    on conflict(type,day) do update set complete=false,updated_at=now();
  update bid_archive_private.jobs set page=case when has_more then p_page+1 else p_page end,
    expected_total=expected,request_id=null,requested_at=null,failures=0,last_error=null,
    completed_at=case when has_more then null else now() end,next_attempt=now()
    where type=p_type and day=p_day;
  if not has_more then
    -- Only a complete, stable traversal may replace a day's previous provider snapshot.
    update public.bid_archive_entries e set archived=true from public.bid_archive_notices nt
      where e.notice_id=nt.id and nt.type=p_type and (nt.opening_at at time zone 'Asia/Seoul')::date=p_day
      and not exists(select 1 from bid_archive_private.seen s where s.type=p_type and s.day=p_day and s.entry_id=e.id);
    update public.bid_archive_coverage set complete=(p_day<(now() at time zone 'Asia/Seoul')::date),updated_at=now() where type=p_type and day=p_day;
    delete from bid_archive_private.seen where type=p_type and day=p_day;
    -- Backfill continues backwards. No user query span / rolling retention limit.
    if p_day>'0001-01-01'::date then insert into bid_archive_private.jobs(type,day) values(p_type,p_day-1) on conflict do nothing; end if;
  end if;
end $$;

create or replace function bid_archive_private.tick()
returns void language plpgsql security invoker set search_path = '' as $$
declare cfg bid_archive_private.settings%rowtype; j bid_archive_private.jobs%rowtype; r record; b jsonb;
  today date := (now() at time zone 'Asia/Seoul')::date; reqid bigint; launches integer:=0;
begin
  if not pg_try_advisory_xact_lock(62614001) then return; end if;
  select * into strict cfg from bid_archive_private.settings where singleton for update;
  if not cfg.enabled then return; end if;
  if cfg.calls_day is distinct from today then
    update bid_archive_private.settings set calls_day=today,calls=0 where singleton; cfg.calls:=0;
  end if;
  for j in select * from bid_archive_private.jobs where request_id is not null loop
    begin
      select status_code,content,timed_out,error_msg,headers into r from net._http_response where id=j.request_id;
      if not found then
        if j.requested_at>now()-interval '3 minutes' then continue; end if;
        raise exception 'Public proxy response expired';
      end if;
      if r.status_code<>200 or r.timed_out or r.error_msg is not null then raise exception 'Public proxy response not successful'; end if;
      b := r.content::jsonb;
      perform bid_archive_private.ingest(j.type,j.day,j.page,b);
      delete from net._http_response where id=j.request_id;
    exception when others then
      update bid_archive_private.jobs set request_id=null,requested_at=null,failures=failures+1,
        next_attempt=now()+make_interval(secs=>least(3600,60*power(2,least(failures,6)))),
        last_error=left(sqlerrm,200) where type=j.type and day=j.day;
      delete from net._http_response where id=j.request_id;
      update public.bid_archive_health set status='retrying',message='원본 응답을 확인하고 있습니다. 저장된 이력은 조회할 수 있으며 수집은 자동으로 재시도합니다.',updated_at=now() where singleton;
    end;
  end loop;
  if pg_database_size(current_database())>=cfg.storage_ceiling then
    update public.bid_archive_health set status='storage',message='저장 공간 확장이 필요해 추가 수집을 대기 중입니다. 기존 이력의 조회 기간에는 제한이 없습니다.',updated_at=now() where singleton; return;
  end if;
  if cfg.calls>=cfg.daily_budget then
    update public.bid_archive_health set status='budget',message='오늘의 공통 수집량을 처리했습니다. 저장된 이력은 조회 가능하며 추가 수집은 다음 날 이어집니다.',updated_at=now() where singleton; return;
  end if;
  insert into bid_archive_private.jobs(type,day) values('공사',today),('용역',today),('공사',today-1),('용역',today-1) on conflict do nothing;
  -- Refresh current-day snapshots, and revisit older days for late result updates.
  update bid_archive_private.jobs set page=1,expected_total=null,completed_at=null,started_at=now(),next_attempt=now()
    where completed_at is not null and request_id is null and
      ((day=today and completed_at<now()-interval '30 minutes') or
       (day>=today-7 and day<today and completed_at<now()-interval '12 hours') or
       (day<today-7 and completed_at<now()-interval '7 days'));
  for j in select * from bid_archive_private.jobs where completed_at is null and request_id is null and next_attempt<=now()
      order by next_attempt,day desc limit 2 loop
    exit when cfg.calls+launches>=cfg.daily_budget;
    reqid := net.http_get(url:='https://construction-bid-nine.vercel.app/api/archive-page',
      params:=jsonb_build_object('type',j.type,'day',j.day::text,'page',j.page::text),timeout_milliseconds:=55000);
    update bid_archive_private.jobs set request_id=reqid,requested_at=now() where type=j.type and day=j.day;
    launches:=launches+1;
  end loop;
  update bid_archive_private.settings set calls=calls+launches where singleton;
  if launches>0 then update public.bid_archive_health set status='collecting',message='공개 개찰 이력을 최신 자료부터 과거 순서로 수집 중입니다. 조회 기간은 제한하지 않습니다.',updated_at=now() where singleton; end if;
end $$;
revoke all on all tables in schema bid_archive_private from public,anon,authenticated;
revoke all on all functions in schema bid_archive_private from public,anon,authenticated;
-- Enabled only after proxy deployment and a verified ingestion transaction.
commit;
