-- Rollback-only assertions, run as postgres after company-history.sql and company-collector.sql.
-- Does not invoke tick(), pg_net, schedules, API calls, or collector settings.
-- All fixtures use __collector_test_* IDs and reserved 999* business numbers.
-- If an assertion aborts the transaction, execute ROLLBACK before further work.
begin;
select pg_advisory_xact_lock(62614001);

-- The additive indexed collector bounds backfill by officially watched
-- registration dates. Keep this older suite valid both before and after that
-- migration without enabling collection or writing any permanent fixture.
do $$ begin
  if to_regclass('bid_archive_private.watched_companies') is not null then
    execute $fixture$insert into bid_archive_private.watched_companies(business_number,registration_date)
      values('9999900101','2019-01-01') on conflict(business_number) do nothing$fixture$;
  end if;
end $$;

do $$
declare
  test_day constant date := '2020-02-29';
  test_biz constant text := '9999900101';
  notice_id constant text := '__collector_test_notice';
  first_page jsonb;
  last_page jsonb;
  changed_page jsonb;
  repeated_page jsonb;
  replacement_page jsonb;
  first_digest text;
  rejected boolean;
  state bid_archive_private.jobs%rowtype;
begin
  assert not exists(select 1 from bid_archive_private.jobs where type='공사' and day=test_day),
    'Test day has an existing collector job; choose another isolated fixture date';
  assert not exists(select 1 from public.bid_archive_companies where business_number=test_biz),
    'Reserved test business already exists; choose another fixture business';

  insert into public.bid_archive_companies(business_number,name) values(test_biz,'Collector rollback test');
  insert into public.bid_archive_notices(id,number,revision,type,title,agency,opening_at,method)
    values(notice_id,'COLLECTOR-TEST','000','공사','Collector rollback fixture','Test agency',test_day::timestamp at time zone 'Asia/Seoul','일반경쟁');
  insert into public.bid_archive_entries(id,notice_id,business_number,bid_amount,rank,awarded,winning_amount)
    values('__collector_test_old',notice_id,test_biz,1,'1',true,1);
  insert into bid_archive_private.jobs(type,day) values('공사',test_day);

  select jsonb_build_object(
    'type','공사','day',test_day::text,'page',1,'pageSize',999,'sourceCount',999,'totalCount',1000,'hasMore',true,
    'companies',jsonb_build_array(jsonb_build_object('business_number',test_biz,'name','Collector rollback test')),
    'notices',jsonb_build_array(jsonb_build_object('id',notice_id,'number','COLLECTOR-TEST','revision','000','type','공사',
      'title','Collector rollback fixture','agency','Test agency','opening_at',test_day::text||'T00:00:00+09:00','method','일반경쟁','participant_count',null)),
    'entries',jsonb_agg(jsonb_build_object('id','__collector_test_entry_'||g.i,'notice_id',notice_id,
      'business_number',test_biz,'bidding_at','2020-02-28T12:00:00+09:00','bid_amount',g.i,
      'bid_rate',88.1,'rank',g.i::text,'awarded',false,'winning_amount',null) order by g.i))
  into first_page from generate_series(1,999) as g(i);
  last_page := first_page || jsonb_build_object('page',2,'sourceCount',1,'hasMore',false,
    'entries',jsonb_build_array(jsonb_build_object('id','__collector_test_entry_1000','notice_id',notice_id,
      'business_number',test_biz,'bidding_at','2020-02-28T12:00:00+09:00','bid_amount',1000,
      'bid_rate',89.1,'rank','1','awarded',true,'winning_amount',1000)));

  -- Incorrect sequence and incomplete pages must never advance the durable cursor.
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,2,last_page);
  exception when others then rejected := true;
  end;
  assert rejected, 'Page 2 must be rejected before page 1';
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,1,first_page||jsonb_build_object('sourceCount',10));
  exception when others then rejected := true;
  end;
  assert rejected, 'Silent provider page-size fallback must be rejected';
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,1,first_page - 'type');
  exception when others then rejected := true;
  end;
  assert rejected, 'Missing response identity cannot pass through SQL null comparisons';
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,1,first_page - 'entries');
  exception when others then rejected := true;
  end;
  assert rejected, 'Missing normalized entry array cannot become an empty successful page';
  assert (select page from bid_archive_private.jobs where type='공사' and day=test_day)=1, 'Rejected responses cannot advance the job';

  perform bid_archive_private.ingest('공사',test_day,1,first_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.page=2 and state.completed_at is null and state.expected_total=1000, 'First page is partial, cursor advances exactly once';
  assert not (select complete from public.bid_archive_coverage where type='공사' and day=test_day), 'Partial snapshot cannot advertise complete coverage';
  assert (select count(*) from bid_archive_private.seen where type='공사' and day=test_day)=999, 'All first-page identities retained for reconciliation';
  assert not (select archived from public.bid_archive_entries where id='__collector_test_old'), 'Old snapshot remains visible until a full replacement completes';

  -- Replaying the wrong page is rejected without deleting collected rows.
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,1,first_page);
  exception when others then rejected := true;
  end;
  assert rejected, 'Replayed first page must be rejected once cursor advanced';

  -- Equal totals with reordered/duplicated data must restart, not get stuck retrying page 2.
  repeated_page := last_page || jsonb_build_object('entries',jsonb_build_array(first_page->'entries'->0));
  perform bid_archive_private.ingest('공사',test_day,2,repeated_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.page=1 and state.expected_total is null and state.completed_at is null, 'Repeated records restart a clean snapshot';
  assert state.failures=1, 'Ordering restarts count as failed day traversals';
  assert state.next_attempt>now(), 'Repeated ordering receives collection backoff';
  assert not exists(select 1 from bid_archive_private.seen where type='공사' and day=test_day), 'Restart removes old seen identities';
  assert not (select complete from public.bid_archive_coverage where type='공사' and day=test_day), 'Restarted snapshot remains incomplete';

  -- A total changing during traversal also restarts before applying the inconsistent page.
  perform bid_archive_private.ingest('공사',test_day,1,first_page);
  changed_page := last_page || jsonb_build_object('totalCount',1001,'sourceCount',2,
    'entries',(last_page->'entries')||jsonb_build_array((last_page->'entries'->0)||jsonb_build_object('id','__collector_test_entry_1001')));
  perform bid_archive_private.ingest('공사',test_day,2,changed_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.page=1 and state.expected_total is null and state.completed_at is null, 'Changing provider totals restart the snapshot';
  assert state.failures=2, 'Successful intermediate pages must not erase repeated day failures';
  assert not exists(select 1 from bid_archive_private.seen where type='공사' and day=test_day), 'Total-change restart clears seen';
  assert not exists(select 1 from public.bid_archive_entries where id='__collector_test_entry_1001'), 'Inconsistent-total page is not ingested';

  perform bid_archive_private.ingest('공사',test_day,1,first_page);
  perform bid_archive_private.ingest('공사',test_day,2,last_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.completed_at is null and state.page=1 and state.last_snapshot_digest is not null, 'First complete traversal queues an identity-set verification';
  assert state.verified_at is null and state.next_attempt>now(), 'Verification waits before another provider traversal';
  assert not (select complete from public.bid_archive_coverage where type='공사' and day=test_day), 'One full traversal cannot advertise complete coverage';
  assert not (select archived from public.bid_archive_entries where id='__collector_test_old'), 'First complete pass cannot hide previous valid records';
  first_digest := state.last_snapshot_digest;

  -- A same-count replacement is not caught by total/duplicate checks. It must
  -- receive its own second matching traversal before old data can be archived.
  replacement_page := last_page || jsonb_build_object('entries',
    jsonb_build_array((last_page->'entries'->0)||jsonb_build_object('id','__collector_test_entry_replacement')));
  perform bid_archive_private.ingest('공사',test_day,1,first_page);
  perform bid_archive_private.ingest('공사',test_day,2,replacement_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.completed_at is null and state.verified_at is null, 'Same-count changed identity set is still incomplete';
  assert state.last_snapshot_digest<>first_digest and state.failures=1, 'Changed candidate replaces digest and records inconsistency';
  assert not (select archived from public.bid_archive_entries where id='__collector_test_entry_1000'), 'Missing old row survives a single changed snapshot';
  assert not (select archived from public.bid_archive_entries where id='__collector_test_old'), 'Original snapshot survives candidate changes';

  perform bid_archive_private.ingest('공사',test_day,1,first_page);
  perform bid_archive_private.ingest('공사',test_day,2,replacement_page);
  select * into strict state from bid_archive_private.jobs where type='공사' and day=test_day;
  assert state.completed_at is not null and state.verified_at is not null, 'Two consecutive matching identity sets verify the snapshot';
  assert state.failures=0, 'Confirmed complete snapshot clears failed traversal count';
  assert (select complete from public.bid_archive_coverage where type='공사' and day=test_day), 'Closed-day complete coverage is published';
  assert (select count(*) from public.bid_archive_entries where business_number=test_biz and not archived)=1000, 'Restarts and upserts do not inflate participation counts';
  assert (select archived from public.bid_archive_entries where id='__collector_test_old'), 'Missing old snapshot entry is soft archived only after completion';
  assert (select archived from public.bid_archive_entries where id='__collector_test_entry_1000'), 'Superseded candidate row archived only after matching verification';
  assert not exists(select 1 from bid_archive_private.seen where type='공사' and day=test_day), 'Completed snapshot releases temporary identities';
  assert exists(select 1 from bid_archive_private.jobs where type='공사' and day=test_day-1), 'Completing a day queues the preceding day';

  -- A final-page replay after seen cleanup must not archive the other 999 valid entries.
  rejected := false;
  begin
    perform bid_archive_private.ingest('공사',test_day,2,last_page);
  exception when others then rejected := true;
  end;
  assert rejected, 'Completed snapshots reject final-page replays';
  assert (select count(*) from public.bid_archive_entries where business_number=test_biz and not archived)=1000,
    'Rejected final-page replay must preserve all completed participation entries';
end;
$$;

do $$
declare
  fixture_today constant date := '2030-06-15';
  settings_before jsonb;
begin
  assert not exists(select 1 from bid_archive_private.jobs where day between '2030-06-01' and '2030-06-18'),
    'Failure cursor fixtures need an unused future date range';
  select to_jsonb(s) into settings_before from bid_archive_private.settings s where singleton;
  insert into bid_archive_private.jobs(type,day,failures,next_attempt) values
    ('공사','2030-06-03',1,now()+interval '1 hour'),
    ('공사','2030-06-06',2,now()+interval '1 hour'),
    ('용역','2030-06-09',3,now()+interval '1 hour'),
    ('공사',fixture_today,2,now()+interval '1 hour'),
    ('용역',fixture_today+2,2,now()+interval '1 hour');
  perform bid_archive_private.seed_failed_predecessors(fixture_today);
  assert not exists(select 1 from bid_archive_private.jobs where type='공사' and day='2030-06-02'), 'One failure does not skip to older dates';
  assert exists(select 1 from bid_archive_private.jobs where type='공사' and day='2030-06-05'), 'Two historical failures seed the preceding day';
  assert exists(select 1 from bid_archive_private.jobs where type='용역' and day='2030-06-08'), 'Other business types can continue backfilling independently';
  assert not exists(select 1 from bid_archive_private.jobs where type='공사' and day=fixture_today-1), 'Today failure does not seed previous day';
  assert not exists(select 1 from bid_archive_private.jobs where type='용역' and day=fixture_today+1), 'Future failure does not seed previous day';
  assert (select failures=2 and completed_at is null and next_attempt>now() from bid_archive_private.jobs where type='공사' and day='2030-06-06'), 'Failed job retains its own retry state';
  assert not exists(select 1 from bid_archive_private.jobs where day='2030-06-04'), 'One tick does not recursively generate an unbounded queue';
  perform bid_archive_private.seed_failed_predecessors(fixture_today);
  assert (select count(*) from bid_archive_private.jobs where day between '2030-06-01' and '2030-06-18')=7, 'Repeated queue seeding is idempotent';
  assert (select request_id is null from bid_archive_private.jobs where type='공사' and day='2030-06-05'), 'Seeding itself makes no provider request';
  assert (select to_jsonb(s)=settings_before from bid_archive_private.settings s where singleton), 'Queue seeding preserves shared call and storage budgets';
end;
$$;

select 'company_collector rollback assertions passed' as result;
rollback;
