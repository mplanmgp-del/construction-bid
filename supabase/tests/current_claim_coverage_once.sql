-- Successful claims need one current-coverage evaluation, including all metadata.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
alter function bid_active_catalog_private.current_coverage() rename to coverage_before_counted_test;
create function bid_active_catalog_private.current_coverage()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 perform set_config('test.current_coverage_calls',(coalesce(nullif(current_setting('test.current_coverage_calls',true),''),'0')::integer+1)::text,true);
 return bid_active_catalog_private.coverage_before_counted_test();
end $$;
revoke all on function bid_active_catalog_private.current_coverage() from public,anon,authenticated;

do $$declare c jsonb;again jsonb;r jsonb;failed boolean:=false;begin
 perform set_config('test.current_coverage_calls','0',true);
 begin perform public.bid_active_catalog_worker('wrong','claim','{}');exception when insufficient_privilege then failed:=true;end;
 assert failed and current_setting('test.current_coverage_calls')='0','invalid token is rejected before coverage or collection';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is not null,'ordinary authorized claim remains available';
 assert current_setting('test.current_coverage_calls')='1','successful current claim evaluates current coverage only once';
 assert c#>>'{status,currentCoverage,scope}'='demolition-title-v1','successful claim keeps complete current metadata';
 assert c#>>'{status,currentCoverage,pending}'=(select count(*)::text from bid_active_catalog_private.sources where kind='current' and completed_at is null),'successful metadata uses the post-seeding coverage';
 assert c#>>'{status,pendingSources}'=(select count(*)::text from bid_active_catalog_private.sources where kind<>'current' and completed_at is null),'legacy pending-source count still excludes current sweep';
 perform set_config('test.current_coverage_calls','0',true);
 again:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert again->>'leaseId' is null and jsonb_array_length(again->'sources')=0,'busy claim cannot steal an active lease';
 assert current_setting('test.current_coverage_calls')='1' and again#>>'{status,currentCoverage,scope}'='demolition-title-v1','busy claim retains full current metadata';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 perform set_config('test.current_coverage_calls','0',true);
 r:=public.bid_active_catalog_worker(repeat('a',64),'page','{"limit":1}');
 assert current_setting('test.current_coverage_calls')='1' and r#>>'{status,currentCoverage,scope}'='demolition-title-v1','ordinary page action retains full current metadata';
 perform set_config('test.current_coverage_calls','0',true);
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is not null and current_setting('test.current_coverage_calls')='1','subsequent successful claim also evaluates coverage only once';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'catalog storage limit unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined storage limit unchanged';
 assert not has_function_privilege('anon','bid_active_catalog_private.worker_legacy(text,text,jsonb)','execute'),'legacy collection remains private';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.worker_before_current(text,text,jsonb)','execute'),'verified collection remains private';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;
rollback;
