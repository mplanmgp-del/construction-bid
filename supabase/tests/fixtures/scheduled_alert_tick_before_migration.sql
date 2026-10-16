-- Definition-only fixture: never call tick, Vault, pg_net or cron.
do $$declare definition text;begin
 select replace(pg_get_functiondef('bid_alert_private.tick()'::regprocedure),E'\r\n',E'\n') into definition;
 execute replace(definition,E'\n',E'\r\n');
end $$;
create temporary table scheduled_alert_tick_before as
select replace(pg_get_functiondef(p.oid),E'\r\n',E'\n') definition,p.proowner,p.proacl,p.prosecdef,p.proconfig,
 position(E'\r\n' in p.prosrc)>0 source_has_crlf,
 replace(pg_get_functiondef('public.bid_alert_admin_setup(text,text)'::regprocedure),E'\r\n',E'\n') setup_definition,
 (select md5(to_jsonb(r)::text) from bid_alert_private.runtime r where singleton) runtime_hash
from pg_proc p where p.oid='bid_alert_private.tick()'::regprocedure;
