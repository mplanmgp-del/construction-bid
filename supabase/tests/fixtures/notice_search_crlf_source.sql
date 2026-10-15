-- Ephemeral SQL-test setup: reproduce a function pasted through Windows UI.
-- Run immediately before the fast-search migration in a disposable database.
do $$declare definition text;begin
 select pg_get_functiondef('bid_active_catalog_private.search_page(jsonb)'::regprocedure) into definition;
 definition:=replace(replace(definition,E'\r\n',E'\n'),E'\n',E'\r\n');
 execute definition;
 if not exists(select 1 from pg_proc where oid='bid_active_catalog_private.search_page(jsonb)'::regprocedure and position(E'\r\n' in prosrc)>0) then
   raise exception 'Windows function-body fixture was not reproduced';end if;
end $$;
