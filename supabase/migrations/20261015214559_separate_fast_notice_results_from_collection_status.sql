-- Fast result pages and asynchronous collection metadata share the exact same
-- audited normalization, filtering, ordering and signed-cursor validation.
begin;
do $$declare source_body text;fast_body text;status_body text;prefix text;from_clause text;counts_block text;boundary_block text;coverage_block text;
 ranged_at integer;counts_at integer;page_at integer;from_at integer;into_at integer;boundary_at integer;more_at integer;coverage_at integer;return_at integer;
 anchor text;replacement text;definition text;
begin
 select p.prosrc into strict source_body from pg_proc p where p.oid='bid_active_catalog_private.search_page(jsonb)'::regprocedure;
 ranged_at:=position(' with ranged as materialized (' in source_body);
 counts_at:=position(' ),counts as (' in source_body);
 page_at:=position(' ),page_rows as materialized (' in source_body);
 from_at:=position('   from bid_active_catalog_private.deadline_index d' in source_body);
 into_at:=position(' into total_count,verified_count,pending_count,condition_count,result_items,more,last_key from counts;' in source_body);
 coverage_at:=position(' coverage:=bid_active_catalog_private.index_coverage();' in source_body);
 return_at:=position(' return jsonb_build_object(''items'',result_items' in source_body);
 if least(ranged_at,counts_at,page_at,from_at,into_at,coverage_at,return_at)<=0
   or not(ranged_at<from_at and from_at<counts_at and counts_at<page_at and into_at<coverage_at and coverage_at<return_at) then
   raise exception 'Audited search boundaries changed';end if;
 prefix:=left(source_body,ranged_at-1);
 from_clause:=substring(source_body from from_at for counts_at-from_at);
 counts_block:=substring(source_body from counts_at for page_at-counts_at);
 boundary_at:=position(' if cursor_value='''' then' in substring(source_body from into_at))+into_at-1;
 more_at:=position(' if more then' in substring(source_body from into_at))+into_at-1;
 if boundary_at<into_at or more_at<=boundary_at or more_at>=coverage_at then raise exception 'Audited search expiry boundary changed';end if;
 boundary_block:=substring(source_body from boundary_at for more_at-boundary_at);
 coverage_block:=substring(source_body from coverage_at for return_at-coverage_at);

 fast_body:=left(source_body,coverage_at-1)||$body$
 return jsonb_build_object('items',result_items,'totalCount',total_count,'page',page_number,'pageSize',page_limit,'hasMore',more,
   'fetchedAt',statement_timestamp(),'source','나라장터 검증 공고 색인','nextCursor',next_cursor,'snapshotVersion',generation,'asOf',as_of,'validUntil',valid_until);
end $body$;
 fast_body:=replace(fast_body,counts_block,$body$ ),counts as (
   select count(*) filter(where verified and classification in ('match','match_unknown')) total from ranged
$body$);
 anchor:=') select counts.total,counts.verified_total,counts.pending_total,counts.conditions_total,';
 if position(anchor in fast_body)=0 then raise exception 'Audited result count projection changed';end if;
 fast_body:=replace(fast_body,anchor,') select counts.total,');
 fast_body:=replace(fast_body,'into total_count,verified_count,pending_count,condition_count,result_items,more,last_key from counts;',
   'into total_count,result_items,more,last_key from counts;');
 anchor:=E'   from bid_active_catalog_private.deadline_index d\n   where (business=';
 replacement:=E'   from bid_active_catalog_private.deadline_index d\n   where d.verified_at is not null and d.source_version=d.verified_version and (business=';
 if position(anchor in fast_body)=0 then raise exception 'Audited result publication predicate anchor changed';end if;
 -- Only published rows can contribute to a result total or page. Pending-row
 -- condition classification belongs exclusively to the metadata request.
 fast_body:=replace(fast_body,anchor,replacement);
 execute format('create or replace function bid_active_catalog_private.search_results(p_payload jsonb) returns jsonb language plpgsql stable security invoker set search_path='''' as %L',fast_body);

 -- Metadata is tied to the first result's time and generation. A source update
 -- or schedule boundary cannot attach a fresh completion claim to old results.
 anchor:='sort_name:=f->>''sort'';generation:=cfg.search_generation::text;valid_until:=as_of+interval ''10 minutes'';';
 if position(anchor in prefix)=0 then raise exception 'Audited search anchor initialization changed';end if;
 replacement:=$body$sort_name:=f->>'sort';generation:=cfg.search_generation::text;
 if coalesce(p_payload->>'cursor','')<>'' or jsonb_typeof(p_payload->'asOf') is distinct from 'string'
   or coalesce(p_payload->>'asOf','')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
   or jsonb_typeof(p_payload->'snapshotVersion') is distinct from 'string' or coalesce(p_payload->>'snapshotVersion','')!~'^[0-9]+$' then
   raise exception using errcode='22023',message='검색 상태의 조회 기준을 확인해 주세요.';end if;
 begin as_of:=(p_payload->>'asOf')::timestamptz;exception when others then raise exception using errcode='22023',message='검색 상태의 조회 시각을 확인해 주세요.';end;
 if p_payload->>'snapshotVersion' is distinct from generation or not isfinite(as_of)
   or as_of>statement_timestamp()+interval '5 seconds' or as_of<statement_timestamp()-interval '10 minutes' then
   raise exception using errcode='P0001',message='SEARCH_CHANGED';end if;
 valid_until:=as_of+interval '10 minutes';$body$;
 status_body:=replace(prefix,anchor,replacement)||$body$ with ranged as materialized (
   select d.verified_at is not null and d.source_version=d.verified_version verified,
     case when simple_filters then 'match' else bid_active_catalog_private.search_match(d.notice,f,profile,as_of) end classification
$body$||from_clause||$body$ ) select count(*) filter(where verified and classification<>'excluded'),
   count(*) filter(where not verified and classification<>'excluded'),
   count(*) filter(where classification in ('pending','match_unknown'))
 into verified_count,pending_count,condition_count from ranged;
