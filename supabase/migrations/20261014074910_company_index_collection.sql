-- Apply AFTER company-history.sql, company-collector.sql, company-notice-archive.sql.
-- Project: zjmhmyzgsmglrictwqtd. Additive, preserves all public/member records.
-- Does not enable settings or schedule cron. Deploy proxy + run rollback tests first.
begin;

alter table bid_archive_private.settings add column if not exists index_enabled boolean not null default false;
alter table bid_archive_private.settings add column if not exists openings_enabled boolean not null default false;
alter table bid_archive_private.settings add column if not exists latest_reserve integer not null default 120 check(latest_reserve>=0);
alter table bid_archive_private.settings add column if not exists backfill_calls integer not null default 0;
alter table bid_archive_private.settings add column if not exists next_lane text not null default 'latest' check(next_lane in('latest','backfill'));
alter table bid_archive_private.settings add column if not exists content_version integer not null default 1;
alter table bid_archive_private.jobs add column if not exists launched_at timestamptz;
alter table bid_archive_private.jobs add column if not exists is_recheck boolean not null default false;
alter table bid_archive_private.seen add column if not exists content_digest text;
alter table public.bid_archive_health add column if not exists storage_bytes bigint;
alter table public.bid_archive_health add column if not exists storage_ceiling bigint;
alter table public.bid_archive_health add column if not exists daily_budget integer;
alter table public.bid_archive_health add column if not exists calls_today integer;
alter table public.bid_archive_health add column if not exists target_from date;
alter table public.bid_archive_health add column if not exists pending_jobs integer;

create table if not exists public.bid_company_profiles (
  business_number text primary key references public.bid_archive_companies(business_number),
  profile jsonb not null check(jsonb_typeof(profile)='object'),
  registration_date date check(registration_date between date '1900-01-01' and date '9999-12-31'),
  updated_at timestamptz not null default now()
);
alter table public.bid_company_profiles add column if not exists warnings jsonb not null default '[]'::jsonb;
create extension if not exists pg_trgm with schema extensions;
do $$ declare ns text; begin
  select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
  execute format('create index if not exists bid_archive_companies_name_substring_idx on public.bid_archive_companies using gin(name %I.gin_trgm_ops)',ns);
end $$;
create table if not exists bid_archive_private.watched_companies (
  business_number text primary key check(business_number~'^[0-9]{10}$'),
  requested_at timestamptz not null default now(), registration_date date,
  profile_checked_at timestamptz, created_at timestamptz not null default now(),
  status text not null default 'pending' check(status in('pending','active','not_found'))
);
create table if not exists bid_archive_private.index_jobs (
  id text primary key, kind text not null check(kind in('company','contracts')),
  type text check(type in('공사','용역')), business_number text,
  from_date date, to_date date, page integer not null default 1 check(page>0),
  expected_total integer, completed_at timestamptz, verified_at timestamptz,
  last_snapshot_digest text, request_id bigint, requested_at timestamptz,
  launched_at timestamptz, next_attempt timestamptz not null default now(),
  failures integer not null default 0, last_error text, is_recheck boolean not null default false,
  check((kind='company' and business_number~'^[0-9]{10}$') or
    (kind='contracts' and type is not null and from_date is not null and to_date>=from_date and to_date-from_date<31))
);
create index if not exists bid_index_jobs_pending_idx on bid_archive_private.index_jobs(next_attempt,launched_at) where completed_at is null;
create table if not exists bid_archive_private.contract_seen (
  job_id text not null references bid_archive_private.index_jobs(id),
  contract_id text not null, content_digest text not null, businesses text[] not null default '{}',
  primary key(job_id,contract_id)
);
create table if not exists public.bid_archive_contracts (
  id text primary key, type text not null check(type in('공사','용역')),
  title text not null, agency text not null default '', contract_date date not null,
  contract_number text not null default '', unified_contract_number text not null default '',
  reference_number text not null default '', notice_number text not null default '', method text not null default '',
  contract_amount numeric check(contract_amount>=0), total_contract_amount numeric check(total_contract_amount>=0),
  source_url text not null default '', registered_at timestamptz, changed_at timestamptz,
  archived boolean not null default false, updated_at timestamptz not null default now()
);
create table if not exists public.bid_archive_contract_parties (
  contract_id text not null references public.bid_archive_contracts(id),
  business_number text not null references public.bid_archive_companies(business_number),
  name text not null default '', share_rate numeric check(share_rate between 0 and 100), archived boolean not null default false,
  primary key(contract_id,business_number)
);
create index if not exists bid_contract_parties_business_idx on public.bid_archive_contract_parties(business_number,contract_id);
create index if not exists bid_contracts_date_idx on public.bid_archive_contracts(type,contract_date desc);
create table if not exists public.bid_contract_coverage (
  type text not null check(type in('공사','용역')), day date not null,
  complete boolean not null default false, updated_at timestamptz not null default now(), primary key(type,day)
);

