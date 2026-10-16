-- Only a freshly verified match from the trusted server uses the fast cadence.
-- Existing/unrelated groups, on-demand publication and retry backoff stay unchanged.
begin;
create or replace function bid_active_catalog_private.next_verification_at(p_verified_at timestamptz)
returns timestamptz language sql immutable strict security invoker set search_path='' as $$
 select date_bin(interval '10 minutes',p_verified_at,'2000-01-01T00:00:00Z'::timestamptz)+interval '10 minutes';
$$;
do $$declare definition text;anchor text;replacement text;occurrences integer;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('matched-ten-minute-refresh-v1' in definition)=0 then
  anchor:=$a$foreach kind_value in array array['sources','groups','failedSources','failedGroups','rejectedGroups'] loop$a$;
  replacement:=$a$-- matched-ten-minute-refresh-v1: the server has evaluated the saved rules.
 if p_payload?'refreshMatching' then
   if jsonb_typeof(p_payload->'refreshMatching') is distinct from 'boolean'
     or jsonb_typeof(p_payload->'groups') is distinct from 'array' then
     raise exception using errcode='22023',message='Invalid matching refresh batch';end if;
   if jsonb_array_length(p_payload->'groups')<>1 then
     raise exception using errcode='22023',message='Matching refresh requires one verified identity';end if;
 end if;
 foreach kind_value in array array['sources','groups','failedSources','failedGroups','rejectedGroups'] loop$a$;
  anchor:=replace(anchor,E'\r\n',E'\n');replacement:=replace(replacement,E'\r\n',E'\n');
  if position(anchor in definition)=0 then raise exception 'Audited private commit validation changed';end if;
  definition:=replace(definition,anchor,replacement);
  anchor:=$a$stamp+interval '1 hour'$a$;
  occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
  if occurrences<>1 then raise exception 'Audited private group refresh assignment changed';end if;
  replacement:=$a$case when p_payload->'refreshMatching'='true'::jsonb then bid_active_catalog_private.next_verification_at(stamp) else stamp+interval '1 hour' end$a$;
  execute replace(definition,anchor,replacement);
 end if;
end $$;
revoke all on function bid_active_catalog_private.next_verification_at(timestamptz) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_legacy(text,text,jsonb) from public,anon,authenticated;
commit;
