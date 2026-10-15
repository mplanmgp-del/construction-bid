-- User-requested MY입찰관리 reset. Target project: zjmhmyzgsmglrictwqtd.
-- Destructive maintenance; execute separately from automatic migrations.
-- Keeps auth, member workspaces/bookmarks, alarm settings/inbox and alarm cursors.
begin;
set local lock_timeout='15s';
select pg_advisory_xact_lock(62614001);
select pg_advisory_xact_lock(62614002);
update bid_archive_private.settings set enabled=false,index_enabled=false,openings_enabled=false where singleton;
do $$ declare j record; definition text; begin
  for j in select jobid from cron.job where jobname in ('company-history-collector','bid-company-opening-archive') loop
    perform cron.alter_job(j.jobid,active:=false);
  end loop;
  select pg_get_functiondef('public.bid_watch_company(text)'::regprocedure) into definition;
  if position('자동 수집이 중지되어 있습니다' in definition)=0 then
    definition:=replace(definition,'  perform pg_advisory_xact_lock(62614002);',
      '  perform pg_advisory_xact_lock(62614002); if not exists(select 1 from bid_archive_private.settings where singleton and enabled and index_enabled) then return jsonb_build_object(''status'',''paused'',''queued'',false,''message'',''자동 수집이 중지되어 있습니다''); end if;');
    execute definition;
  end if;
end $$;
-- Explicit list deliberately omits CASCADE; unexpected external references abort.
truncate table
  public.bid_archive_contract_parties,public.bid_archive_contracts,
  public.bid_archive_entries,public.bid_archive_notices,public.bid_company_profiles,
  public.bid_archive_companies,public.bid_archive_coverage,public.bid_contract_coverage,
  public.bid_archive_opening_snapshots,
  bid_archive_private.contract_seen,bid_archive_private.index_jobs,
  bid_archive_private.seen,bid_archive_private.jobs,
  bid_archive_private.notice_jobs,bid_archive_private.watched_companies;
update public.bid_archive_health set status='paused',
  message='요청에 따라 MY입찰관리의 기존 수집 자료를 초기화했습니다. 자동 수집은 중지되어 있습니다.',
  updated_at=now(),pending_jobs=0,storage_bytes=0 where singleton;
commit;