alter table public.bid_company_profiles enable row level security;
alter table public.bid_archive_contracts enable row level security;
alter table public.bid_archive_contract_parties enable row level security;
alter table public.bid_contract_coverage enable row level security;
alter table bid_archive_private.watched_companies enable row level security;
alter table bid_archive_private.index_jobs enable row level security;
alter table bid_archive_private.contract_seen enable row level security;
revoke all on public.bid_company_profiles,public.bid_archive_contracts,public.bid_archive_contract_parties,public.bid_contract_coverage from public,anon,authenticated;
grant select on public.bid_company_profiles,public.bid_archive_contracts,public.bid_archive_contract_parties,public.bid_contract_coverage to anon,authenticated;
drop policy if exists bid_company_profiles_read on public.bid_company_profiles;
create policy bid_company_profiles_read on public.bid_company_profiles for select to anon,authenticated using(true);
drop policy if exists bid_contracts_read on public.bid_archive_contracts;
create policy bid_contracts_read on public.bid_archive_contracts for select to anon,authenticated using(not archived);
drop policy if exists bid_contract_parties_read on public.bid_archive_contract_parties;
create policy bid_contract_parties_read on public.bid_archive_contract_parties for select to anon,authenticated using(not archived and
  exists(select 1 from public.bid_archive_contracts c where c.id=contract_id and not c.archived));
drop policy if exists bid_contract_coverage_read on public.bid_contract_coverage;
create policy bid_contract_coverage_read on public.bid_contract_coverage for select to anon,authenticated using(true);

create or replace function bid_archive_private.collection_floor()
returns date language sql stable security invoker set search_path='' as $$
  select min(registration_date) from bid_archive_private.watched_companies
  where registration_date between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date;
$$;

