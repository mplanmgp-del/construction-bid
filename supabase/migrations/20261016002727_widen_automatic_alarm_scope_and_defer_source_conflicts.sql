-- Automatic alerts use every ongoing head; user conditions own their range.
-- Preserve current-head safety, durable ledgers, authenticated leases and caps.
begin;
create or replace function bid_active_catalog_private.alarm_active(p_notice jsonb,p_now timestamptz default now())
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare current_notice jsonb;
begin
 select q.notice into current_notice from (
   select p_notice notice,coalesce((p_notice->>'revision')::integer,0) revision,nullif(p_notice->>'sourceUpdatedAt','')::timestamptz source_updated_at
   union all select g.latest,g.revision,g.source_updated_at from bid_active_catalog_private.groups g
     where g.type=p_notice->>'type' and g.number=p_notice->>'number'
   union all select d.notice,d.revision,d.source_updated_at from bid_active_catalog_private.deadline_index d
     where d.type=p_notice->>'type' and d.number=p_notice->>'number'
   union all select jsonb_build_object('status','취소'),h.revision,h.source_updated_at from bid_active_catalog_private.deadline_invalidations h
     where h.type=p_notice->>'type' and h.number=p_notice->>'number'
 ) q order by q.revision desc,q.source_updated_at desc nulls last,
   (not bid_active_catalog_private.ongoing(q.notice,p_now)) desc limit 1;
 return bid_active_catalog_private.ongoing(current_notice,p_now);
exception when invalid_datetime_format or datetime_field_overflow then return false;
end $$;

