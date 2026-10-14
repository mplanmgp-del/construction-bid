-- Run as postgres AFTER company-history.sql, company-collector.sql and
-- company-notice-archive.sql. Every fixture is rolled back.
-- No worker invocation, HTTP request, cron change, or budget increase occurs.
begin;
-- Both collectors skip a concurrent run using this existing transaction lock.
-- No need to mutate the user's cron schedule or collection settings.
select pg_advisory_xact_lock(62614001);

do $$
declare
  a constant text:='9999900301'; b constant text:='9999900302';
  num constant text:='OPENINGTEST001';
  test_day constant date:='1980-01-02';
  body jsonb; changed jsonb; partial jsonb; empty_body jsonb; bad jsonb;
  g0 jsonb; g1 jsonb; p0 jsonb; p1 jsonb;
  result jsonb; report jsonb; saved_id text; count_before integer; rejected boolean;
  digest_before text;
begin
  assert not exists(select 1 from public.bid_archive_companies where business_number in (a,b)),
    'Reserved company fixture already exists';
  assert not exists(select 1 from bid_archive_private.jobs where type='공사' and jobs.day=test_day),
    'Fixture date already has a daily collector job';
  assert not exists(select 1 from public.bid_archive_notices where number like 'OPENINGTEST%'),
    'Reserved notice fixture already exists';
  assert not exists(select 1 from bid_archive_private.notice_jobs where number like 'OPENQUEUE%'),
    'Reserved queue fixture already exists';

  p0:=jsonb_build_object('businessNumber',a,'companyName','Opening company A','rank','1',
    'bidAmount',100,'bidRate',null,'biddingAt','1980-01-01T10:00:00+09:00','awarded',null);
  p1:=jsonb_build_object('businessNumber',b,'companyName','Opening company B','rank','2',
    'bidAmount',101,'bidRate',91.2,'biddingAt','1980-01-01T10:01:00+09:00','awarded',true);
  g0:=jsonb_build_object('id','공사:'||num||':000:0:0','classification','0','rebid','0',
    'title','Opening rollback fixture','agency','Test agency','openingAt','1980-01-02T00:00:00+09:00',
    'participantCount',2,'winnerBusinessNumber',b,'winningAmount',101,
    'participants',jsonb_build_array(p0,p1));
  g1:=g0||jsonb_build_object('id','공사:'||num||':000:1:1','classification','1','rebid','1',
    'openingAt','1980-01-02T23:59:59+09:00','winningAmount',null,
    'participants',jsonb_build_array(p0||jsonb_build_object('awarded',false),p1));
  body:=jsonb_build_object('number',num,'revision','000','type','공사',
    'fetchedAt','2024-01-01T00:00:00Z','complete',true,'warnings','[]'::jsonb,
    'participantCount',4,'groups',jsonb_build_array(g0,g1),
    'privateNote','This extra field must never be persisted');

  -- Existing standard rows remain physically present after precise source selection.
  insert into public.bid_archive_companies(business_number,name) values(a,'Standard A');
  insert into public.bid_archive_notices(id,number,revision,type,title,opening_at)
    values('__opening_standard_notice',num,'000','공사','Old public record','1980-01-02T00:00:00+09:00');
  insert into public.bid_archive_entries(id,notice_id,business_number,bid_amount,rank)
    values('__opening_standard_entry','__opening_standard_notice',a,100,'1');
  result:=bid_archive_private.ingest_opening(body);
  assert result->>'status'='stored' and (result->>'stored')::int=4, 'Full response ingests four public rows';
  assert not exists(select 1 from bid_archive_private.notice_jobs where number=num), 'Direct admin ingest does not require a queue job';
  assert (select count(*) from public.bid_archive_entries e join public.bid_archive_notices n on n.id=e.notice_id
    where n.number=num)=5, 'Standard source is preserved without deletion';
  assert not (select archived from public.bid_archive_entries where id='__opening_standard_entry'), 'Standard row is not soft-deleted for source deduplication';
  assert (select count(*) from public.bid_archive_effective_entries e join public.bid_archive_notices n on n.id=e.notice_id
    where n.number=num)=4, 'Full precise snapshot suppresses duplicate standard records in reads';
  assert (select count(distinct notice_id) from public.bid_archive_entries where business_number=b)=2, 'Classification and rebid identities stay distinct';
  report:=public.bid_company_history(a,test_day,test_day);
  assert (report->>'totalCount')::int=2, 'Inclusive KST day includes midnight and 23:59:59 rows exactly once';
  assert (report#>>'{summary,winCount}')::int=0 and (report#>>'{summary,pendingCount}')::int=1,
    'Rank one is not inferred to be awarded';
  assert (report#>>'{competitors,0,sharedCount}')::int=2 and report#>>'{competitors,0,businessNumber}'=b,
    'Competitor counts use precise group identities and exclude the selected company';
  assert public.bid_company_history(a)#>>'{coverage,status}'='collecting', 'Precise notice collection never marks all-history coverage complete';
  report:=public.bid_company_history(b);
  assert (report#>>'{summary,winCount}')::int=2 and (report#>>'{summary,winningAmount}')::numeric=101,
    'Published win amount is summed; an unpublished winning amount stays null at record level';
  assert (select count(*) from public.bid_archive_entries where business_number=b and winning_amount is null)=1,
    'Unknown winning amount is not substituted with bid amount';

  -- Timestamp spelling / SQL session timezone cannot create a duplicate record.
  select id into saved_id from public.bid_archive_entries where business_number=a and notice_id='opening:공사:'||num||':000:0:0';
  changed:=jsonb_set(body,'{groups,0,participants,0,biddingAt}','"1980-01-01T01:00:00Z"');
  changed:=jsonb_set(changed,'{groups,0,participants,0,bidAmount}','102');
  changed:=changed||jsonb_build_object('fetchedAt','2024-01-02T00:00:00Z');
  perform set_config('TimeZone','America/New_York',true);
  perform bid_archive_private.ingest_opening(changed);
  assert (select bid_amount from public.bid_archive_entries where id=saved_id)=102,
    'The same bidder/time with a corrected amount updates in place';
  assert (select count(*) from public.bid_archive_entries where business_number=a and source_kind='opening')=2,
    'Equivalent timestamps do not generate another entry';
  perform set_config('TimeZone','UTC',true);
  result:=bid_archive_private.ingest_opening(body);
  assert result->>'status'='stale' and (select bid_amount from public.bid_archive_entries where id=saved_id)=102,
    'Older cached responses cannot roll back newer public records';

  -- Invalid payloads must roll back all writes, including those before a bad row.
  for bad in select value from jsonb_array_elements(jsonb_build_array(
    changed||jsonb_build_object('complete',false),
    changed||jsonb_build_object('warnings',jsonb_build_array('missing page')),
    changed||jsonb_build_object('participantCount',99),
    jsonb_set(changed,'{groups,1,participants,1,businessNumber}','"not-a-business"'),
    jsonb_set(changed,'{groups,1,participants,1,bidAmount}','"100"'),
    jsonb_set(changed,'{groups,1,participants,1,bidAmount}','-1'),
    jsonb_set(changed,'{groups,1,participants,1}',changed#>'{groups,1,participants,0}'),
    jsonb_set(changed,'{groups,1,id}','"wrong:group"')
  )) loop
    count_before:=(select count(*) from public.bid_archive_entries);
    rejected:=false;
    begin perform bid_archive_private.ingest_opening(bad); exception when others then rejected:=true; end;
    assert rejected, 'Malformed/incomplete payload must be rejected';
    assert (select count(*) from public.bid_archive_entries)=count_before, 'Rejected payload is atomic';
  end loop;

  -- Two NEW complete snapshots with the same identity set are required before
  -- missing precise entries are hidden. Replaying a cached response does not count.
  changed:=jsonb_set(changed,'{groups,0,participants}',jsonb_build_array(p1));
  changed:=jsonb_set(changed,'{groups,0,participantCount}','1');
  changed:=changed||jsonb_build_object('participantCount',3,'fetchedAt','2024-01-03T00:00:00Z');
  perform bid_archive_private.ingest_opening(changed);
  assert not (select archived from public.bid_archive_entries where id=saved_id), 'First changed identity set preserves the missing record';
  perform bid_archive_private.ingest_opening(changed);
  assert not (select archived from public.bid_archive_entries where id=saved_id), 'Replayed cached snapshot cannot confirm disappearance';
  perform bid_archive_private.ingest_opening(changed||jsonb_build_object('fetchedAt','2024-01-04T00:00:00Z'));
  assert (select archived from public.bid_archive_entries where id=saved_id), 'Second independently fetched matching full snapshot may archive a missing record';
  assert (select count(*) from public.bid_archive_entries where business_number=a and source_kind='opening')=2,
    'Reconciliation retains old rows for recovery';

  -- Latest-rebid-only responses are useful, but are NOT whole-notice snapshots.
  partial:=body||jsonb_build_object('number','OPENINGTEST002','participantCount',2,'groups',jsonb_build_array(
    g0||jsonb_build_object('id','공사:OPENINGTEST002:000:0:0','participants','[]'::jsonb,'participantCount',220),
    g1||jsonb_build_object('id','공사:OPENINGTEST002:000:1:1')));
  insert into public.bid_archive_notices(id,number,revision,type,title,opening_at)
    values('__opening_partial_notice','OPENINGTEST002','000','공사','Earlier rebid','1980-01-02T00:00:00+09:00');
  insert into public.bid_archive_entries(id,notice_id,business_number)
    values('__opening_partial_standard','__opening_partial_notice',a);
  result:=bid_archive_private.ingest_opening(partial);
  assert result->>'status'='partial' and (result->>'stored')::int=2, 'Available later-rebid participants are ingested';
  assert not (select complete from public.bid_archive_opening_snapshots where number='OPENINGTEST002'), 'Missing older-rebid participants block whole-notice completeness';
  assert exists(select 1 from public.bid_archive_effective_entries where id='__opening_partial_standard'),
    'Partial precise source cannot suppress prior standard records';

  -- Empty successful responses do not hide previously collected participants.
  empty_body:=body||jsonb_build_object('groups','[]'::jsonb,'participantCount',0,'fetchedAt','2024-01-05T00:00:00Z');
  select last_identity_digest into digest_before from public.bid_archive_opening_snapshots where number=num;
  result:=bid_archive_private.ingest_opening(empty_body);
  assert result->>'status'='empty', 'An empty response preserves the prior snapshot';
  assert (select last_identity_digest from public.bid_archive_opening_snapshots where number=num)=digest_before,
    'An empty response cannot become deletion confirmation';

  -- A formerly complete notice can gain a new rebid whose participants are only
  -- in the standard feed. Previous completion must not hide that new group.
  partial:=changed||jsonb_build_object('fetchedAt','2024-01-06T00:00:00Z');
  partial:=jsonb_set(partial,'{groups,0,participantCount}','220');
  perform bid_archive_private.ingest_opening(partial);
  assert not (select complete from public.bid_archive_opening_snapshots where number=num),
    'A new partial response revokes whole-notice source preference, not old records';
  assert exists(select 1 from public.bid_archive_effective_entries where id='__opening_standard_entry'),
    'Standard rows reappear when the current precise group set is incomplete';
  -- Restore a genuinely complete fresh fixture for the cooldown assertion below.
  perform bid_archive_private.ingest_opening(changed||jsonb_build_object('fetchedAt','2024-01-07T00:00:00Z'));
  assert (select complete from public.bid_archive_opening_snapshots where number=num),
    'A subsequent complete response restores precise-source preference';

  -- Daily standard-data reconciliation must not hide precise source rows.
  insert into bid_archive_private.jobs(type,day) values('공사',test_day);
  empty_body:=jsonb_build_object('type','공사','day',test_day::text,'page',1,'pageSize',999,
    'sourceCount',0,'totalCount',0,'hasMore',false,'companies','[]'::jsonb,'notices','[]'::jsonb,'entries','[]'::jsonb);
  perform bid_archive_private.ingest('공사',test_day,1,empty_body);
  perform bid_archive_private.ingest('공사',test_day,1,empty_body);
  assert (select archived from public.bid_archive_entries where id='__opening_standard_entry'), 'Standard collector still reconciles standard records';
  assert (select count(*) from public.bid_archive_entries where source_kind='opening' and not archived and business_number in(a,b))=5,
    'Standard collector cannot archive precise opening participants';

  -- Permissions: public clients can read and enqueue IDs, but cannot supply data.
  assert has_function_privilege('anon','public.bid_queue_opening_notice(text,text,text)','execute'), 'Public enqueue is granted';
  assert not has_function_privilege('anon','bid_archive_private.ingest_opening(jsonb)','execute'), 'Public clients cannot ingest arbitrary payloads';
  assert not has_function_privilege('authenticated','bid_archive_private.tick_openings()','execute'), 'Worker is private';
  assert not has_table_privilege('anon','public.bid_archive_entries','insert'), 'Archive writes are not public';
  assert not has_schema_privilege('anon','bid_archive_private','usage'), 'Private queue cannot be browsed';
  assert has_table_privilege('anon','public.bid_archive_effective_entries','select'), 'Effective read view is accessible';
end $$;

-- Exercise the actual restricted role, not just grants inspected as postgres.
set local role anon;
do $$
declare result jsonb; rejected boolean;
begin
  result:=public.bid_queue_opening_notice('공사','OPENQUEUE001','000');
  assert result->>'status'='queued', 'Anonymous user can enqueue a valid public identifier';
  result:=public.bid_queue_opening_notice('공사','OPENQUEUE001','000');
  assert result->>'status'='pending', 'Duplicate queue requests are deduplicated';
  result:=public.bid_queue_opening_notice('공사','OPENINGTEST001','000');
  assert result->>'status'='cached', 'Recent administrator ingest also activates cooldown';
  rejected:=false;
  begin perform public.bid_queue_opening_notice('공사','https://arbitrary.example','000');
  exception when invalid_parameter_value then rejected:=true; end;
  assert rejected, 'Queue cannot accept arbitrary outbound URLs';
  assert (public.bid_company_history('9999900302')->>'totalCount')::int=3,
    'RLS invoker view returns public records to anon with the same deduplication';
end $$;
reset role;

do $$
declare result jsonb;
begin
  update bid_archive_private.notice_jobs set completed_at=now() where number='OPENQUEUE001';
  result:=public.bid_queue_opening_notice('공사','OPENQUEUE001','000');
  assert result->>'status'='cached', 'Completed queue jobs observe the five-minute cooldown';
  update bid_archive_private.notice_jobs set completed_at=now()-interval '10 minutes',
    next_attempt=now()+interval '1 day',last_error='Participant pagination exceeds background budget; deferred'
    where number='OPENQUEUE001';
  result:=public.bid_queue_opening_notice('공사','OPENQUEUE001','000');
  assert result->>'status'='deferred', 'Oversized notice deferral survives new public queue attempts';
  assert not exists(select 1 from bid_archive_private.notice_jobs where number like 'OPENCAPTEST%'), 'Cap fixtures must be isolated';
  insert into bid_archive_private.notice_jobs(type,number,revision)
    select '공사','OPENCAPTEST'||lpad(i::text,4,'0'),'000' from generate_series(1,1000) g(i);
  result:=public.bid_queue_opening_notice('공사','OPENQUEUE002','000');
  assert result->>'status'='full', 'Pending queue is capped even for unique identifier requests';
  assert not exists(select 1 from bid_archive_private.notice_jobs where number='OPENQUEUE002'), 'Full queue does not insert overflow work';
end $$;

rollback;
