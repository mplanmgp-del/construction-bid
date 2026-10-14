-- Run as postgres AFTER 20261014074910_company_index_collection.sql.
-- Pure transactional fixtures: no tick(), HTTP call, cron change, settings enable,
-- deletion of existing data, or persistent writes. Roll back after any failure.
begin;
select pg_advisory_xact_lock(62614001);

do $$
declare
  biz constant text:='9999900901'; other_biz constant text:='9999900902';
  today date:=(now() at time zone 'Asia/Seoul')::date;
  profile jsonb; settings_before jsonb; target date; queued jsonb; rejected boolean;
begin
  assert not exists(select 1 from public.bid_archive_companies where business_number in(biz,other_biz)), 'Fixture business already exists';
  select to_jsonb(s) into settings_before from bid_archive_private.settings s where singleton;
  queued:=public.bid_watch_company(biz);
  assert queued->>'status'='queued', 'Exact official ID is queued';
  perform public.bid_watch_company(biz);
  assert (select count(*) from bid_archive_private.index_jobs where id='company:'||biz)=1, 'Repeated watch does not duplicate work';
  assert not exists(select 1 from public.bid_company_profiles where business_number=biz), 'Enqueue cannot inject a profile';
  rejected:=false;
  begin perform public.bid_watch_company('fake-id'); exception when others then rejected:=true; end;
  assert rejected, 'Public enqueue validates business identity';
  profile:=jsonb_build_object('company',jsonb_build_object('businessNumber',biz,'name','Index rollback company',
    'registrationDate','2020-02-29','representative','','address','','phone','','companyType','법인',
    'licenses',jsonb_build_array('철거'),'products','[]'::jsonb,'secret','must not persist'),
    'warnings',jsonb_build_array('공개 업종이 일부일 수 있습니다.'));
  perform bid_archive_private.ingest_company(biz,profile);
  assert (select registration_date from public.bid_company_profiles where business_number=biz)=date '2020-02-29', 'Official registration sets backfill boundary';
  assert (select not(p.profile?'secret') and jsonb_array_length(p.warnings)=1 from public.bid_company_profiles p where business_number=biz), 'Only public allowlist plus warnings persisted';
  assert public.bid_watch_company(biz)->>'status'='current', 'Fresh profile does not consume another call';
  assert bid_archive_private.collection_floor()<=date '2020-02-29', 'Floor includes watched registration';
  rejected:=false;
  begin perform bid_archive_private.ingest_company(biz,jsonb_set(profile,'{company,businessNumber}',to_jsonb(other_biz))); exception when others then rejected:=true; end;
  assert rejected, 'Profile write rejects mismatched business';
  perform bid_archive_private.seed_index_jobs(today);
  assert exists(select 1 from bid_archive_private.jobs where day=today and type='공사'), 'Latest lane gets today independently';
  assert exists(select 1 from bid_archive_private.jobs where day=today-3 and type='용역'), 'Backfill lane seeded independently of today completion';
  assert exists(select 1 from bid_archive_private.index_jobs where kind='contracts' and id like 'contracts:%:day:%' and from_date=today and to_date=today), 'Volatile today gets its own contract cursor';
  if date_trunc('month',today)::date<today then
    assert exists(select 1 from bid_archive_private.index_jobs where kind='contracts' and id not like 'contracts:%:day:%'
      and from_date=date_trunc('month',today)::date and to_date=today-1), 'Current historical month excludes volatile today';
  end if;
  assert exists(select 1 from bid_archive_private.index_jobs where kind='contracts' and from_date=(date_trunc('month',today)-interval '1 month')::date), 'Older contract month seeded independently';
  assert (select to_jsonb(s)=settings_before from bid_archive_private.settings s where singleton), 'Queue seeding never increases budget, enables cron or consumes quota';
  assert (select cost from bid_archive_private.collection_candidates(today) where id='company:'||biz)=3, 'Profile reserves bounded three official calls';
  assert exists(select 1 from bid_archive_private.collection_candidates(today) where lane='latest')
    and exists(select 1 from bid_archive_private.collection_candidates(today) where lane='backfill'), 'Latest and backfill candidates coexist';
  target:=bid_archive_private.collection_floor();
  insert into bid_archive_private.jobs(type,day,failures) values('공사',target,2) on conflict do nothing;
  perform bid_archive_private.seed_failed_predecessors(today);
  assert not exists(select 1 from bid_archive_private.collection_candidates(today) where day<target), 'Workers never descend below official watched floor';
  assert position('0001-01-01' in pg_get_functiondef('bid_archive_private.ingest(text,date,integer,jsonb)'::regprocedure))=0, 'Old year-one recursion removed';
