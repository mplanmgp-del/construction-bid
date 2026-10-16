-- Participant facts can leave less room for the optional region-text prefix.
-- Reapply the existing projection after cached facts are merged into history.
-- Keep the original oversized-core-facts rejection and all worker fences.
begin;
do $$declare definition text;anchor text;occurrences integer;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('cached-history-condition-recompact-v1' in definition)=0 then
   anchor:=$a$if octet_length(n::text)>4096 then raise exception 'Compact notice exceeded storage budget'; end if;$a$;
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited cached-history budget guard changed (% occurrences)',occurrences;end if;
   execute replace(definition,anchor,$a$-- cached-history-condition-recompact-v1
     n:=bid_active_catalog_private.compact(n);
     $a$||anchor);
 end if;
end $$;
revoke all on function bid_active_catalog_private.worker_legacy(text,text,jsonb) from public,anon,authenticated;
commit;
