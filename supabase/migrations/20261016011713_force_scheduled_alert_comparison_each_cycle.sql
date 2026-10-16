-- A maintenance comparison must not postpone the next scheduled comparison.
-- The protected worker still enforces menu, lease, configuration and capacity.
begin;
do $$declare definition text;anchor text:='body:=''{}''::jsonb';replacement text:='body:=''{"forceCollection":true}''::jsonb';occurrences integer;begin
 select replace(pg_get_functiondef('bid_alert_private.tick()'::regprocedure),E'\r\n',E'\n') into definition;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences=1 then execute replace(definition,anchor,replacement);
 elsif occurrences<>0 or (length(definition)-length(replace(definition,replacement,'')))/length(replacement)<>1 then
   raise exception 'Audited scheduled alert HTTP body changed';
 end if;
end $$;
revoke all on function bid_alert_private.tick() from public,anon,authenticated;
commit;
