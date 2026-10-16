-- Match functions pasted through a Windows browser SQL editor.
do $$declare target text;definition text;begin
 foreach target in array array['bid_active_catalog_private.worker_deadline(text,text,jsonb)',
 'bid_active_catalog_private.worker_before_current(text,text,jsonb)','public.bid_alert_worker(text,text,jsonb)']loop
  select pg_get_functiondef(target::regprocedure) into definition;
  execute replace(replace(definition,E'\r\n',E'\n'),E'\n',E'\r\n');
 end loop;
end $$;
