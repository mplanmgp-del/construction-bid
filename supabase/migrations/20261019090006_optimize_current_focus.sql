-- The four unanchored Korean literal keywords cannot be changed by collapsing
-- whitespace or trimming the title. Keep NFKC; avoid two SQL function layers.
begin;
do $migration$
declare definition text;
begin
 select replace(prosrc,E'\r\n',E'\n') into definition from pg_proc
 where oid='bid_active_catalog_private.current_focus(jsonb)'::regprocedure;
 if position('direct-current-focus-nfkc-v1' in definition)>0 then return;end if;
 definition:=btrim(regexp_replace(definition,E'(^|\n)[\t ]+','','g'),E' \t\n\r');
 if definition<>$expected$select bid_active_catalog_private.clean_search_text(p_notice->>'title')~'(철거|해체|석면|건설폐기물)';$expected$ then
   raise exception 'Audited current-focus literal keyword rule changed';end if;
 execute $definition$create or replace function bid_active_catalog_private.current_focus(p_notice jsonb)
 returns boolean language plpgsql immutable security invoker set search_path='' as $body$
 begin
   -- direct-current-focus-nfkc-v1
   return normalize(coalesce(p_notice->>'title',''),NFKC)~'(철거|해체|석면|건설폐기물)';
 end $body$;$definition$;
end $migration$;
revoke all on function bid_active_catalog_private.current_focus(jsonb) from public,anon,authenticated;
commit;
