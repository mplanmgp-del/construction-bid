-- Source collection and notification delivery receive separate bounded HTTP
-- executions. Both retain a ten-minute cadence; delivery follows collection.
begin;
create or replace function bid_active_catalog_private.tick()
returns void language plpgsql security invoker set search_path='' as $$
declare cfg bid_alert_private.runtime%rowtype;catalog_cfg bid_active_catalog_private.runtime%rowtype;token_value text;
begin
 select * into strict cfg from bid_alert_private.runtime where singleton;
 select * into strict catalog_cfg from bid_active_catalog_private.runtime where singleton;
 if not cfg.configured or cfg.endpoint is distinct from 'https://construction-bid-nine.vercel.app/api/alerts?action=worker'
 or catalog_cfg.lease_until>clock_timestamp() or catalog_cfg.retry_after_at>clock_timestamp()
 or coalesce((select locked from public.bid_menu_settings where menu_key='notices'),true) then return;end if;
 if bid_active_catalog_private.storage_bytes()+65536>=catalog_cfg.storage_ceiling
 or bid_alert_private.storage_bytes()+65536>=33554432 then
   update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도에 도달하여 수집을 대기합니다. 용량 증가 승인이 필요합니다.' where singleton;return;
 end if;
 select decrypted_secret into token_value from vault.decrypted_secrets where id=cfg.vault_secret_id;
 if token_value is null then
   update bid_active_catalog_private.runtime set last_error='공고 수집 연결 설정을 확인해 주세요.' where singleton;return;
 end if;
 perform net.http_post(url:='https://construction-bid-nine.vercel.app/api/alerts?action=catalog-worker',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token_value),body:='{}'::jsonb,timeout_milliseconds:=55000);
end $$;
revoke all on function bid_active_catalog_private.tick() from public,anon,authenticated;

-- Preserve admin authorization and the existing Vault secret flow on re-setup.
do $$ declare definition text;begin
 select pg_get_functiondef('public.bid_alert_admin_setup(text,text)'::regprocedure) into definition;
 definition:=replace(definition,
   'cron.schedule(''bid-personal-alerts'',''*/10 * * * *'',''select bid_alert_private.tick();'')',
   'cron.schedule(''bid-personal-alerts'',''1-59/10 * * * *'',''select bid_alert_private.tick();'')');
 if position('bid-public-catalog' in definition)=0 then
   definition:=replace(definition,'return jsonb_build_object(''configured'',true,''scheduled'',true);',
     'perform cron.schedule(''bid-public-catalog'',''*/10 * * * *'',''select bid_active_catalog_private.tick();''); return jsonb_build_object(''configured'',true,''scheduled'',true);');
 end if;
 execute definition;
 -- On a configured production database update only these two named jobs.
 -- Other collectors, including disabled MY history jobs, remain untouched.
 if exists(select 1 from pg_namespace where nspname='cron')
 and exists(select 1 from bid_alert_private.runtime where configured) then
   perform cron.schedule('bid-public-catalog','*/10 * * * *','select bid_active_catalog_private.tick();');
   perform cron.schedule('bid-personal-alerts','1-59/10 * * * *','select bid_alert_private.tick();');
 end if;
end $$;
commit;