end $$;

do $$
declare
  biz constant text:='9999900901'; other_biz constant text:='9999900902';
  jobid constant text:='__index_contract_rollback'; contractid text:='contract:'||repeat('a',64);
  fixture_day constant date:='2020-02-29'; c jsonb; payload jsonb; result jsonb; old_digest text; rejected boolean;
begin
  assert not exists(select 1 from public.bid_archive_contracts where id=contractid), 'Fixture contract already exists';
  insert into bid_archive_private.index_jobs(id,kind,type,from_date,to_date) values(jobid,'contracts','공사',fixture_day,fixture_day);
  c:=jsonb_build_object('id',contractid,'type','공사','title','No-bid contract fixture','agency','Test agency','contractDate',fixture_day,
    'contractNumber','TEST-CONTRACT00','unifiedContractNumber','TEST-UNIFIED','referenceNumber','','noticeNumber','',
    'method','수의계약','contractAmount',40640000,'totalContractAmount',40640000,'sourceUrl','https://www.g2b.go.kr/link/test',
    'registeredAt','2020-03-01T09:00:00+09:00','changedAt','',
    'parties',jsonb_build_array(jsonb_build_object('businessNumber',biz,'name','Index rollback company','shareRate',60),
      jsonb_build_object('businessNumber',other_biz,'name','','shareRate',null)));
  payload:=jsonb_build_object('type','공사','from',fixture_day,'to',fixture_day,'page',1,'pageSize',999,
    'sourceCount',1,'totalCount',1,'hasMore',false,'warnings','[]'::jsonb,'contracts',jsonb_build_array(c));
  perform bid_archive_private.ingest_contracts(jobid,payload);
  assert (select completed_at is null and last_snapshot_digest is not null from bid_archive_private.index_jobs where id=jobid), 'One full contract pass does not claim complete';
  result:=public.bid_company_contract_history(biz,'2020-01-01','2026-12-31',1,30);
  assert (result->>'totalCount')::int=1 and result->'items'->0->>'method'='수의계약', 'Contract without notice remains searchable';
  assert result->'items'->0->>'noticeNumber'='' and (result->'items'->0->>'contractAmount')::numeric=40640000, 'No-bid amount preserved';
  assert (result->'items'->0->>'shareRate')::numeric=60, 'Joint total not converted to individual amount';
  assert public.bid_company_contract_history(other_biz,fixture_day,fixture_day,1,30)->'items'->0->'shareRate'='null'::jsonb, 'Unknown share stays null';
  select last_snapshot_digest into old_digest from bid_archive_private.index_jobs where id=jobid;
  -- Changed published value with the same identity must require two new passes.
  c:=c||jsonb_build_object('contractAmount',50000000);
  payload:=jsonb_set(payload,'{contracts}',jsonb_build_array(c));
  perform bid_archive_private.ingest_contracts(jobid,payload);
  assert (select completed_at is null and last_snapshot_digest<>old_digest from bid_archive_private.index_jobs where id=jobid), 'Same ID with changed amount is not verified';
  -- Collection timestamp and array ordering do not change the published content.
  c:=c||jsonb_build_object('updatedAt','2026-10-14T12:00:00Z','fetchedAt','2026-10-14T12:00:00Z',
    'parties',jsonb_build_array(c->'parties'->1,c->'parties'->0));
  perform bid_archive_private.ingest_contracts(jobid,jsonb_set(payload,'{contracts}',jsonb_build_array(c)));
  assert (select completed_at is not null and verified_at is not null from bid_archive_private.index_jobs where id=jobid), 'Equal official values verify despite a later fetch';
  assert (select complete from public.bid_contract_coverage where type='공사' and day=fixture_day), 'Verified closed day gets coverage';
  assert public.bid_company_contract_history(biz,fixture_day,fixture_day,1,1)->>'totalCount'='1', 'Inclusive date boundary';
  assert public.bid_company_contract_history(biz,fixture_day+1,fixture_day+1,1,30)->>'totalCount'='0', 'Different day excluded';
  assert public.bid_company_contract_history('9999900999',fixture_day,fixture_day,1,30)->>'totalCount'='0', 'Other business remains isolated';
  assert public.bid_company_contract_history(biz,'1990-01-01','2026-12-31',2,1)->'items'='[]'::jsonb, 'Multi-decade filters and pagination accepted';
  -- A warned replacement cannot hide the previously published contract.
  update bid_archive_private.index_jobs set page=1,completed_at=null,expected_total=null where id=jobid;
  perform bid_archive_private.ingest_contracts(jobid,payload||jsonb_build_object('contracts','[]'::jsonb,'warnings',jsonb_build_array('업체 누락')));
  assert not(select archived from public.bid_archive_contracts where id=contractid), 'Incomplete replacement never removes saved contract';
  assert not(select complete from public.bid_contract_coverage where type='공사' and day=fixture_day), 'Warnings do not advertise complete coverage';
  assert (select failures>0 and next_attempt>now() from bid_archive_private.index_jobs where id=jobid), 'Partial replacement is deferred rather than busy-looped';
  -- The next independent pass clears the prior pass's warning. Otherwise a
  -- formerly partial source would remain incomplete forever despite recovery.
  update bid_archive_private.index_jobs set completed_at=null,page=1,expected_total=null,last_error=null where id=jobid;
  perform bid_archive_private.ingest_contracts(jobid,payload);
  perform bid_archive_private.ingest_contracts(jobid,payload);
  assert (select verified_at is not null and last_error is null from bid_archive_private.index_jobs where id=jobid), 'Partial contract source recovers after two clean passes';
