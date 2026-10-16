-- Actual saved-rule matches get bounded recurring verification ahead of backlog.
-- Keep the existing queue, retry state, reservations, leases and storage budgets.
begin;
create or replace function bid_active_catalog_private.matching_request_key()
returns text language sql stable security invoker set search_path='' as $$
 select 'alerts:'||encode(sha256(convert_to(bid_active_catalog_private.rules()::text,'UTF8')),'hex');
$$;
do $$declare definition text;anchor text;replacement text;begin
 select replace(pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('current-matching-verification-v1' in definition)=0 then
  anchor:='accepted_observations jsonb:=''[]''::jsonb;';
  if position(anchor in definition)=0 then raise exception 'Audited accepted-observation declaration changed';end if;
  definition:=replace(definition,anchor,anchor||' matching_keys jsonb:=''[]''::jsonb; matching_count integer:=0; matching_marker text; catalog_ceiling bigint; matching_stamp timestamptz;');
  anchor:=$a$-- The application uses commit({finish:true})$a$;
  replacement:=$a$-- current-matching-verification-v1: validate only after token and lease guards.
 if p_action='commit' and p_payload?'matchingKeys' then
   matching_keys:=p_payload->'matchingKeys';
   if jsonb_typeof(matching_keys) is distinct from 'array' then
     raise exception using errcode='22023',message='Invalid matching verification keys';end if;
   matching_count:=jsonb_array_length(matching_keys);
   if matching_count>150 or exists(select 1 from jsonb_array_elements(matching_keys) k
       where jsonb_typeof(k) is distinct from 'string' or (k#>>'{}')!~'^g2b:(공사|용역):[A-Za-z0-9_-]{1,40}$')
     or matching_count<>(select count(distinct k#>>'{}') from jsonb_array_elements(matching_keys) k) then
     raise exception using errcode='22023',message='Invalid matching verification keys';end if;
   if matching_count>0 then
     if jsonb_typeof(p_payload->'observations') is distinct from 'array' then
       raise exception using errcode='22023',message='Matching verification requires accepted observations';end if;
     if jsonb_array_length(p_payload->'observations')=0 then
       raise exception using errcode='22023',message='Matching verification requires accepted observations';end if;
   end if;
 end if;
 -- The application uses commit({finish:true})$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited alert finalization guard changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$if storage_size+octet_length(p_payload::text)*3>=cfg.storage_ceiling then$a$;
  replacement:=$a$if matching_count>0 then
     -- Do not invert the catalog -> alert runtime lock order: this is a read.
     select storage_ceiling into strict catalog_ceiling from bid_active_catalog_private.runtime where singleton;
   end if;
   if storage_size+octet_length(p_payload::text)*3+(case when matching_count>0 then matching_count*1536+65536 else 0 end)>=cfg.storage_ceiling
     or matching_count>0 and bid_active_catalog_private.storage_bytes()+matching_count*1536+65536>=catalog_ceiling then$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited alert capacity preflight changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$for item in select value from jsonb_array_elements(coalesce(p_payload->'events','[]'::jsonb)) loop$a$;
  replacement:=$a$if matching_count>0 then
     if exists(select 1 from jsonb_array_elements_text(matching_keys) k
       where not exists(select 1 from jsonb_array_elements(accepted_observations) o where o->>'key'=k)) then
       raise exception using errcode='22023',message='Matching verification requires accepted observations';end if;
     matching_marker:=bid_active_catalog_private.matching_request_key();matching_stamp:=clock_timestamp();
     insert into bid_active_catalog_private.verification as v(type,number,revision,source_updated_at,scope_version,source_version,search_request_key,search_requested_at)
     select d.type,d.number,d.revision,d.source_updated_at,bid_active_catalog_private.scope_version(),d.source_version,matching_marker,matching_stamp
     from bid_active_catalog_private.deadline_index d
     where 'g2b:'||d.type||':'||d.number in(select jsonb_array_elements_text(matching_keys))
       and bid_active_catalog_private.ongoing(d.notice,matching_stamp)
       and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
         and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
     on conflict(type,number) do update set
       revision=case when excluded.revision>v.revision then excluded.revision else v.revision end,
       source_updated_at=case when excluded.revision>v.revision or excluded.revision=v.revision and (v.source_updated_at is null or excluded.source_updated_at>v.source_updated_at)
         then excluded.source_updated_at else v.source_updated_at end,
       source_version=case when excluded.revision>v.revision or excluded.revision=v.revision and (v.source_updated_at is null or excluded.source_updated_at>v.source_updated_at
         or excluded.source_updated_at=v.source_updated_at and v.source_version is null) then excluded.source_version else v.source_version end,
       scope_version=excluded.scope_version,search_request_key=excluded.search_request_key,search_requested_at=excluded.search_requested_at;
   end if;
   for item in select value from jsonb_array_elements(coalesce(p_payload->'events','[]'::jsonb)) loop$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited accepted-observation publication changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$if bid_alert_private.storage_bytes()>=cfg.storage_ceiling then$a$;
  replacement:=$a$if matching_count>0 and bid_active_catalog_private.storage_bytes()>=catalog_ceiling then
     raise exception using errcode='54000',message='Matching verification exceeds catalog capacity';end if;
   if bid_alert_private.storage_bytes()>=cfg.storage_ceiling then$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited alert physical capacity guard changed';end if;
  execute replace(definition,anchor,replacement);
 end if;

 select replace(pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('trusted-force-collection-v1' in definition)=0 then
  anchor:=$a$if p_action='claim' then$a$;
  replacement:=$a$-- trusted-force-collection-v1: maintenance only; token and runtime lock already checked.
 if p_action='claim' and p_payload?'forceCollection' and jsonb_typeof(p_payload->'forceCollection') is distinct from 'boolean' then
   raise exception using errcode='22023',message='Invalid forced collection flag';end if;
 if p_action='claim' then$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited alert claim guard changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$due:=not is_dispatch and not menu_paused and ($a$;
  replacement:=$a$due:=not is_dispatch and not menu_paused and (coalesce(p_payload->'forceCollection'='true'::jsonb,false) or $a$;
  if position(anchor in definition)=0 then raise exception 'Audited alert due condition changed';end if;
  execute replace(definition,anchor,replacement);
 end if;

 select replace(pg_get_functiondef('bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('current-matching-priority-v1' in definition)=0 then
  anchor:='declare selected_keys text[];versions jsonb;';
  if position(anchor in definition)=0 then raise exception 'Audited verification priority declaration changed';end if;
  definition:=replace(definition,anchor,anchor||' alert_key text:=bid_active_catalog_private.matching_request_key(); -- current-matching-priority-v1');
  anchor:='then -10 else 0 end) + bid_active_catalog_private.collection_priority(notice,p_stamp) urgency';
  if position(anchor in definition)=0 then raise exception 'Audited current verification priority changed';end if;
  definition:=replace(definition,anchor,'then -10 else 0 end) + case when search_request_key=alert_key then -20 else 0 end + bid_active_catalog_private.collection_priority(notice,p_stamp) urgency');
  anchor:=$a$||case when d.notice is not null$a$;
  if position(anchor in definition)=0 then raise exception 'Audited verification identity projection changed';end if;
  replacement:=$a$||case when v.search_request_key=alert_key then jsonb_build_object('refreshMatching',true) else '{}'::jsonb end
   ||case when d.notice is not null$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  execute replace(definition,anchor,replacement);
 end if;

 select replace(pg_get_functiondef('bid_active_catalog_private.request_search_verification(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('preserve-current-matching-priority-v1' in definition)=0 then
  anchor:=$a$where v.scope_version=scope and (v.search_requested_at is null$a$;
  replacement:=$a$where v.scope_version=scope and v.search_request_key is distinct from bid_active_catalog_private.matching_request_key() -- preserve-current-matching-priority-v1
   and (v.search_requested_at is null$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited browser search-demand update changed';end if;
  execute replace(definition,anchor,replacement);
 end if;
end $$;
revoke all on function bid_active_catalog_private.matching_request_key() from public,anon,authenticated;
revoke all on function bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.request_search_verification(jsonb) from public,anon,authenticated;
commit;
