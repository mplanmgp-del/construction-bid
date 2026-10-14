-- Public G2B records only. No member profile, notes, bookmarks, or credentials.
-- Apply to the selected project database; the collector writes as postgres.
begin;

create table if not exists public.bid_archive_companies (
  business_number text primary key check (business_number ~ '^[0-9]{10}$'),
  name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.bid_archive_notices (
  -- The collector includes type, notice number/revision, and opening time.
  id text primary key,
  number text not null,
  revision text not null,
  type text not null check (type in ('공사', '용역')),
  title text not null,
  agency text not null default '',
  opening_at timestamptz,
  method text not null default '',
  participant_count integer check (participant_count >= 0)
);

create table if not exists public.bid_archive_entries (
  -- A stable provider-record fingerprint also includes bidder, bidding time,
  -- and amount. A notice/company pair alone would overwrite rebids.
  id text primary key,
  notice_id text not null references public.bid_archive_notices(id),
  business_number text not null references public.bid_archive_companies(business_number),
  bidding_at timestamptz,
  bid_amount numeric check (bid_amount >= 0),
  bid_rate numeric,
  rank text not null default '',
  -- NULL means not confirmed. Rank 1 alone is not a confirmed award.
  awarded boolean,
  winning_amount numeric check (winning_amount >= 0),
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.bid_archive_entries add column if not exists archived boolean not null default false;

create index if not exists bid_archive_entries_company_notice_idx
  on public.bid_archive_entries(business_number, notice_id);
create index if not exists bid_archive_entries_notice_idx
  on public.bid_archive_entries(notice_id);
create index if not exists bid_archive_notices_opening_idx
  on public.bid_archive_notices(opening_at desc);

create table if not exists public.bid_archive_coverage (
  type text not null check (type in ('공사', '용역')),
  day date not null,
  complete boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(type, day)
);

alter table public.bid_archive_companies enable row level security;
alter table public.bid_archive_notices enable row level security;
alter table public.bid_archive_entries enable row level security;
alter table public.bid_archive_coverage enable row level security;

revoke all on table public.bid_archive_companies, public.bid_archive_notices,
  public.bid_archive_entries, public.bid_archive_coverage from public, anon, authenticated;
grant select on table public.bid_archive_companies, public.bid_archive_notices,
  public.bid_archive_entries, public.bid_archive_coverage to anon, authenticated;

drop policy if exists bid_archive_companies_public_read on public.bid_archive_companies;
create policy bid_archive_companies_public_read on public.bid_archive_companies
  for select to anon, authenticated using (true);
drop policy if exists bid_archive_notices_public_read on public.bid_archive_notices;
create policy bid_archive_notices_public_read on public.bid_archive_notices
  for select to anon, authenticated using (true);
drop policy if exists bid_archive_entries_public_read on public.bid_archive_entries;
create policy bid_archive_entries_public_read on public.bid_archive_entries
  for select to anon, authenticated using (not archived);
drop policy if exists bid_archive_coverage_public_read on public.bid_archive_coverage;
create policy bid_archive_coverage_public_read on public.bid_archive_coverage
  for select to anon, authenticated using (true);

create or replace function public.bid_company_history(
  bizno text,
  from_date date default null,
  to_date date default null,
  page_no integer default 1,
  page_size integer default 30,
  outcome text default 'all'
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_bizno text;
  v_result jsonb;
begin
  if bizno is null or btrim(bizno) !~ '^([0-9]{10}|[0-9]{3}-[0-9]{2}-[0-9]{5})$' then
    raise exception '사업자등록번호 10자리가 필요합니다.' using errcode = '22023';
  end if;
  v_bizno := replace(btrim(bizno), '-', '');
  if page_no is null or page_no < 1 or page_size is null or page_size < 1 or page_size > 100 then
    raise exception '페이지는 1 이상, 페이지 크기는 1~100이어야 합니다.' using errcode = '22023';
  end if;
  if outcome is null or outcome not in ('all', 'won', 'lost', 'pending') then
    raise exception '지원하지 않는 결과 필터입니다.' using errcode = '22023';
  end if;
  if (from_date is not null and not isfinite(from_date)) or (to_date is not null and not isfinite(to_date))
    or (from_date is not null and to_date is not null and from_date > to_date) then
    raise exception '조회 기간을 확인하세요.' using errcode = '22023';
  end if;

  with filtered as materialized (
    select e.*, n.number, n.revision, n.type, n.title, n.agency, n.opening_at,
      n.method, n.participant_count
    from public.bid_archive_entries e
    join public.bid_archive_notices n on n.id = e.notice_id
    where e.business_number = v_bizno
      and not e.archived
      and (from_date is null or n.opening_at >= (from_date::timestamp at time zone 'Asia/Seoul'))
      and (to_date is null or n.opening_at < ((to_date + 1)::timestamp at time zone 'Asia/Seoul'))
  ), outcome_rows as (
    select * from filtered f
    where outcome = 'all' or (outcome = 'won' and f.awarded is true)
      or (outcome = 'lost' and f.awarded is false) or (outcome = 'pending' and f.awarded is null)
  ), page_rows as (
    select * from outcome_rows f
    order by f.opening_at desc nulls last, f.bidding_at desc nulls last, f.id
    offset ((page_no::bigint - 1) * page_size) limit page_size
  ), summary as (
    select count(*) as participation_count,
      count(*) filter (where f.awarded is true) as win_count,
      count(*) filter (where f.awarded is null) as pending_count,
      case when count(*) filter (where f.awarded is true) = 0 then 0
        else sum(f.winning_amount) filter (where f.awarded is true) end as winning_amount,
      case when count(*) = 0 then 0 else sum(f.bid_amount) end as bid_amount,
      avg(f.bid_rate) as average_bid_rate
    from filtered f
  ), monthly as (
    select to_char(f.opening_at at time zone 'Asia/Seoul', 'YYYY-MM') as month,
      count(*) as participation_count,
      count(*) filter (where f.awarded is true) as win_count,
      case when count(*) filter (where f.awarded is true) = 0 then 0
        else sum(f.winning_amount) filter (where f.awarded is true) end as winning_amount
    from filtered f where f.opening_at is not null
    group by to_char(f.opening_at at time zone 'Asia/Seoul', 'YYYY-MM')
  ), agencies as (
    select coalesce(nullif(f.agency, ''), '-') as name,
      count(*) as participation_count,
      count(*) filter (where f.awarded is true) as win_count,
      case when count(*) filter (where f.awarded is true) = 0 then 0
        else sum(f.winning_amount) filter (where f.awarded is true) end as winning_amount
    from filtered f group by coalesce(nullif(f.agency, ''), '-')
  ), business_types as (
    select f.type as name, count(*) as participation_count,
      count(*) filter (where f.awarded is true) as win_count,
      case when count(*) filter (where f.awarded is true) = 0 then 0
        else sum(f.winning_amount) filter (where f.awarded is true) end as winning_amount
    from filtered f group by f.type
  ), methods as (
    select coalesce(nullif(btrim(f.method), ''), '-') as name,
      count(*) as participation_count,
      count(*) filter (where f.awarded is true) as win_count,
      case when count(*) filter (where f.awarded is true) = 0 then 0
        else sum(f.winning_amount) filter (where f.awarded is true) end as winning_amount
    from filtered f group by coalesce(nullif(btrim(f.method), ''), '-')
  ), selected_notices as (
    select distinct f.notice_id from filtered f
  ), competitors as (
    select e.business_number, c.name,
      count(distinct e.notice_id) as shared_count,
      count(distinct e.notice_id) filter (where e.awarded is true) as win_count
    from selected_notices s
    join public.bid_archive_entries e on e.notice_id = s.notice_id
    join public.bid_archive_companies c on c.business_number = e.business_number
    where e.business_number <> v_bizno and not e.archived
    group by e.business_number, c.name
    order by shared_count desc, e.business_number
    limit 20
  ), coverage as (
    select min(c.day) filter (where c.complete) as first_day,
      max(c.day) filter (where c.complete) as last_day,
      max(c.updated_at) as updated_at,
      from_date is not null and to_date is not null
        and count(*) filter (where c.complete and c.day between from_date and to_date)
          = ((to_date - from_date)::bigint + 1) * 2 as ready
    from public.bid_archive_coverage c
  )
  select jsonb_build_object(
    'company', (select jsonb_build_object(
      'businessNumber', c.business_number, 'name', c.name,
      'representative', '', 'address', '', 'phone', '', 'registrationDate', '',
      'companyType', '', 'licenses', '[]'::jsonb, 'products', '[]'::jsonb,
      'updatedAt', c.updated_at
    ) from public.bid_archive_companies c where c.business_number = v_bizno),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'number', p.number, 'revision', p.revision, 'type', p.type,
      'title', p.title, 'agency', p.agency,
      'openingAt', coalesce(to_char(p.opening_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS'), ''),
      'rank', p.rank, 'participantCount', p.participant_count,
      'bidAmount', p.bid_amount, 'bidRate', p.bid_rate, 'awarded', p.awarded,
      'winningAmount', p.winning_amount, 'method', p.method
    ) order by p.opening_at desc nulls last, p.bidding_at desc nulls last, p.id) from page_rows p), '[]'::jsonb),
    'totalCount', (select count(*) from outcome_rows), 'page', page_no, 'pageSize', page_size,
    'summary', (select jsonb_build_object(
      'participationCount', s.participation_count, 'winCount', s.win_count,
      'pendingCount', s.pending_count, 'winningAmount', s.winning_amount,
      'bidAmount', s.bid_amount, 'averageBidRate', s.average_bid_rate
    ) from summary s),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object(
      'month', m.month, 'participationCount', m.participation_count,
      'winCount', m.win_count, 'winningAmount', m.winning_amount
    ) order by m.month) from monthly m), '[]'::jsonb),
    'agencies', coalesce((select jsonb_agg(jsonb_build_object(
      'name', a.name, 'participationCount', a.participation_count,
      'winCount', a.win_count, 'winningAmount', a.winning_amount
    ) order by a.win_count desc, a.winning_amount desc nulls last, a.participation_count desc, a.name) from agencies a), '[]'::jsonb),
    'businessTypes', coalesce((select jsonb_agg(jsonb_build_object(
      'name', b.name, 'participationCount', b.participation_count,
      'winCount', b.win_count, 'winningAmount', b.winning_amount
    ) order by b.participation_count desc, b.name) from business_types b), '[]'::jsonb),
    'methods', coalesce((select jsonb_agg(jsonb_build_object(
      'name', m.name, 'participationCount', m.participation_count,
      'winCount', m.win_count, 'winningAmount', m.winning_amount
    ) order by m.participation_count desc, m.name) from methods m), '[]'::jsonb),
    'competitors', coalesce((select jsonb_agg(jsonb_build_object(
      'businessNumber', c.business_number, 'name', c.name,
      'sharedCount', c.shared_count, 'winCount', c.win_count
    ) order by c.shared_count desc, c.business_number) from competitors c), '[]'::jsonb),
    'coverage', (select jsonb_build_object(
      'status', case when c.ready then 'ready' else 'collecting' end,
      'from', c.first_day, 'to', c.last_day, 'updatedAt', c.updated_at,
      'message', case
        when not c.ready and (select participation_count from summary) = 0 then
          '수집된 이력이 아직 없습니다. 과거 자료를 수집 중이며 실제 참여 이력이 없다는 뜻은 아닙니다.'
        when c.ready then
          '선택 기간의 공사·용역 공개 개찰 자료 수집을 완료했습니다. 원본에서 공개하지 않은 자료는 포함되지 않습니다.'
        else
          '공개 이력을 수집 중입니다. 표시된 수집 시작·종료일 사이에도 미수집 날짜가 있을 수 있어 전체 이력을 보장하지 않습니다.'
      end
    ) from coverage c)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.bid_company_history(text, date, date, integer, integer, text) from public, anon, authenticated;
grant execute on function public.bid_company_history(text, date, date, integer, integer, text) to anon, authenticated;

commit;
