-- Catalog gets 24MiB inside the unchanged 32MiB combined application budget.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
select set_config('test.catalog_bytes','18874368',true),set_config('test.combined_bytes','19922944',true);
create or replace function bid_active_catalog_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-rebalance-catalog')
   then 25165824 else current_setting('test.catalog_bytes')::bigint end;
$$;
create or replace function bid_alert_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-rebalance-total')
   then 33554432 else current_setting('test.combined_bytes')::bigint end;
$$;

do $$declare c jsonb;r jsonb;lease text;scope text;raw_ids jsonb;fixture text;failed boolean:=false;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is not null,'an 18MiB catalog can collect inside its 24MiB share and unchanged combined budget';
 lease:=c->>'leaseId';scope:=c->>'scopeVersion';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'catalog share is 24MiB';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined 32MiB limit is unchanged';
 assert c#>>'{status,storageCeiling}'='25165824','status reports the allocated catalog share';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values('fixture-rebalance-ok','공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',scope,lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId','fixture-rebalance-ok','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sources',jsonb_build_array(jsonb_build_object(
   'id','fixture-rebalance-ok','page',1,'totalCount',0,'receivedCount',0,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities','[]'::jsonb,'complete',true))));
 assert r->>'ok'='true' and (select completed_at is not null from bid_active_catalog_private.sources where id='fixture-rebalance-ok'),'post-write guard uses runtime catalog allocation instead of the former 16MiB limit';
 select jsonb_agg('R26REBALANCE'||lpad(i::text,4,'0')||':000') into raw_ids from generate_series(1,999) i;
 foreach fixture in array array['fixture-rebalance-catalog','fixture-rebalance-total'] loop
   update bid_active_catalog_private.runtime set storage_blocked=false,last_error=null;
   insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
   values(fixture,'공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',scope,lease::uuid);
   perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',fixture,'page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
   r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sources',jsonb_build_array(jsonb_build_object(
     'id',fixture,'page',1,'totalCount',1000,'receivedCount',999,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities',raw_ids,'complete',false))));
   assert r->>'ok'='false' and r->>'storageFull'='true','catalog 24MiB and combined 32MiB both reject an actual post-write crossing';
   assert (select page=1 and processed_count=0 and completed_at is null from bid_active_catalog_private.sources where id=fixture),'either capacity boundary rolls back the source acknowledgement';
   assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id=fixture),'either capacity boundary rolls back new raw identities';
   assert exists(select 1 from bid_active_catalog_private.index_batches where source_id=fixture and page=1),'already durable index fence remains available for retry';
 end loop;
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 perform set_config('test.combined_bytes','33554400',true);
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is null,'24MiB catalog allocation never bypasses the existing combined preflight reserve';
 begin update bid_alert_private.runtime set storage_ceiling=41943040;exception when check_violation then failed:=true;end;
 assert failed and (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined budget constraint cannot be raised by this reallocation';
 failed:=false;
 begin update bid_active_catalog_private.runtime set storage_ceiling=33554432;exception when check_violation then failed:=true;end;
 assert failed,'catalog remains bounded by its fixed 24MiB allocation';
 assert (select column_default::bigint=25165824 from information_schema.columns where table_schema='bid_active_catalog_private' and table_name='runtime' and column_name='storage_ceiling'),'new catalog runtime default is 24MiB';
 failed:=false;
 begin perform public.bid_active_catalog_worker('wrong','claim','{}');exception when insufficient_privilege then failed:=true;end;
 assert failed,'token authorization is unchanged by budget reallocation';
 assert not has_function_privilege('anon','bid_active_catalog_private.worker_before_current(text,text,jsonb)','execute'),'private worker remains inaccessible';
end $$;
rollback;