end $$;

do $$
declare b constant text:='9999900901'; d constant date:='2020-02-28'; payload jsonb; row jsonb; digest text;
begin
  assert not exists(select 1 from bid_archive_private.jobs where type='용역' and day=d), 'Standard fixture day already exists';
  insert into bid_archive_private.jobs(type,day) values('용역',d);
  row:=jsonb_build_object('id','__index_standard_row','notice_id','__index_standard_notice','business_number',b,
    'bidding_at','2020-02-27T12:00:00+09:00','bid_amount',100,'bid_rate',88,'rank','2','awarded',false,'winning_amount',null,'updated_at','2026-10-14T01:00:00Z');
  payload:=jsonb_build_object('type','용역','day',d,'page',1,'pageSize',999,'sourceCount',1,'totalCount',1,'hasMore',false,
    'companies',jsonb_build_array(jsonb_build_object('business_number',b,'name','Index rollback company')),
    'notices',jsonb_build_array(jsonb_build_object('id','__index_standard_notice','number','INDEX-TEST','revision','000','type','용역',
      'title','Index test','agency','','opening_at','2020-02-28T10:00:00+09:00','method','','participant_count',1)),
    'entries',jsonb_build_array(row));
  perform bid_archive_private.ingest('용역',d,1,payload);
  select last_snapshot_digest into digest from bid_archive_private.jobs where type='용역' and day=d;
  row:=row||jsonb_build_object('awarded',true,'rank','1','winning_amount',100,'updated_at','2026-10-14T02:00:00Z');
  perform bid_archive_private.ingest('용역',d,1,jsonb_set(payload,'{entries}',jsonb_build_array(row)));
  assert (select completed_at is null and last_snapshot_digest<>digest from bid_archive_private.jobs where type='용역' and day=d), 'Changed award/rank under same ID not prematurely complete';
  row:=row||jsonb_build_object('updated_at','2026-10-14T03:00:00Z');
  perform bid_archive_private.ingest('용역',d,1,jsonb_set(payload,'{entries}',jsonb_build_array(row)));
  assert (select verified_at is not null from bid_archive_private.jobs where type='용역' and day=d), 'Same published values verify with a new collection timestamp';
  assert public.bid_company_history(b,null,null,1,30,'all')->'summary'->>'participationCount'='0', 'Blank dates exclude records before official registration';
  assert public.bid_company_history(b,d,d,1,30,'all')->'summary'->>'participationCount'='1', 'Explicit older date remains searchable without UI day cap';
  assert public.bid_company_history('9999900902',null,null,1,30,'all')->'coverage'->>'status'='collecting', 'Missing registration never advertises complete default range';