-- These values contain only allowlisted compact public notice facts. The
-- server uses them to distinguish a race from a persistent endpoint mismatch.
create or replace function bid_active_catalog_private.publication_conflict(p_head jsonb,p_indexed jsonb,p_source_version text,
 p_expected_revision integer default null,p_expected_time timestamptz default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('conflict',case
   when (p_head->>'revision')::integer<greatest((p_indexed->>'revision')::integer,p_expected_revision) then 'older_revision'
   when (p_head->>'sourceUpdatedAt')::timestamptz<greatest((p_indexed->>'sourceUpdatedAt')::timestamptz,p_expected_time) then 'older_source_time'
   else 'same_clock_content' end,
   'changedFields',(select coalesce(jsonb_agg(key order by key),'[]'::jsonb)
     from jsonb_object_keys(coalesce(p_head,'{}'::jsonb)||coalesce(p_indexed,'{}'::jsonb))key
     where key<>all(array['allowedRegions','licenses','regionComplete','licenseComplete','openingCompleted','status',
       'description','documents','requirements','duration']) and p_head->key is distinct from p_indexed->key),
   'indexedHead',p_indexed,'sourceVersion',p_source_version);
$$;

do $$declare definition text;anchor text;replacement text;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_deadline(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('unbounded-automatic-alarm-page-v1' in definition)=0 then
  anchor:=$a$today:=(stamp at time zone 'Asia/Seoul')::date;first_day:=today-7;last_day:=today+7;$a$;
  if position(anchor in definition)=0 then raise exception 'Audited alarm range initialization changed';end if;
  definition:=replace(definition,anchor,'-- unbounded-automatic-alarm-page-v1');
  anchor:=$a$     select d.type,d.number from bid_active_catalog_private.deadline_index d
       where d.deadline>=first_day::timestamp at time zone 'Asia/Seoul' and d.deadline<(last_day+1)::timestamp at time zone 'Asia/Seoul'
     union select g.type,g.number from bid_active_catalog_private.groups g
       where nullif(g.latest->>'deadline','')::timestamptz>=first_day::timestamp at time zone 'Asia/Seoul'
       and nullif(g.latest->>'deadline','')::timestamptz<(last_day+1)::timestamp at time zone 'Asia/Seoul'$a$;
  replacement:=$a$     select d.type,d.number from bid_active_catalog_private.deadline_index d
     union select g.type,g.number from bid_active_catalog_private.groups g$a$;
  -- Windows SQL editor models also give multiline literals CRLF. Normalize
  -- both operands, not only the function definition read from PostgreSQL.
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  -- Retain compatibility with an exactly one-space-indented anchor spelling;
  -- the raw production definition keeps its normal indentation unchanged.
  if position(anchor in definition)=0 then anchor:=regexp_replace(anchor,E'^[\t ]+',' ','gn');end if;
  if position(anchor in definition)=0 then raise exception 'Audited alarm candidate range changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$         and (nullif(latest->>'deadline','')::timestamptz at time zone 'Asia/Seoul')::date between first_day and last_day
$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');
  if position(anchor in definition)=0 then anchor:=regexp_replace(anchor,E'^[\t ]+',' ','gn');end if;
  if position(anchor in definition)=0 then raise exception 'Audited inactive alarm range changed';end if;
  execute replace(definition,anchor,'');
 end if;

 select replace(pg_get_functiondef('bid_active_catalog_private.worker_before_current(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('structured-source-publication-retry-v1' in definition)=0 then
  anchor:='head_hash text;';
  if position(anchor in definition)=0 then raise exception 'Audited source publication declarations changed';end if;
  definition:=replace(definition,anchor,'head_hash text;conflict_detail text;cas_allowed boolean; -- structured-source-publication-retry-v1');
  anchor:=$a$if jsonb_typeof(p_payload->'groups') is distinct from 'array' or jsonb_array_length(p_payload->'groups') not between 1 and 16 then raise exception 'Invalid shared verified batch';end if;$a$;
  replacement:=anchor||$a$
   if p_payload?'expectedSourceVersion' and (jsonb_typeof(p_payload->'expectedSourceVersion') is distinct from 'string'
     or coalesce(p_payload->>'expectedSourceVersion','')!~'^[0-9a-f]{64}$' or jsonb_array_length(p_payload->'groups')<>1) then
     raise exception using errcode='22023',message='Invalid source reconciliation precondition';end if;$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited publication batch validation changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$if revision_value<candidate.revision or revision_value=candidate.revision and source_time<candidate.source_updated_at then raise exception 'Stale shared history';end if;$a$;
  replacement:=$a$if revision_value<candidate.revision or revision_value=candidate.revision and source_time<candidate.source_updated_at then
         select * into indexed from bid_active_catalog_private.deadline_index where type=typ and number=number_value for update;
         raise exception using errcode='PBC01',message='SHARED_SOURCE_CHANGED',
           detail=bid_active_catalog_private.publication_conflict(head,indexed.notice,indexed.source_version,candidate.revision,candidate.source_updated_at)::text;
       end if;$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited stale queued history guard changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$if found and (revision_value<indexed.revision or revision_value=indexed.revision and source_time<indexed.source_updated_at
         or revision_value=indexed.revision and source_time=indexed.source_updated_at and head_hash is distinct from indexed.source_version)
         then raise exception 'Stale shared source facts';end if;$a$;
  replacement:=$a$
         -- Only the trusted worker's repeated listing/full-history agreement
         -- may repair an omitted-content digest under this exact source CAS.
         -- Missing preconditions evaluate as false, never as authorization.
         cas_allowed:=(p_payload?'expectedSourceVersion' and revision_value=indexed.revision and source_time=indexed.source_updated_at
           and p_payload->>'expectedSourceVersion'=indexed.source_version
           and candidate.source_version=indexed.source_version
           and coalesce(head->>'sourceOmittedDigest','')~'^[0-9a-f]{64}$'
           and coalesce(indexed.notice->>'sourceOmittedDigest','')~'^[0-9a-f]{64}$'
           and bid_active_catalog_private.source_version(head-'sourceOmittedDigest')=
               bid_active_catalog_private.source_version(indexed.notice-'sourceOmittedDigest')) is true;
       if (p_payload?'expectedSourceVersion' or indexed.type is not null and
         (revision_value<indexed.revision or revision_value=indexed.revision and source_time<indexed.source_updated_at
          or revision_value=indexed.revision and source_time=indexed.source_updated_at and head_hash is distinct from indexed.source_version))
         and not cas_allowed then
           raise exception using errcode='PBC01',message='SHARED_SOURCE_CHANGED',
             detail=bid_active_catalog_private.publication_conflict(head,indexed.notice,indexed.source_version)::text;
       end if;$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then anchor:=regexp_replace(anchor,E'^[\t ]+',' ','gn');end if;
  if position(anchor in definition)=0 then raise exception 'Audited stale public source guard changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true where singleton;return jsonb_build_object('ok',false,'storageFull',true);
   end;
 else$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  replacement:=$a$   exception when sqlstate 'PBC01' then
     get stacked diagnostics conflict_detail=pg_exception_detail;
     -- Raising inside the publication subtransaction rolls back any preceding
     -- group in this batch. No queue acknowledgement or stale write survives.
     return jsonb_build_object('ok',false,'retryRequired',true,'reason','source_changed')||conflict_detail::jsonb;
   when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true where singleton;return jsonb_build_object('ok',false,'storageFull',true);
   end;
 else$a$;
  if position(anchor in definition)=0 then anchor:=regexp_replace(anchor,E'^[\t ]+',' ','gn');end if;
  if position(anchor in definition)=0 then raise exception 'Audited shared publication exception fence changed';end if;
  execute replace(definition,anchor,replacement);
 end if;
end $$;
-- An upstream modification can leave its source timestamp unchanged. The
-- planner may compare it with a retained post-activation observation without
-- replaying the pre-activation baseline. This timestamp stays server-only.
do $$declare definition text;anchor text;begin
 select replace(pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('''observedAt'',o.updated_at' in definition)=0 then
  anchor:='''fingerprint'',o.fingerprint,''version'',o.version';
  if position(anchor in definition)=0 then raise exception 'Audited protected observation load changed';end if;
  execute replace(definition,anchor,anchor||',''observedAt'',o.updated_at');
 end if;
end $$;
revoke all on function bid_active_catalog_private.alarm_active(jsonb,timestamptz) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.publication_conflict(jsonb,jsonb,text,integer,timestamptz) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_deadline(text,text,jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_before_current(text,text,jsonb) from public,anon,authenticated;
commit;