-- Narrow enqueue capability only: a public official identifier, never a profile,
-- date, URL, SQL expression or member-owned data. All actual data is worker fetched.
create or replace function public.bid_watch_company(p_business_number text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare checked timestamptz; watch_status text;
begin
  if p_business_number is null or p_business_number!~'^[0-9]{10}$' then
    raise exception '사업자등록번호 10자리가 필요합니다.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(62614002);
  if not exists(select 1 from bid_archive_private.watched_companies where business_number=p_business_number) then
    if (select count(*) from bid_archive_private.watched_companies where created_at>now()-interval '1 hour')>=30 then
      return jsonb_build_object('status','rate_limited','queued',false); end if;
    if (select count(*) from bid_archive_private.watched_companies where status<>'not_found')>=1000 then
      return jsonb_build_object('status','queue_full','queued',false); end if;
  end if;
  insert into bid_archive_private.watched_companies(business_number) values(p_business_number)
    on conflict(business_number) do update set requested_at=now();
  select profile_checked_at,status into checked,watch_status from bid_archive_private.watched_companies where business_number=p_business_number;
  if watch_status='not_found' and checked>now()-interval '7 days' then return jsonb_build_object('status','not_found','queued',false); end if;
  if checked>now()-interval '1 day' then return jsonb_build_object('status','current','queued',false); end if;
  insert into bid_archive_private.index_jobs(id,kind,business_number) values('company:'||p_business_number,'company',p_business_number)
    on conflict(id) do update set completed_at=null,next_attempt=greatest(bid_archive_private.index_jobs.next_attempt,now())
    where bid_archive_private.index_jobs.completed_at is not null;
  return jsonb_build_object('status','queued','queued',true);
end $$;
revoke all on function public.bid_watch_company(text) from public,anon,authenticated;
grant execute on function public.bid_watch_company(text) to anon,authenticated;

create or replace function bid_archive_private.ingest_company(p_biz text,p_body jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare c jsonb:=p_body->'company'; d date; rawday text; safe jsonb;
begin
  -- A verified empty official lookup is terminal, not an endlessly retried API
  -- failure. Only a new explicit watch after seven days can request rechecking.
  if p_body->'company'='null'::jsonb and p_body->'warnings'='[]'::jsonb then
    update bid_archive_private.watched_companies set status='not_found',profile_checked_at=now() where business_number=p_biz;
    update bid_archive_private.index_jobs set completed_at=now(),request_id=null,requested_at=null,
      last_error=null,failures=0,next_attempt=now()+interval '7 days' where id='company:'||p_biz;
    return;
  end if;
  if not exists(select 1 from bid_archive_private.watched_companies where business_number=p_biz)
    or jsonb_typeof(c) is distinct from 'object' or c->>'businessNumber' is distinct from p_biz
    or coalesce(c->>'name','')='' or jsonb_typeof(p_body->'warnings') is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(p_body->'warnings') w where jsonb_typeof(w)<>'string')
    then raise exception 'Official company profile incomplete'; end if;
  rawday:=substring(c->>'registrationDate' from 1 for 10);
  if (c->>'registrationDate')~'^[0-9]{8}($|[ T])' then rawday:=substring(rawday,1,4)||'-'||substring(rawday,5,2)||'-'||substring(rawday,7,2); end if;
  if coalesce(rawday,'')<>'' then
    if rawday!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Registration date invalid'; end if;
    d:=rawday::date;
    if d<date '1900-01-01' or d>(now() at time zone 'Asia/Seoul')::date then raise exception 'Registration date out of range'; end if;
  end if;
  if jsonb_typeof(c->'licenses') is distinct from 'array' or jsonb_typeof(c->'products') is distinct from 'array'
    or exists(select 1 from jsonb_array_elements((c->'licenses')||(c->'products')) x where jsonb_typeof(x)<>'string') then
    raise exception 'Registration arrays invalid'; end if;
  safe:=jsonb_build_object('businessNumber',p_biz,'name',c->>'name','representative',coalesce(c->>'representative',''),
    'address',coalesce(c->>'address',''),'phone',coalesce(c->>'phone',''),'registrationDate',coalesce(d::text,''),
    'companyType',coalesce(c->>'companyType',''),'licenses',c->'licenses','products',c->'products','updatedAt',now());
  insert into public.bid_archive_companies(business_number,name) values(p_biz,c->>'name')
    on conflict(business_number) do update set name=excluded.name,updated_at=now();
  insert into public.bid_company_profiles(business_number,profile,registration_date,warnings) values(p_biz,safe,d,p_body->'warnings')
    on conflict(business_number) do update set profile=excluded.profile,registration_date=excluded.registration_date,warnings=excluded.warnings,updated_at=now();
  update bid_archive_private.watched_companies set registration_date=d,profile_checked_at=now(),status='active' where business_number=p_biz;
end $$;

create or replace function bid_archive_private.seed_index_jobs(p_today date)
returns void language plpgsql security invoker set search_path='' as $$
declare floor_date date:=bid_archive_private.collection_floor(); month_start date; typ text;
begin
  if p_today is null or p_today is distinct from (now() at time zone 'Asia/Seoul')::date then raise exception 'Use current KST day'; end if;
  insert into bid_archive_private.jobs(type,day)
    select t,d::date from unnest(array['공사','용역']) t cross join generate_series(p_today-2,p_today,interval '1 day') d
    on conflict do nothing;
  month_start:=date_trunc('month',p_today)::date;
  foreach typ in array array['공사','용역'] loop
    -- Keep the continuously changing current day out of the historical month's
    -- cursor: otherwise page-1 restarts can starve contracts on earlier dates.
    insert into bid_archive_private.index_jobs(id,kind,type,from_date,to_date)
      values('contracts:'||typ||':day:'||p_today,'contracts',typ,p_today,p_today) on conflict do nothing;
    if month_start<p_today then
      insert into bid_archive_private.index_jobs(id,kind,type,from_date,to_date)
        values('contracts:'||typ||':'||month_start,'contracts',typ,month_start,p_today-1) on conflict do nothing;
    end if;
    -- Seed one older month independently, so a changing current month cannot block backfill.
    if floor_date is not null and month_start>date_trunc('month',floor_date)::date then
      insert into bid_archive_private.index_jobs(id,kind,type,from_date,to_date)
        values('contracts:'||typ||':'||(month_start-interval '1 month')::date,'contracts',typ,(month_start-interval '1 month')::date,month_start-1) on conflict do nothing;
    end if;
  end loop;
  if floor_date is not null then
    insert into bid_archive_private.jobs(type,day) select t,p_today-3 from unnest(array['공사','용역']) t where p_today-3>=floor_date on conflict do nothing;
    insert into bid_archive_private.jobs(type,day)
      select j.type,j.day-1 from bid_archive_private.jobs j where j.day>floor_date and j.day<p_today
        and (j.completed_at is not null or j.failures>=2) on conflict do nothing;
    insert into bid_archive_private.index_jobs(id,kind,type,from_date,to_date)
      select 'contracts:'||j.type||':'||(j.from_date-interval '1 month')::date,'contracts',j.type,
        (j.from_date-interval '1 month')::date,j.from_date-1 from bid_archive_private.index_jobs j
      where j.kind='contracts' and j.id not like 'contracts:%:day:%' and j.from_date>date_trunc('month',floor_date)::date
        and (j.completed_at is not null or j.failures>=2) on conflict do nothing;
  end if;
end $$;

-- Patch the existing standard ingest rather than replacing its source separation
-- and two-pass reconciliation. Compare complete content, not only identity keys.
do $$ declare definition text;
begin
  select pg_get_functiondef('bid_archive_private.ingest(text,date,integer,jsonb)'::regprocedure) into definition;
  definition:=replace(definition,
    'insert into bid_archive_private.seen select p_type,p_day,e->>''id'' from jsonb_array_elements(p_body->''entries'') e;',
    'insert into bid_archive_private.seen(type,day,entry_id,content_digest) select p_type,p_day,e->>''id'',md5((e-''updated_at''-''fetchedAt'')::text) from jsonb_array_elements(p_body->''entries'') e;');
  definition:=replace(definition,'string_agg(s.entry_id,'','' order by s.entry_id)',
    'string_agg(s.entry_id||'':''||coalesce(s.content_digest,''legacy''),'','' order by s.entry_id)');
  definition:=replace(definition,'p_day>''0001-01-01''::date','p_day>bid_archive_private.collection_floor()');
  if position('content_digest) select' in definition)=0 or position('p_day>bid_archive_private.collection_floor()' in definition)=0 then
    raise exception 'Standard collector differs from expected version'; end if;
  execute definition;
  select pg_get_functiondef('bid_archive_private.tick_openings()'::regprocedure) into definition;
  definition:=replace(definition,'if not cfg.enabled then return; end if;',
    'if not cfg.enabled or not cfg.openings_enabled then return; end if;');
  execute definition;
end $$;
create or replace function bid_archive_private.seed_failed_predecessors(p_today date)
returns void language sql security invoker set search_path='' as $$
  insert into bid_archive_private.jobs(type,day)
    select j.type,j.day-1 from bid_archive_private.jobs j where j.completed_at is null and j.failures>=2
      and j.day<p_today and j.day>bid_archive_private.collection_floor() on conflict do nothing;
$$;

create or replace function bid_archive_private.ingest_contracts(p_job text,p_body jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare j bid_archive_private.index_jobs%rowtype; c jsonb; party jsonb; n integer; total integer;
  more boolean; ids text[]:='{}'; companies text[]; signature text; warnings boolean;
begin
  select * into strict j from bid_archive_private.index_jobs where id=p_job and kind='contracts' for update;
  if j.completed_at is not null or p_body->>'type' is distinct from j.type
    or p_body->>'from' is distinct from j.from_date::text or p_body->>'to' is distinct from j.to_date::text
    or (p_body->>'page')::integer is distinct from j.page or (p_body->>'pageSize')::integer is distinct from 999
    or jsonb_typeof(p_body->'contracts') is distinct from 'array' or jsonb_typeof(p_body->'warnings') is distinct from 'array'
    then raise exception 'Contract page identity invalid'; end if;
  n:=(p_body->>'sourceCount')::integer; total:=(p_body->>'totalCount')::integer; more:=(p_body->>'hasMore')::boolean;
  if n is null or total is null or total<0 or more is null
    or n<>greatest(0,least(999,total-(j.page-1)*999)) or more<>(j.page*999<total)
    or j.page>greatest(1,ceil(total::numeric/999)) or jsonb_array_length(p_body->'contracts')>n then
    raise exception 'Contract source page incomplete'; end if;
  if (j.expected_total is not null and total<>j.expected_total)
    or exists(select 1 from jsonb_array_elements(p_body->'contracts') x join bid_archive_private.contract_seen s
      on s.job_id=j.id and s.contract_id=x->>'id') then
    update bid_archive_private.index_jobs set page=1,expected_total=null,last_snapshot_digest=null,verified_at=null,
      request_id=null,requested_at=null,failures=failures+1,next_attempt=now()+interval '10 minutes',
      last_error='Contract total or ordering changed; restart' where id=j.id;
    delete from bid_archive_private.contract_seen where job_id=j.id;
    return;
  end if;
  warnings:=jsonb_array_length(p_body->'warnings')>0 or jsonb_array_length(p_body->'contracts')<>n
    or j.last_error='Some contract rows could not be confirmed';
  for c in select value from jsonb_array_elements(p_body->'contracts') loop
    if coalesce(c->>'id','')!~'^contract:[a-f0-9]{64}$' or c->>'type' is distinct from j.type
      or coalesce(c->>'contractDate','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (c->>'contractDate')::date not between j.from_date and j.to_date
      or (coalesce(c->>'contractNumber','')='' and coalesce(c->>'unifiedContractNumber','')='')
      or jsonb_typeof(c->'parties') is distinct from 'array' or jsonb_array_length(c->'parties')=0
      or (coalesce(c->>'sourceUrl','')<>'' and c->>'sourceUrl'!~'^https://([A-Za-z0-9-]+\.)*g2b\.go\.kr(:443)?/')
      then raise exception 'Contract row invalid'; end if;
    if c->>'id'=any(ids) then raise exception 'Duplicate contract identity'; end if;
    ids:=array_append(ids,c->>'id'); companies:='{}';
    for party in select value from jsonb_array_elements(c->'parties') loop
      if coalesce(party->>'businessNumber','')!~'^[0-9]{10}$' or party->>'businessNumber'=any(companies)
        then raise exception 'Contract party invalid'; end if;
      companies:=array_append(companies,party->>'businessNumber');
      insert into public.bid_archive_companies(business_number,name) values(party->>'businessNumber',coalesce(party->>'name',''))
        on conflict(business_number) do update set name=coalesce(nullif(excluded.name,''),public.bid_archive_companies.name),updated_at=now();
    end loop;
    insert into public.bid_archive_contracts(id,type,title,agency,contract_date,contract_number,unified_contract_number,
      reference_number,notice_number,method,contract_amount,total_contract_amount,source_url,registered_at,changed_at)
      values(c->>'id',j.type,coalesce(c->>'title',''),coalesce(c->>'agency',''),(c->>'contractDate')::date,
        coalesce(c->>'contractNumber',''),coalesce(c->>'unifiedContractNumber',''),coalesce(c->>'referenceNumber',''),
        coalesce(c->>'noticeNumber',''),coalesce(c->>'method',''),(c->>'contractAmount')::numeric,
        (c->>'totalContractAmount')::numeric,coalesce(c->>'sourceUrl',''),nullif(c->>'registeredAt','')::timestamptz,nullif(c->>'changedAt','')::timestamptz)
      on conflict(id) do update set title=excluded.title,agency=excluded.agency,contract_date=excluded.contract_date,
        contract_number=excluded.contract_number,unified_contract_number=excluded.unified_contract_number,
        reference_number=excluded.reference_number,notice_number=excluded.notice_number,method=excluded.method,
        contract_amount=excluded.contract_amount,total_contract_amount=excluded.total_contract_amount,
        source_url=excluded.source_url,registered_at=excluded.registered_at,changed_at=excluded.changed_at,archived=false,updated_at=now();
    insert into public.bid_archive_contract_parties(contract_id,business_number,name,share_rate)
      select c->>'id',p->>'businessNumber',coalesce(nullif(p->>'name',''),(select name from public.bid_archive_companies where business_number=p->>'businessNumber'),''),
        (p->>'shareRate')::numeric from jsonb_array_elements(c->'parties') p
      on conflict(contract_id,business_number) do update set name=coalesce(nullif(excluded.name,''),public.bid_archive_contract_parties.name),share_rate=excluded.share_rate,archived=false;
    -- Collection timestamps must never prevent two equal source snapshots matching.
    insert into bid_archive_private.contract_seen(job_id,contract_id,content_digest,businesses)
      values(j.id,c->>'id',md5(((c-'fetchedAt'-'updatedAt')||jsonb_build_object('parties',
        (select jsonb_agg(p order by p->>'businessNumber') from jsonb_array_elements(c->'parties') p)))::text),companies);
  end loop;
  insert into public.bid_contract_coverage(type,day,complete)
    select j.type,d::date,false from generate_series(j.from_date,j.to_date,interval '1 day') d
    on conflict(type,day) do update set complete=false,updated_at=now();
  update bid_archive_private.index_jobs set expected_total=total,page=case when more then page+1 else page end,
    request_id=null,requested_at=null,next_attempt=now(),
    last_error=case when warnings then 'Some contract rows could not be confirmed' else null end where id=j.id;
  if more then return; end if;
  select md5(total::text||':'||coalesce(string_agg(s.contract_id||':'||s.content_digest,',' order by s.contract_id),''))
    into signature from bid_archive_private.contract_seen s where s.job_id=j.id;
  if warnings then
    update bid_archive_private.index_jobs set completed_at=now(),verified_at=null,last_snapshot_digest=null,
      next_attempt=now()+interval '1 day',failures=failures+1 where id=j.id;
  elsif j.last_snapshot_digest is distinct from signature then
    update bid_archive_private.index_jobs set page=1,expected_total=null,last_snapshot_digest=signature,
      verified_at=null,next_attempt=now()+interval '5 minutes',failures=case when j.last_snapshot_digest is null then 0 else failures+1 end,
      last_error='Full contract snapshot saved; awaiting matching verification' where id=j.id;
  else
    update public.bid_archive_contracts c set archived=true
      where c.type=j.type and c.contract_date between j.from_date and j.to_date
      and not exists(select 1 from bid_archive_private.contract_seen s where s.job_id=j.id and s.contract_id=c.id);
    update public.bid_archive_contract_parties p set archived=true
      from bid_archive_private.contract_seen s where s.job_id=j.id and p.contract_id=s.contract_id
      and not (p.business_number=any(s.businesses));
    update public.bid_contract_coverage set complete=(day<(now() at time zone 'Asia/Seoul')::date),updated_at=now()
      where type=j.type and day between j.from_date and j.to_date;
    update bid_archive_private.index_jobs set completed_at=now(),verified_at=now(),failures=0,last_error=null where id=j.id;
  end if;
  delete from bid_archive_private.contract_seen where job_id=j.id;
end $$;

create or replace function public.bid_company_contract_history(bizno text,from_date date default null,to_date date default null,page_no integer default 1,page_size integer default 30)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare start_day date; end_day date; result jsonb;
begin
  if bizno is null or bizno!~'^[0-9]{10}$' or page_no is null or page_no<1 or page_size is null or page_size not between 1 and 100
    or (from_date is not null and not isfinite(from_date)) or (to_date is not null and not isfinite(to_date))
    or (from_date is not null and to_date is not null and from_date>to_date) then raise exception '조회 조건을 확인해 주세요.' using errcode='22023'; end if;
  select coalesce(from_date,p.registration_date) into start_day from (select 1) x left join public.bid_company_profiles p on p.business_number=bizno;
  end_day:=coalesce(to_date,(now() at time zone 'Asia/Seoul')::date);
  with filtered as materialized (
    select c.*,p.business_number,p.name,p.share_rate from public.bid_archive_contracts c join public.bid_archive_contract_parties p on p.contract_id=c.id
    where p.business_number=bizno and not c.archived and not p.archived
      and (start_day is null or c.contract_date>=start_day) and c.contract_date<=end_day
  ), selected as (
    select * from filtered order by contract_date desc,contract_number desc,id offset (page_no::bigint-1)*page_size limit page_size
  ), coverage as (
    select min(day) filter(where complete) as first_day,max(day) filter(where complete) as last_day,max(updated_at) as updated_at,
      start_day is not null and start_day<=end_day and count(*) filter(where complete and day between start_day and end_day)=((end_day-start_day)::bigint+1)*2 as ready
      from public.bid_contract_coverage
  ) select jsonb_build_object('company',jsonb_build_object('businessNumber',bizno,'name',(select name from public.bid_archive_companies where business_number=bizno)),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'type',s.type,'businessNumber',s.business_number,'companyName',s.name,
      'title',s.title,'agency',s.agency,'contractDate',s.contract_date,'contractNumber',s.contract_number,'unifiedContractNumber',s.unified_contract_number,
      'referenceNumber',s.reference_number,'noticeNumber',s.notice_number,'method',s.method,'contractAmount',s.contract_amount,
      'totalContractAmount',s.total_contract_amount,'shareRate',s.share_rate,'sourceUrl',s.source_url,
      'registeredAt',coalesce(s.registered_at::text,''),'changedAt',coalesce(s.changed_at::text,'')) order by s.contract_date desc,s.contract_number desc,s.id) from selected s),'[]'::jsonb),
    'totalCount',(select count(*) from filtered),'page',page_no,'pageSize',page_size,
    'coverage',(select jsonb_build_object('status',case when ready then 'ready' else 'collecting' end,
      'from',first_day,'to',last_day,'updatedAt',updated_at,'message',case when ready then '선택 기간의 공개 계약 자료를 확인했습니다.'
      else '공개 계약을 수집 중입니다. 현재 확인된 자료이며 미수집 기간과 누락 자료가 있을 수 있습니다.' end) from coverage)) into result;
  return result;