$body$||boundary_block||$body$ if valid_until<=statement_timestamp() then raise exception using errcode='P0001',message='SEARCH_CHANGED';end if;
$body$||coverage_block||$body$
 return jsonb_build_object('snapshotVersion',generation,'asOf',as_of,'indexCoverage',coverage,
   'currentCoverage',bid_active_catalog_private.current_coverage(),'sourceSyncedThrough',synced,
   'verifiedCount',verified_count,'pendingCount',pending_count,'conditionPendingCount',condition_count,
   'storage',jsonb_build_object('bytes',storage_size,'ceiling',cfg.storage_ceiling,'full',cfg.storage_blocked or storage_size+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432),
   'sourceError',cfg.last_error,'warnings',case when coverage->>'complete'='true' then '[]'::jsonb else '["공통 공고 수집·검증이 진행 중입니다. 확인한 범위의 결과입니다."]'::jsonb end);
end $body$;
 execute format('create or replace function bid_active_catalog_private.search_status(p_payload jsonb) returns jsonb language plpgsql stable security invoker set search_path='''' as %L',status_body);

 -- The existing token and payload gates run before these branches. The old
 -- search_page action is preserved for compatibility. Only the asynchronous
 -- metadata action may mark bounded verification demand.
 select pg_get_functiondef('bid_active_catalog_private.worker_before_current(text,text,jsonb)'::regprocedure) into definition;
 if position('separate-fast-search-actions-v1' in definition)=0 then
   anchor:='if p_action=''search_page'' then outcome:=bid_active_catalog_private.search_page(p_payload);perform bid_active_catalog_private.request_search_verification(p_payload);return outcome;end if;';
   if position(anchor in definition)=0 then raise exception 'Audited public search action gate changed';end if;
   replacement:=$body$-- separate-fast-search-actions-v1
 if p_action='search_results' then return bid_active_catalog_private.search_results(p_payload);end if;
 if p_action='search_status' then
   outcome:=bid_active_catalog_private.search_status(p_payload);
   perform bid_active_catalog_private.request_search_verification(p_payload-array['asOf','snapshotVersion']);
   return outcome;
 end if;
 $body$||anchor;
   execute replace(definition,anchor,replacement);
 end if;
end $$;
revoke all on function bid_active_catalog_private.search_results(jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.search_status(jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_before_current(text,text,jsonb) from public,anon,authenticated;
commit;
