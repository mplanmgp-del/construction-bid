-- Compare audited definitions without executing the scheduled function.
do $$declare prior record;current_definition text;p record;begin
 select * into strict prior from scheduled_alert_tick_before;
 assert prior.source_has_crlf,'fixture reproduces CRLF inside the stored scheduled function';
 select * into strict p from pg_proc where oid='bid_alert_private.tick()'::regprocedure;
 current_definition:=replace(pg_get_functiondef(p.oid),E'\r\n',E'\n');
 assert current_definition=replace(prior.definition,'body:=''{}''::jsonb','body:=''{"forceCollection":true}''::jsonb'),
  'scheduled comparison changes only its HTTP JSON body';
 assert position('body:=''{"forceCollection":true}''::jsonb' in current_definition)>0,'every cron invocation requests an explicit collection';
 assert p.proowner=prior.proowner and p.proacl is not distinct from prior.proacl and p.prosecdef=prior.prosecdef
  and p.proconfig is not distinct from prior.proconfig,'tick ownership, invoker rights, ACL and search path remain identical';
 assert replace(pg_get_functiondef('public.bid_alert_admin_setup(text,text)'::regprocedure),E'\r\n',E'\n')=prior.setup_definition,
  'cron setup and existing schedules remain untouched';
 assert (select md5(to_jsonb(r)::text)=prior.runtime_hash from bid_alert_private.runtime r where singleton),
  'migration never rewrites runtime last-check, errors, lease, cursor, configuration or budgets';
 assert not has_function_privilege('anon','bid_alert_private.tick()','execute')
  and not has_function_privilege('authenticated','bid_alert_private.tick()','execute'),'scheduled comparison remains private';
end $$;