end $$;
revoke all on function public.bid_company_contract_history(text,date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.bid_company_contract_history(text,date,date,integer,integer) to anon,authenticated;

create or replace function bid_archive_private.collection_candidates(p_today date)
returns table(kind text,id text,type text,day date,lane text,cost integer,launched_at timestamptz,recheck boolean)
language sql stable security invoker set search_path='' as $$
  select 'standard',j.type||':'||j.day,j.type,j.day,
    case when j.day>=p_today-2 then 'latest' else 'backfill' end,1,j.launched_at,j.is_recheck
  from bid_archive_private.jobs j where j.completed_at is null and j.request_id is null and j.next_attempt<=now()
    and j.day<=p_today and (j.day>=p_today-2 or j.day>=bid_archive_private.collection_floor())
  union all
  select j.kind,j.id,j.type,j.from_date,
    case when j.kind='company' or j.from_date>=date_trunc('month',p_today)::date then 'latest' else 'backfill' end,
    case when j.kind='company' then 3 else 1 end,j.launched_at,j.is_recheck
  from bid_archive_private.index_jobs j where j.completed_at is null and j.request_id is null and j.next_attempt<=now()
    and (j.kind='company' or (j.from_date<=p_today and (j.from_date>=date_trunc('month',p_today)::date
      or j.from_date>=date_trunc('month',bid_archive_private.collection_floor())::date)));
$$;

-- Existing company-history-collector cron already invokes this function. It is
-- a no-op until BOTH enabled/index_enabled are explicitly enabled after deploy.
create or replace function bid_archive_private.tick()
returns void language plpgsql security invoker set search_path='' as $$
declare cfg bid_archive_private.settings%rowtype; old bid_archive_private.jobs%rowtype;
  job bid_archive_private.index_jobs%rowtype; candidate record; response record; body jsonb;
  today date:=(now() at time zone 'Asia/Seoul')::date; reqid bigint; params jsonb;
  bytes bigint; inflight integer; launched integer:=0; v_lane text; delay_secs integer;
begin
  if not pg_try_advisory_xact_lock(62614001) then return; end if;
  select * into strict cfg from bid_archive_private.settings where singleton for update;
  if cfg.calls_day is distinct from today then
    update bid_archive_private.settings set calls_day=today,calls=0,backfill_calls=0 where singleton;
    cfg.calls:=0; cfg.backfill_calls:=0;
  end if;
  bytes:=pg_database_size(current_database());
  update public.bid_archive_health set storage_bytes=bytes,storage_ceiling=cfg.storage_ceiling,
    daily_budget=cfg.daily_budget,calls_today=cfg.calls,target_from=bid_archive_private.collection_floor(),
    pending_jobs=(select count(*) from bid_archive_private.jobs where completed_at is null)+(select count(*) from bid_archive_private.index_jobs where completed_at is null),
    updated_at=now() where singleton;
  if not cfg.enabled or not cfg.index_enabled then
    update public.bid_archive_health set status='paused',message='자동 수집이 일시 중지되어 있습니다. 저장된 자료는 조회할 수 있습니다.' where singleton; return; end if;
  if bytes>=cfg.storage_ceiling then
    update public.bid_archive_health set status='storage',message='설정된 저장 한도에 도달해 수집을 대기 중입니다. 기존 이력은 보존됩니다.' where singleton; return; end if;
  -- Consume durable requests before scheduling new work. Failed responses never
  -- advance a cursor; all retries have exponential backoff capped at one day.
  for old in select * from bid_archive_private.jobs where request_id is not null loop
    begin
      select status_code,content,timed_out,error_msg into response from net._http_response where id=old.request_id;
      if not found then
        if old.requested_at>now()-interval '3 minutes' then continue; end if;
        raise exception 'Source response expired';
      end if;
      if response.status_code is distinct from 200 or response.timed_out is true or response.error_msg is not null then
        raise exception 'Source HTTP not successful'; end if;
      perform bid_archive_private.ingest(old.type,old.day,old.page,response.content::jsonb);
      delete from net._http_response where id=old.request_id;
    exception when others then
      delay_secs:=case when response.status_code=429 then 3600 else least(86400,300*power(2,least(old.failures,8))::int) end;
      update bid_archive_private.jobs set request_id=null,requested_at=null,failures=failures+1,
        next_attempt=now()+make_interval(secs=>delay_secs),last_error=left(sqlerrm,200) where type=old.type and day=old.day;
      delete from net._http_response where id=old.request_id;
    end;
  end loop;
  for job in select * from bid_archive_private.index_jobs where request_id is not null loop
    begin
      select status_code,content,timed_out,error_msg into response from net._http_response where id=job.request_id;
      if not found then
        if job.requested_at>now()-interval '3 minutes' then continue; end if;
        raise exception 'Index response expired';
      end if;
      if response.status_code is distinct from 200 or response.timed_out is true or response.error_msg is not null then
        raise exception 'Index HTTP not successful'; end if;
      body:=response.content::jsonb;
      if job.kind='company' then
        perform bid_archive_private.ingest_company(job.business_number,body);
        update bid_archive_private.index_jobs set completed_at=now(),request_id=null,requested_at=null,failures=0,last_error=null where id=job.id;
      else perform bid_archive_private.ingest_contracts(job.id,body); end if;
      delete from net._http_response where id=job.request_id;
    exception when others then
      delay_secs:=case when response.status_code=429 then 3600 else least(86400,300*power(2,least(job.failures,8))::int) end;
      update bid_archive_private.index_jobs set request_id=null,requested_at=null,failures=failures+1,
        next_attempt=now()+make_interval(secs=>delay_secs),last_error=left(sqlerrm,200) where id=job.id;
      delete from net._http_response where id=job.request_id;
    end;
  end loop;
  perform bid_archive_private.seed_index_jobs(today);
  -- Latest rechecks never reset an in-progress page. Backfill is an independent
  -- lane and is not restarted merely because a newer current-day query exists.
  update bid_archive_private.jobs set page=1,expected_total=null,completed_at=null,next_attempt=now(),started_at=now(),is_recheck=true
    where request_id is null and completed_at is not null and
      ((day=today and completed_at<now()-interval '30 minutes') or
       (day between today-7 and today-1 and completed_at<now()-interval '12 hours') or
       (day<today-7 and completed_at<now()-interval '7 days'));
  update bid_archive_private.index_jobs set page=1,expected_total=null,completed_at=null,next_attempt=now(),last_error=null,
    to_date=case when id like 'contracts:%:day:%' then to_date
      else least((from_date+interval '1 month'-interval '1 day')::date,today-1) end,is_recheck=true
    where kind='contracts' and request_id is null and completed_at is not null and
      ((id like 'contracts:%:day:%' and ((from_date=today and completed_at<now()-interval '30 minutes')
        or (from_date between today-7 and today-1 and completed_at<now()-interval '12 hours')
        or (from_date<today-7 and completed_at<now()-interval '7 days'))) or
       (id not like 'contracts:%:day:%' and (
        (from_date=date_trunc('month',today)::date and (to_date<today-1 or completed_at<now()-interval '1 hour')) or
        (from_date=(date_trunc('month',today)-interval '1 month')::date and completed_at<now()-interval '12 hours') or
        (from_date<(date_trunc('month',today)-interval '1 month')::date and completed_at<now()-interval '7 days'))) or
       (last_error is not null and next_attempt<=now()));
  if pg_database_size(current_database())>=cfg.storage_ceiling then
    update public.bid_archive_health set status='storage',message='설정된 저장 한도에 도달해 수집을 대기 중입니다.' where singleton; return; end if;
  select (select count(*) from bid_archive_private.jobs where request_id is not null)
    +(select count(*) from bid_archive_private.index_jobs where request_id is not null)
    +(select count(*) from bid_archive_private.notice_jobs where request_id is not null and cfg.openings_enabled) into inflight;
  v_lane:=cfg.next_lane;
  while launched<2 and inflight<2 loop
    select * into candidate from bid_archive_private.collection_candidates(today) c
      where cfg.calls+c.cost<=cfg.daily_budget and
        (c.lane='latest' or cfg.backfill_calls+c.cost<=greatest(0,cfg.daily_budget-least(cfg.latest_reserve,cfg.daily_budget)))
      -- New backfill wins normally. Every tenth budget position gives old
      -- rechecks a turn, so neither delayed changes nor first collection starve.
      order by (c.lane=v_lane) desc,(c.recheck=(cfg.calls%10=9)) desc,
        c.launched_at nulls first,c.day desc nulls first,c.id limit 1;
    if not found then exit; end if;
    if candidate.kind='standard' then
      select * into strict old from bid_archive_private.jobs where type=candidate.type and day=candidate.day for update;
      params:=jsonb_build_object('type',old.type,'day',old.day,'page',old.page);
    else
      select * into strict job from bid_archive_private.index_jobs where id=candidate.id for update;
      params:=case when job.kind='company' then jsonb_build_object('source','company','businessNumber',job.business_number)
        else jsonb_build_object('source','contracts','type',job.type,'from',job.from_date,'to',job.to_date,'page',job.page) end;
    end if;
    reqid:=net.http_get(url:='https://construction-bid-nine.vercel.app/api/archive-page',params:=params,timeout_milliseconds:=55000);
    if candidate.kind='standard' then
      update bid_archive_private.jobs set request_id=reqid,requested_at=now(),launched_at=now() where type=candidate.type and day=candidate.day;
    else update bid_archive_private.index_jobs set request_id=reqid,requested_at=now(),launched_at=now() where id=candidate.id; end if;
    cfg.calls:=cfg.calls+candidate.cost;
    if candidate.lane='backfill' then cfg.backfill_calls:=cfg.backfill_calls+candidate.cost; end if;
    v_lane:=case when candidate.lane='latest' then 'backfill' else 'latest' end;
    launched:=launched+1; inflight:=inflight+1;
  end loop;
  update bid_archive_private.settings set calls=cfg.calls,backfill_calls=cfg.backfill_calls,next_lane=v_lane where singleton;
  update public.bid_archive_health set calls_today=cfg.calls,
    status=case when cfg.calls>=cfg.daily_budget then 'budget' when launched>0 or inflight>0 then 'collecting' else 'waiting' end,
    message=case when cfg.calls>=cfg.daily_budget then '오늘의 수집 예산을 사용했습니다. 저장된 이력은 조회 가능하며 다음 날 이어집니다.'
      when launched>0 or inflight>0 then '최신 자료 갱신과 등록일까지의 과거 자료 수집을 함께 진행하고 있습니다.'
      else '다음 수집 또는 재확인 시각을 기다리고 있습니다. 저장된 자료를 먼저 표시합니다.' end,updated_at=now() where singleton;
end $$;

-- Default rows and coverage must describe the same official registration range.
-- Missing registration remains NULL (incomplete), never an invented start year.
do $$ declare definition text; begin
  select pg_get_functiondef('public.bid_company_history(text,date,date,integer,integer,text)'::regprocedure) into definition;
  if position('bid_company_profiles' in definition)=0 then
    if position('  with filtered as materialized (' in definition)=0 then raise exception 'History RPC differs from expected version'; end if;
    definition:=replace(definition,'  with filtered as materialized (',
      '  from_date:=coalesce(from_date,(select registration_date from public.bid_company_profiles where business_number=v_bizno));
  to_date:=coalesce(to_date,(now() at time zone ''Asia/Seoul'')::date);
  with filtered as materialized (');
    execute definition;
  end if;
  -- Old identity-only verification is not equivalent to content verification.
  -- Recheck it without deleting any previously collected public entries.
  if (select content_version from bid_archive_private.settings where singleton)<2 then
    update public.bid_archive_coverage set complete=false where complete;
    update bid_archive_private.jobs set page=1,expected_total=null,completed_at=null,
      last_snapshot_digest=null,verified_at=null,next_attempt=now(),is_recheck=true
      where completed_at is not null and request_id is null;
    update bid_archive_private.settings set content_version=2 where singleton;
  end if;
end $$;

revoke all on all tables in schema bid_archive_private from public,anon,authenticated;
revoke all on all functions in schema bid_archive_private from public,anon,authenticated;
commit;
-- Root applies and verifies this migration, then deploys bounded source proxies.
-- Existing cron company-history-collector -> bid_archive_private.tick() is reused.
-- Only after verification: administrator enables enabled + index_enabled together.
-- openings_enabled remains false: the historical precise archive retains its data,
-- but its separate 15-call worker is not allowed to consume the new lane budgets.
