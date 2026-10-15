-- A successful current claim replaces both nested statuses at its public edge.
-- Keep busy/fallback/action metadata and all collection guards unchanged.
begin;
do $$declare definition text;old_value text;new_value text;begin
 select pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure) into definition;
 if position('current-claim-legacy-status-v1' in definition)=0 then
   old_value:=$a$from bid_active_catalog_private.verification v where v.claimed_lease=lease),'status',bid_active_catalog_private.status());$a$;
   new_value:=$a$from bid_active_catalog_private.verification v where v.claimed_lease=lease),'status',bid_active_catalog_private.status_before_current() /* current-claim-legacy-status-v1 */);$a$;
   if position(old_value in definition)=0 then raise exception 'Successful legacy claim status anchor changed';end if;
   execute replace(definition,old_value,new_value);
 end if;

 select pg_get_functiondef('bid_active_catalog_private.worker_before_current(text,text,jsonb)'::regprocedure) into definition;
 if position('current-claim-verified-status-v1' in definition)=0 then
   old_value:=$a$return outcome||jsonb_build_object('verify',versions,'status',bid_active_catalog_private.status());$a$;
   new_value:=$a$return outcome||jsonb_build_object('verify',versions,'status',bid_active_catalog_private.status_before_current() /* current-claim-verified-status-v1 */);$a$;
   if position(old_value in definition)=0 then raise exception 'Successful verified claim status anchor changed';end if;
   execute replace(definition,old_value,new_value);
 end if;

 select pg_get_functiondef('public.bid_active_catalog_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('current-claim-final-status-v1' in definition)=0 then
   old_value:=$a$return outcome||jsonb_build_object('sources',source_rows,'status',bid_active_catalog_private.status());$a$;
   new_value:=$a$return outcome||jsonb_build_object('sources',source_rows,'status',
     bid_active_catalog_private.status_before_current()||jsonb_build_object(
       'pendingSources',(select count(*) from bid_active_catalog_private.sources where scope_version=bid_active_catalog_private.scope_version() and kind<>'current' and completed_at is null),
       'currentCoverage',coverage) /* current-claim-final-status-v1 */);$a$;
   if position(old_value in definition)=0 then raise exception 'Successful current claim status anchor changed';end if;
   execute replace(definition,old_value,new_value);
 end if;
end $$;
-- Replacements preserve each function's existing authorization and privileges.
revoke all on function bid_active_catalog_private.worker_legacy(text,text,jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_before_current(text,text,jsonb) from public,anon,authenticated;
commit;
