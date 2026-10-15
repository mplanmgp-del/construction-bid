-- Reallocate the catalog's share; the combined application budget stays 32MiB.
begin;
do $$begin
 if exists(select 1 from bid_active_catalog_private.runtime where storage_ceiling not in (16777216,25165824)) then
   raise exception 'Unexpected catalog allocation; preserve the configured budget';end if;
 if exists(select 1 from bid_alert_private.runtime where storage_ceiling<>33554432) then
   raise exception 'Unexpected combined storage budget; do not change its allocation';end if;
end $$;
alter table bid_active_catalog_private.runtime drop constraint if exists runtime_storage_ceiling_check;
alter table bid_active_catalog_private.runtime alter column storage_ceiling set default 25165824;
update bid_active_catalog_private.runtime set storage_ceiling=25165824 where singleton;
alter table bid_active_catalog_private.runtime add constraint runtime_storage_ceiling_check check(storage_ceiling=25165824);

-- This is the one runtime guard that still used a literal catalog ceiling.
-- All lease, auth, scope, savepoint, combined-cap and retry checks are retained.
do $$declare definition text;old_guard text;new_guard text;begin
 select pg_get_functiondef('public.bid_active_catalog_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('current-runtime-catalog-budget-v1' in definition)=0 then
   old_guard:=$a$and (bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432) then$a$;
   new_guard:=$a$and (bid_active_catalog_private.storage_bytes()>=(select storage_ceiling from bid_active_catalog_private.runtime where singleton)
        or bid_alert_private.storage_bytes()>=33554432) then -- current-runtime-catalog-budget-v1$a$;
   if position(old_guard in definition)=0 then raise exception 'Current source post-write budget anchor changed';end if;
   execute replace(definition,old_guard,new_guard);
 end if;
end $$;
do $$begin
 if bid_active_catalog_private.storage_bytes()>=(select storage_ceiling from bid_active_catalog_private.runtime where singleton)
   or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Existing records exceed the allocated catalog or unchanged combined budget';end if;
end $$;
commit;