end $$;

do $$
declare result jsonb; before_calls integer; before_rows bigint;
begin
  assert not exists(select 1 from bid_archive_private.watched_companies where business_number='9999900903'), 'Negative lookup fixture exists';
  perform public.bid_watch_company('9999900903');
  perform bid_archive_private.ingest_company('9999900903','{"company":null,"warnings":[]}'::jsonb);
  assert (select status='not_found' from bid_archive_private.watched_companies where business_number='9999900903'), 'Official nonregistration terminal';
  assert (select completed_at is not null and request_id is null and next_attempt>now()+interval '6 days' from bid_archive_private.index_jobs where id='company:9999900903'), 'Negative lookup does not retry automatically';
  assert public.bid_watch_company('9999900903')->>'status'='not_found', 'Negative lookup has seven-day enqueue cooldown';
  assert not exists(select 1 from public.bid_archive_companies where business_number='9999900903'), 'Empty lookup does not manufacture public registration';
  insert into bid_archive_private.watched_companies(business_number)
    select '999991'||lpad(i::text,4,'0') from generate_series(1,30) i on conflict do nothing;
  assert public.bid_watch_company('9999900998')->>'status'='rate_limited', 'New anonymous IDs have a global hourly budget';
  -- Exercise the storage guard itself. With a one-byte temporary ceiling, tick
  -- returns before reading responses or calling net.http_get. All changes roll back.
  select calls into before_calls from bid_archive_private.settings where singleton;
  select count(*) into before_rows from public.bid_archive_entries;
  update bid_archive_private.settings set enabled=true,index_enabled=true,storage_ceiling=1,
    calls_day=(now() at time zone 'Asia/Seoul')::date where singleton;
  perform bid_archive_private.tick();
  assert (select status='storage' from public.bid_archive_health where singleton), 'Real storage guard pauses worker';
  assert (select calls=before_calls from bid_archive_private.settings where singleton), 'Storage-blocked worker spends no calls';
  assert (select count(*) from public.bid_archive_entries)=before_rows, 'Storage guard preserves existing public entries';
end $$;

do $$ begin
  assert not has_table_privilege('anon','public.bid_company_profiles','INSERT'), 'Public profile writes forbidden';
  assert not has_table_privilege('authenticated','public.bid_archive_contracts','UPDATE'), 'Public contract writes forbidden';
  assert not has_function_privilege('anon','bid_archive_private.ingest_company(text,jsonb)','EXECUTE'), 'Raw profile ingest not public';
  assert not has_function_privilege('anon','bid_archive_private.ingest_contracts(text,jsonb)','EXECUTE'), 'Raw contract ingest not public';
  assert has_function_privilege('anon','public.bid_watch_company(text)','EXECUTE'), 'Identifier-only watch available';
  assert has_table_privilege('anon','public.bid_archive_contracts','SELECT'), 'Public contract reads available';
  assert position('cfg.backfill_calls+c.cost' in pg_get_functiondef('bid_archive_private.tick()'::regprocedure))>0, 'Backfill respects separate latest reservation';
  assert position('pg_database_size' in pg_get_functiondef('bid_archive_private.tick()'::regprocedure))>0, 'Storage guard retained';
end $$;

select 'company_index_collection rollback assertions passed' as result;
rollback;
