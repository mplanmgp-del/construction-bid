-- Personalized alerts. Apply after member-workspaces.sql and menu-access.sql.
-- This migration preserves collector settings, budgets, data, and cron jobs.
-- New alert relations have a separate 32 MiB ceiling; total DB size still grows.
-- No retention DELETE is scheduled. At capacity, collection stops before its cursor advances.
-- Cron is provisioned only by bid_alert_admin_setup after server configuration.
begin;
create schema if not exists bid_alert_private;
revoke all on schema bid_alert_private from public,anon,authenticated;

create table if not exists public.bid_alert_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 settings jsonb not null check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=16384),
 updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.bid_alert_inbox (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 notice_key text not null check(length(notice_key)<=150), version integer not null check(version>=0),
 kind text not null check(kind in ('initial','new','changed','cancelled','test')),
 notice jsonb check(notice is null or octet_length(notice::text)<=16384),
 message text not null check(length(message)<=500),
 change_fields jsonb not null default '[]'::jsonb check(jsonb_typeof(change_fields)='array' and jsonb_array_length(change_fields)<=30),
 existing_count integer check(existing_count>=0), created_at timestamptz not null default clock_timestamp(), read_at timestamptz,
 unique(user_id,notice_key,version)
);
create index if not exists bid_alert_inbox_owner_created on public.bid_alert_inbox(user_id,created_at desc,id desc);
alter table public.bid_alert_settings enable row level security;
alter table public.bid_alert_inbox enable row level security;
revoke all on public.bid_alert_settings,public.bid_alert_inbox from public,anon,authenticated;
grant select on public.bid_alert_settings,public.bid_alert_inbox to authenticated;
drop policy if exists bid_alert_settings_owner on public.bid_alert_settings;
create policy bid_alert_settings_owner on public.bid_alert_settings for select to authenticated using((select auth.uid())=user_id);
drop policy if exists bid_alert_inbox_owner on public.bid_alert_inbox;
create policy bid_alert_inbox_owner on public.bid_alert_inbox for select to authenticated using((select auth.uid())=user_id);

create table if not exists bid_alert_private.runtime (
 singleton boolean primary key default true check(singleton),
 configured boolean not null default false, token_hash bytea, vault_secret_id uuid,
 endpoint text, lease_id uuid, lease_until timestamptz,
 lease_collecting boolean not null default false, lease_failed boolean not null default false,
 cursor_value text, backfill_day text, coverage_from text,
 window_minutes integer not null default 60 check(window_minutes between 1 and 60),
 last_checked_at timestamptz, last_attempt_at timestamptz, last_error text,
 storage_ceiling bigint not null default 33554432 check(storage_ceiling=33554432)
);
alter table bid_alert_private.runtime add column if not exists window_minutes integer not null default 60 check(window_minutes between 1 and 60);
insert into bid_alert_private.runtime(singleton) values(true) on conflict do nothing;
create table if not exists bid_alert_private.observations (
 notice_key text primary key check(length(notice_key) between 3 and 150),
 notice jsonb not null check(octet_length(notice::text)<=16384),
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'),
 version integer not null check(version>0), revision integer not null check(revision>=0),
 source_updated_at timestamptz not null, updated_at timestamptz not null default clock_timestamp()
);
create table if not exists bid_alert_private.memberships (
 user_id uuid not null references auth.users(id) on delete cascade,
 notice_key text not null references bid_alert_private.observations(notice_key),
 last_version integer not null check(last_version>0), initial boolean not null default false,
 updated_at timestamptz not null default clock_timestamp(), primary key(user_id,notice_key)
);
create table if not exists bid_alert_private.subscriptions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 endpoint_hash bytea not null unique, subscription jsonb not null check(octet_length(subscription::text)<=4096),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create index if not exists bid_alert_subscriptions_owner on bid_alert_private.subscriptions(user_id);
create table if not exists bid_alert_private.deliveries (
 id uuid primary key default gen_random_uuid(),
 notification_id uuid not null references public.bid_alert_inbox(id) on delete cascade,
 subscription_id uuid not null references bid_alert_private.subscriptions(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','sent','failed')),
 attempts integer not null default 0 check(attempts between 0 and 5),
 next_attempt_at timestamptz not null default clock_timestamp(), created_at timestamptz not null default clock_timestamp(),
 unique(notification_id,subscription_id)
);
create index if not exists bid_alert_delivery_pending on bid_alert_private.deliveries(next_attempt_at,id) where status='pending';
alter table bid_alert_private.runtime enable row level security;
alter table bid_alert_private.observations enable row level security;
alter table bid_alert_private.memberships enable row level security;
alter table bid_alert_private.subscriptions enable row level security;
alter table bid_alert_private.deliveries enable row level security;

create or replace function bid_alert_private.defaults()
returns jsonb language sql immutable security invoker set search_path='' as $$
 select '{"enabled":false,"filter":{"keywords":["철거","해체","석면","건설폐기물"],"excludeKeywords":[],"types":["공사","용역"],"categories":[],"regions":[],"licenses":[],"minAmount":null,"maxAmount":null,"includeUnknown":true,"useCompanyRegion":false},"notifyChanges":true,"pushEnabled":false,"activatedAt":null,"updatedAt":null}'::jsonb;
$$;
create or replace function bid_alert_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relkind='r' and (n.nspname='bid_alert_private' or (n.nspname='public' and c.relname in ('bid_alert_settings','bid_alert_inbox')));
$$;
create or replace function bid_alert_private.inbox_json(i public.bid_alert_inbox)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',i.id,'kind',i.kind,'notice',i.notice,'message',i.message,'changeFields',i.change_fields,
 'createdAt',i.created_at,'readAt',i.read_at)||case when i.existing_count is null then '{}'::jsonb else jsonb_build_object('existingCount',i.existing_count) end;
$$;
create or replace function bid_alert_private.endpoint_hash(p_endpoint text)
returns bytea language sql immutable security invoker set search_path='' as $$
 -- Host case and an explicit default port must not evade global ownership.
 select sha256(convert_to(regexp_replace(p_endpoint,'^https://[^/]+','https://'||regexp_replace(lower(split_part(p_endpoint,'/',3)),':443$',''),'i'),'UTF8'));
$$;
create or replace function bid_alert_private.validate_settings(p_settings jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare f jsonb; name text; item jsonb; result jsonb; lower_amount numeric; upper_amount numeric; max_length integer;
begin
 if jsonb_typeof(p_settings) is distinct from 'object' or octet_length(p_settings::text)>16384 then raise exception using errcode='22023',message='알림 설정 형식을 확인해 주세요.'; end if;
 f:=p_settings->'filter';
 if jsonb_typeof(f) is distinct from 'object' then raise exception using errcode='22023',message='알림 조건을 확인해 주세요.'; end if;
 foreach name in array array['enabled','notifyChanges','pushEnabled'] loop
   if jsonb_typeof(p_settings->name) is distinct from 'boolean' then raise exception using errcode='22023',message='알림 선택 값을 확인해 주세요.'; end if;
 end loop;
 foreach name in array array['includeUnknown','useCompanyRegion'] loop
   if jsonb_typeof(f->name) is distinct from 'boolean' then raise exception using errcode='22023',message='알림 지역 조건을 확인해 주세요.'; end if;
 end loop;
 foreach name in array array['keywords','excludeKeywords','types','categories','regions','licenses'] loop
   max_length:=case when name in ('keywords','excludeKeywords') then 80 when name='licenses' then 120 else 100 end;
   if jsonb_typeof(f->name) is distinct from 'array' or jsonb_array_length(f->name)>20 then raise exception using errcode='22023',message='알림 조건은 항목별 20개 이하로 지정해 주세요.'; end if;
   for item in select value from jsonb_array_elements(f->name) loop
     if jsonb_typeof(item)<>'string' or length(btrim(item#>>'{}')) not between 1 and max_length or
        item#>>'{}'~'[[:cntrl:]]' then raise exception using errcode='22023',message='알림 조건의 글자 수를 확인해 주세요.'; end if;
     if name='types' and item#>>'{}' not in ('공사','용역') then raise exception using errcode='22023',message='알림 업무 구분을 확인해 주세요.'; end if;
     if name='categories' and item#>>'{}' not in ('철거·해체','석면','건축·리모델링','토목','보수·유지관리','전기·통신·소방','기계·설비','조경','폐기물','조사·설계·감리','기타') then raise exception using errcode='22023',message='알림 분류를 확인해 주세요.'; end if;
   end loop;
   select coalesce(jsonb_agg(v order by v),'[]'::jsonb) into item from (select distinct btrim(value#>>'{}') v from jsonb_array_elements(f->name)) s;
   f:=jsonb_set(f,array[name],item);
 end loop;
 if jsonb_array_length(f->'types')=0 then raise exception using errcode='22023',message='공사 또는 용역을 선택해 주세요.'; end if;
 foreach name in array array['minAmount','maxAmount'] loop
   if not f?name or (f->name<>'null'::jsonb and (jsonb_typeof(f->name)<>'number' or (f->>name)::numeric<0 or (f->>name)::numeric>9007199254740991 or trunc((f->>name)::numeric)<>(f->>name)::numeric)) then raise exception using errcode='22023',message='금액은 0 이상의 원 단위 정수로 입력해 주세요.'; end if;
 end loop;
 lower_amount:=(f->>'minAmount')::numeric; upper_amount:=(f->>'maxAmount')::numeric;
 if lower_amount>upper_amount then raise exception using errcode='22023',message='최소 금액은 최대 금액 이하로 입력해 주세요.'; end if;
 if p_settings->>'enabled'='true' and jsonb_array_length(f->'keywords')=0 and jsonb_array_length(f->'categories')=0 and
    jsonb_array_length(f->'regions')=0 and jsonb_array_length(f->'licenses')=0 and f->>'useCompanyRegion'='false' and lower_amount is null and upper_amount is null then
   raise exception using errcode='22023',message='맞춤 알림 조건을 한 가지 이상 입력해 주세요.'; end if;
 -- Rebuild a fixed allowlist; supplied identity, timestamps and extra fields are ignored.
 result:=jsonb_build_object('enabled',p_settings->'enabled','notifyChanges',p_settings->'notifyChanges','pushEnabled',p_settings->'pushEnabled',
 'filter',jsonb_build_object('keywords',f->'keywords','excludeKeywords',f->'excludeKeywords','types',f->'types','categories',f->'categories',
 'regions',f->'regions','licenses',f->'licenses','minAmount',f->'minAmount','maxAmount',f->'maxAmount','includeUnknown',f->'includeUnknown','useCompanyRegion',f->'useCompanyRegion'));
 return result;
end $$;
create or replace function bid_alert_private.overview(p_user uuid,p_offset integer default 0,p_existing_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare cfg bid_alert_private.runtime%rowtype; preferences jsonb; items jsonb; existing_items jsonb; paused boolean;
begin
 select * into strict cfg from bid_alert_private.runtime where singleton;
 select settings into preferences from public.bid_alert_settings where user_id=p_user;
 preferences:=coalesce(preferences,bid_alert_private.defaults());
 select coalesce(jsonb_agg(bid_alert_private.inbox_json(q) order by q.created_at desc,q.id desc),'[]'::jsonb) into items
 from (select * from public.bid_alert_inbox where user_id=p_user order by created_at desc,id desc limit 30 offset p_offset) q;
 select coalesce(jsonb_agg(q.notice order by q.updated_at desc,q.notice_key),'[]'::jsonb) into existing_items
 from (select o.notice,o.updated_at,o.notice_key from bid_alert_private.memberships m join bid_alert_private.observations o on o.notice_key=m.notice_key
   where m.user_id=p_user and m.initial order by o.updated_at desc,o.notice_key limit 30 offset p_existing_offset) q;
 select coalesce((select locked from public.bid_menu_settings where menu_key='notices'),true) into paused;
 return jsonb_build_object('settings',preferences,'notifications',items,'unreadCount',(select count(*) from public.bid_alert_inbox where user_id=p_user and read_at is null),
 'hasMore',(select count(*)>p_offset+30 from public.bid_alert_inbox where user_id=p_user),'existingMatches',existing_items,
 'existingHasMore',(select count(*)>p_existing_offset+30 from bid_alert_private.memberships where user_id=p_user and initial),
 'subscriptionCount',(select count(*) from bid_alert_private.subscriptions where user_id=p_user),'publicKey',null,
 'status',jsonb_build_object('configured',cfg.configured,'lastCheckedAt',cfg.last_checked_at,'coverageFrom',cfg.coverage_from,
   'backfillPending',cfg.backfill_day is not null,'error',cfg.last_error,'paused',paused or not (preferences->>'enabled')::boolean,'pushConfigured',false));
end $$;

create or replace function public.bid_alert_user(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner_id uuid:=auth.uid(); preferences jsonb; previous jsonb; stamp timestamptz:=clock_timestamp(); sub jsonb; endpoint_value text;
 hash_value bytea; owner_of_endpoint uuid; subscription_id uuid; notification_id uuid; page_offset integer:=0; existing_offset integer:=0; reset_baseline boolean;
begin
 if owner_id is null then raise exception using errcode='42501',message='로그인이 필요합니다.'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>20000 then raise exception using errcode='22023',message='알림 요청 형식을 확인해 주세요.'; end if;
 -- Serialize owner writes, including endpoint ownership checks and test rate limits.
 perform pg_advisory_xact_lock(hashtextextended(owner_id::text,62615001));
 if p_action in ('save','subscribe','test','unsubscribe') then
   perform 1 from bid_alert_private.runtime where singleton for update;
   if p_action<>'unsubscribe' and bid_alert_private.storage_bytes()+greatest(65536,octet_length(p_payload::text)*3)>=33554432 then
     -- Capacity must never prevent an owner from stopping notifications. Ignore
     -- every other submitted field and update only an existing enabled row.
     -- An account without settings is already disabled, so no row is inserted.
     if p_action='save' and p_payload#>'{settings,enabled}'='false'::jsonb then
       update public.bid_alert_settings set settings=jsonb_set(jsonb_set(settings,'{enabled}','false'),'{updatedAt}',to_jsonb(stamp)),updated_at=stamp
         where user_id=owner_id and settings->>'enabled'='true';
       return bid_alert_private.overview(owner_id);
     end if;
     raise exception using errcode='54000',message='알림 저장 한도에 도달했습니다. 기존 자료는 보존됩니다.'; end if;
 end if;
 if p_action='save' then
   preferences:=bid_alert_private.validate_settings(p_payload->'settings');
   preferences:=jsonb_set(preferences,'{pushEnabled}',to_jsonb(exists(select 1 from bid_alert_private.subscriptions where user_id=owner_id)));
   select settings into previous from public.bid_alert_settings where user_id=owner_id for update;
   reset_baseline:=(preferences->>'enabled')::boolean and
     (previous is null or not coalesce((previous->>'enabled')::boolean,false) or preferences->'filter' is distinct from previous->'filter');
   preferences:=preferences||jsonb_build_object('activatedAt',case when reset_baseline then to_jsonb(stamp)
     else coalesce(previous->'activatedAt','null'::jsonb) end,'updatedAt',stamp);
   insert into public.bid_alert_settings(user_id,settings,updated_at) values(owner_id,preferences,stamp)
   on conflict(user_id) do update set settings=excluded.settings,updated_at=excluded.updated_at;
   if previous is not null and preferences->'filter' is distinct from previous->'filter' then
     update bid_alert_private.memberships set initial=false where user_id=owner_id and initial;
     update public.bid_alert_inbox set existing_count=0 where user_id=owner_id and notice_key='@initial' and version=0;
   end if;
   if reset_baseline then
     -- An old-rule worker cannot overwrite this new baseline or enqueue stale
     -- filter matches. Committed batches remain protected by the durable ledger.
     update bid_alert_private.runtime set backfill_day=to_char(stamp at time zone 'Asia/Seoul','YYYY-MM-DD'),last_checked_at=null,
       lease_id=null,lease_until=null,lease_collecting=false,lease_failed=false where singleton;
   end if;
 elsif p_action='read' then
   if p_payload->>'all'='true' then update public.bid_alert_inbox set read_at=coalesce(read_at,stamp) where user_id=owner_id and read_at is null;
   else
     if p_payload?'id' and not p_payload?'ids' then p_payload:=p_payload||jsonb_build_object('ids',jsonb_build_array(p_payload->>'id')); end if;
     if jsonb_typeof(p_payload->'ids') is distinct from 'array' or jsonb_array_length(p_payload->'ids')>100 then raise exception using errcode='22023',message='읽음 처리할 알림을 확인해 주세요.'; end if;
     update public.bid_alert_inbox set read_at=coalesce(read_at,stamp) where user_id=owner_id and id::text in (select value from jsonb_array_elements_text(p_payload->'ids'));
   end if;
 elsif p_action='subscribe' then
   sub:=p_payload->'subscription'; endpoint_value:=sub->>'endpoint';
   if jsonb_typeof(sub) is distinct from 'object' or length(endpoint_value)>2048 or endpoint_value is null or
      endpoint_value !~* '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([A-Za-z0-9-]+\.)+push\.apple\.com)(:443)?/[^[:space:]#\\]*$' or
      coalesce(sub#>>'{keys,p256dh}','')!~'^[A-Za-z0-9_-]{87}$' or coalesce(sub#>>'{keys,auth}','')!~'^[A-Za-z0-9_-]{22}$' or
      (sub->'expirationTime' is not null and sub->'expirationTime'<>'null'::jsonb and jsonb_typeof(sub->'expirationTime')<>'number') then
     raise exception using errcode='22023',message='브라우저 푸시 구독 정보를 확인해 주세요.'; end if;
   hash_value:=bid_alert_private.endpoint_hash(endpoint_value);
   perform pg_advisory_xact_lock(hashtextextended(encode(hash_value,'hex'),62615002));
   select user_id into owner_of_endpoint from bid_alert_private.subscriptions where endpoint_hash=hash_value for update;
   if found and owner_of_endpoint<>owner_id then raise exception using errcode='23505',message='subscription_owned',detail='이 브라우저는 다른 계정의 푸시에 등록되어 있습니다. 해당 계정에서 먼저 해제해 주세요.'; end if;
   if not found and (select count(*) from bid_alert_private.subscriptions where user_id=owner_id)>=10 then raise exception using errcode='22023',message='푸시 브라우저는 최대 10개까지 등록할 수 있습니다.'; end if;
   insert into bid_alert_private.subscriptions(user_id,endpoint_hash,subscription) values(owner_id,hash_value,
     jsonb_build_object('endpoint',endpoint_value,'expirationTime',coalesce(sub->'expirationTime','null'::jsonb),'keys',jsonb_build_object('p256dh',sub#>>'{keys,p256dh}','auth',sub#>>'{keys,auth}')))
   on conflict(endpoint_hash) do update set subscription=excluded.subscription,updated_at=stamp where bid_alert_private.subscriptions.user_id=owner_id;
   select settings into preferences from public.bid_alert_settings where user_id=owner_id;
   preferences:=jsonb_set(coalesce(preferences,bid_alert_private.defaults()),'{pushEnabled}','true')||jsonb_build_object('updatedAt',stamp);
   insert into public.bid_alert_settings(user_id,settings,updated_at) values(owner_id,preferences,stamp)
     on conflict(user_id) do update set settings=excluded.settings,updated_at=excluded.updated_at;
 elsif p_action in ('unsubscribe','subscription_status','test') then
   endpoint_value:=p_payload->>'endpoint';
   if endpoint_value is null or length(endpoint_value)>2048 then raise exception using errcode='22023',message='이 브라우저의 구독 정보를 확인해 주세요.'; end if;
   hash_value:=bid_alert_private.endpoint_hash(endpoint_value);
   select id into subscription_id from bid_alert_private.subscriptions where user_id=owner_id and endpoint_hash=hash_value;
   if p_action='subscription_status' then return jsonb_build_object('subscribed',subscription_id is not null); end if;
   if p_action='unsubscribe' then
     delete from bid_alert_private.subscriptions where id=subscription_id and user_id=owner_id;
     if not exists(select 1 from bid_alert_private.subscriptions where user_id=owner_id) then
       update public.bid_alert_settings set settings=jsonb_set(settings,'{pushEnabled}','false')||jsonb_build_object('updatedAt',stamp),updated_at=stamp where user_id=owner_id;
     end if;
   else
     if subscription_id is null then raise exception using errcode='22023',message='먼저 이 브라우저의 푸시를 켜 주세요.'; end if;
     if exists(select 1 from public.bid_alert_inbox where user_id=owner_id and kind='test' and created_at>stamp-interval '1 minute') then raise exception using errcode='54000',message='테스트 알림은 1분 후 다시 보낼 수 있습니다.'; end if;
     insert into public.bid_alert_inbox(user_id,notice_key,version,kind,message) values(owner_id,'@test:'||gen_random_uuid()::text,0,'test','맞춤공고 알리미 테스트입니다.') returning id into notification_id;
     insert into bid_alert_private.deliveries(notification_id,subscription_id) values(notification_id,subscription_id);
   end if;
 elsif p_action<>'get' then raise exception using errcode='22023',message='지원하지 않는 알림 요청입니다.';
 end if;
 if p_payload?'offset' then
   if coalesce(p_payload->>'offset','')!~'^\d{1,6}$' then raise exception using errcode='22023',message='알림 페이지를 확인해 주세요.'; end if;
   page_offset:=(p_payload->>'offset')::integer;
 end if;
 if p_payload?'existingOffset' then
   if coalesce(p_payload->>'existingOffset','')!~'^\d{1,6}$' then raise exception using errcode='22023',message='기존 공고 페이지를 확인해 주세요.'; end if;
   existing_offset:=(p_payload->>'existingOffset')::integer;
 end if;
 return bid_alert_private.overview(owner_id,page_offset,existing_offset);
end $$;

revoke all on all tables in schema bid_alert_private from public,anon,authenticated;
revoke all on all functions in schema bid_alert_private from public,anon,authenticated;
revoke all on function public.bid_alert_user(text,jsonb) from public,anon,authenticated;
grant execute on function public.bid_alert_user(text,jsonb) to authenticated;
-- Worker/provisioning functions follow in the same transaction.

create or replace function public.bid_alert_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg bid_alert_private.runtime%rowtype; lease uuid; rules jsonb; item jsonb; observed jsonb; prior bid_alert_private.observations%rowtype;
 key_value text; fingerprint_value text; version_value integer; revision_value integer; source_time timestamptz; owner_id uuid;
 preferences jsonb; notice_value jsonb; notification_id uuid; subscription_id uuid; existing_count_value integer;
 inserted_count integer:=0; observation_count integer:=0; new_events integer:=0; page_limit integer; result jsonb;
 is_dispatch boolean; due boolean; menu_paused boolean; valid_lease boolean; storage_size bigint; ids uuid[];
 checkpoint jsonb; error_value text; status_value text; attempt_value integer; delay_seconds integer; finalize boolean:=false;
begin
 select * into strict cfg from bid_alert_private.runtime where singleton;
 if p_token is null or length(p_token) not between 43 and 128 or cfg.token_hash is null or
    sha256(convert_to(p_token,'UTF8'))<>cfg.token_hash then raise exception using errcode='42501',message='알림 작업 인증에 실패했습니다.'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>3000000 then raise exception using errcode='22023',message='알림 작업 크기를 확인해 주세요.'; end if;
 select * into strict cfg from bid_alert_private.runtime where singleton for update;
 -- Recheck under the row lock so token rotation cannot race an authenticated claim.
 if sha256(convert_to(p_token,'UTF8')) is distinct from cfg.token_hash then raise exception using errcode='42501',message='알림 작업 인증에 실패했습니다.'; end if;
 if p_action='claim' then
   select coalesce((select locked from public.bid_menu_settings where menu_key='notices'),true) into menu_paused;
   result:=jsonb_build_object('leaseId',null,'cursor',cfg.cursor_value,'backfillDay',cfg.backfill_day,'coverageFrom',cfg.coverage_from,'windowMinutes',cfg.window_minutes,
     'rules','[]'::jsonb,'enabled',false,'collectionDue',false,'lastCheckedAt',cfg.last_checked_at,'error',cfg.last_error);
   if not cfg.configured then return result; end if;
   if cfg.lease_until>clock_timestamp() then return result||jsonb_build_object('busy',true); end if;
   is_dispatch:=coalesce((p_payload->>'dispatchOnly')::boolean,false);
   due:=not is_dispatch and not menu_paused and (cfg.last_checked_at is null or cfg.last_checked_at<=clock_timestamp()-interval '9 minutes' or cfg.last_error is not null);
   if due and bid_alert_private.storage_bytes()>=cfg.storage_ceiling then
     error_value:='알림 저장 한도에 도달해 새 공고 확인을 일시 중지했습니다. 기존 자료는 보존됩니다.';
     update bid_alert_private.runtime set last_error=error_value where singleton;
     result:=result||jsonb_build_object('error',error_value,'storageFull',true); due:=false;
   end if;
   if not due and not exists(select 1 from bid_alert_private.deliveries where status='pending' and next_attempt_at<=clock_timestamp() and attempts<5) then return result||jsonb_build_object('skipped',true); end if;
   if due then
     select coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'settings',s.settings,'profile',w.data->'profile') order by s.user_id),'[]'::jsonb)
       into rules from public.bid_alert_settings s left join public.bid_member_workspaces w on w.user_id=s.user_id where s.settings->>'enabled'='true';
     if jsonb_array_length(rules)>200 then
       update bid_alert_private.runtime set last_error='알림 이용자가 많아 수집 배치 조정이 필요합니다.' where singleton;
       return result||jsonb_build_object('error','알림 이용자가 많아 수집 배치 조정이 필요합니다.'); end if;
   else rules:='[]'::jsonb; end if;
   lease:=gen_random_uuid();
   update bid_alert_private.runtime set lease_id=lease,lease_until=clock_timestamp()+interval '120 seconds',lease_collecting=due and jsonb_array_length(rules)>0,
     lease_failed=false,last_attempt_at=clock_timestamp() where singleton;
   return result||jsonb_build_object('leaseId',lease,'rules',rules,'enabled',due and jsonb_array_length(rules)>0,'collectionDue',due and jsonb_array_length(rules)>0);
 end if;
 begin lease:=(p_payload->>'leaseId')::uuid;
 exception when invalid_text_representation then raise exception using errcode='42501',message='알림 작업 임대를 확인해 주세요.'; end;
 valid_lease:=lease is not null and cfg.lease_id=lease and cfg.lease_until>clock_timestamp();
 if valid_lease is distinct from true then raise exception using errcode='42501',message='알림 작업 임대가 만료되었습니다.'; end if;
 -- The application uses commit({finish:true}) for both collection and push-only
 -- completion. Empty finalization must also work after a capacity/error result.
 if p_action='commit' and p_payload->>'finish'='true' and coalesce(p_payload->'observations','[]'::jsonb)='[]'::jsonb and
    coalesce(p_payload->'events','[]'::jsonb)='[]'::jsonb and coalesce(p_payload->'existing','[]'::jsonb)='[]'::jsonb then p_action:='finish'; end if;

 if p_action='load' then
   if jsonb_typeof(p_payload->'keys') is distinct from 'array' or jsonb_array_length(p_payload->'keys')>300 or
      exists(select 1 from jsonb_array_elements(p_payload->'keys') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>150) then raise exception using errcode='22023',message='공고 관측 배치를 확인해 주세요.'; end if;
   return jsonb_build_object('observations',(select coalesce(jsonb_agg(jsonb_build_object('key',o.notice_key,'notice',o.notice,'fingerprint',o.fingerprint,'version',o.version)),'[]'::jsonb)
       from bid_alert_private.observations o where notice_key in (select jsonb_array_elements_text(p_payload->'keys'))),
     'memberships',(select coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'key',m.notice_key,'lastVersion',m.last_version,'initial',m.initial)),'[]'::jsonb)
       from bid_alert_private.memberships m where notice_key in (select jsonb_array_elements_text(p_payload->'keys'))));
 elsif p_action='commit' then
   if not cfg.lease_collecting then raise exception using errcode='42501',message='이 임대는 푸시 전송에만 사용할 수 있습니다.'; end if;
   foreach key_value in array array['observations','events','existing'] loop
     if p_payload?key_value and (jsonb_typeof(p_payload->key_value) is distinct from 'array' or jsonb_array_length(p_payload->key_value)>case when key_value='observations' then 300 else 1000 end) then raise exception using errcode='22023',message='알림 저장 배치를 확인해 주세요.'; end if;
   end loop;
   storage_size:=bid_alert_private.storage_bytes();
   -- Reserve three times the incoming JSON for heap, TOAST and index overhead.
   -- An already full relation never triggers collector cleanup or a ceiling raise.
   if storage_size+octet_length(p_payload::text)*3>=cfg.storage_ceiling then
     error_value:='알림 저장 한도에 도달해 새 공고 확인을 일시 중지했습니다. 기존 자료는 보존됩니다.';
     update bid_alert_private.runtime set last_error=error_value,lease_failed=true where singleton;
     return jsonb_build_object('storageFull',true,'error',error_value,'observations',0,'events',0);
   end if;
   for item in select value from jsonb_array_elements(coalesce(p_payload->'observations','[]'::jsonb)) loop
     key_value:=item->>'key'; observed:=item->'notice'; fingerprint_value:=item->>'fingerprint';
     if jsonb_typeof(observed) is distinct from 'object' or octet_length(observed::text)>16384 or
        coalesce(observed->>'type','') not in ('공사','용역') or coalesce(observed->>'number','')!~'^[A-Za-z0-9_-]{1,40}$' or
        key_value is distinct from 'g2b:'||(observed->>'type')||':'||(observed->>'number') or coalesce(observed->>'revision','')!~'^\d{1,3}$' or
        coalesce(fingerprint_value,'')!~'^[0-9a-f]{64}$' or coalesce(item->>'version','')!~'^[1-9]\d{0,8}$' then raise exception using errcode='22023',message='관측 공고 형식을 확인해 주세요.'; end if;
     version_value:=(item->>'version')::integer; revision_value:=(observed->>'revision')::integer;
     begin source_time:=(observed->>'sourceUpdatedAt')::timestamptz;
     exception when others then raise exception using errcode='22023',message='공고 변경 시각을 확인해 주세요.'; end;
     if source_time is null or not isfinite(source_time) then raise exception using errcode='22023',message='공고 변경 시각을 확인해 주세요.'; end if;
     select * into prior from bid_alert_private.observations where notice_key=key_value for update;
     if found then
       if revision_value<prior.revision or (revision_value=prior.revision and source_time<prior.source_updated_at) then continue; end if;
       if (fingerprint_value=prior.fingerprint and version_value<>prior.version) or
          (fingerprint_value<>prior.fingerprint and version_value<>prior.version+1) then raise exception using errcode='22023',message='공고 관측 버전을 다시 확인해 주세요.'; end if;
     elsif version_value<>1 then raise exception using errcode='22023',message='새 공고 관측 버전을 확인해 주세요.'; end if;
     insert into bid_alert_private.observations(notice_key,notice,fingerprint,version,revision,source_updated_at)
       values(key_value,observed,fingerprint_value,version_value,revision_value,source_time)
       on conflict(notice_key) do update set notice=excluded.notice,fingerprint=excluded.fingerprint,version=excluded.version,revision=excluded.revision,
         source_updated_at=excluded.source_updated_at,updated_at=clock_timestamp();
     observation_count:=observation_count+1;
   end loop;
   for item in select value from jsonb_array_elements(coalesce(p_payload->'events','[]'::jsonb)) loop
     if coalesce(item->>'kind','') not in ('new','changed','cancelled') or coalesce(item->>'version','')!~'^[1-9]\d{0,8}$' or
       jsonb_typeof(item->'changeFields') is distinct from 'array' or jsonb_array_length(item->'changeFields')>30 or
       length(coalesce(item->>'message','')) not between 1 and 500 then raise exception using errcode='22023',message='새 알림 형식을 확인해 주세요.'; end if;
     owner_id:=(item->>'userId')::uuid; key_value:=item->>'key'; version_value:=(item->>'version')::integer;
     select settings into preferences from public.bid_alert_settings where user_id=owner_id and settings->>'enabled'='true' for share;
     if not found then continue; end if;
     select notice into notice_value from bid_alert_private.observations where notice_key=key_value and version=version_value;
     if not found or exists(select 1 from bid_alert_private.memberships where user_id=owner_id and notice_key=key_value and last_version>=version_value) then continue; end if;
     -- Disabled change notifications still advance the membership ledger.
     if item->>'kind'='new' or preferences->>'notifyChanges'='true' then
       insert into public.bid_alert_inbox(user_id,notice_key,version,kind,notice,message,change_fields)
         values(owner_id,key_value,version_value,item->>'kind',notice_value,item->>'message',item->'changeFields')
         on conflict(user_id,notice_key,version) do nothing returning id into notification_id;
       if notification_id is not null then
         new_events:=new_events+1;
         if preferences->>'pushEnabled'='true' then
           insert into bid_alert_private.deliveries(notification_id,subscription_id) select notification_id,s.id from bid_alert_private.subscriptions s where s.user_id=owner_id on conflict do nothing;
         end if;
       end if;
     end if;
     insert into bid_alert_private.memberships(user_id,notice_key,last_version) values(owner_id,key_value,version_value)
       on conflict(user_id,notice_key) do update set last_version=greatest(bid_alert_private.memberships.last_version,excluded.last_version),updated_at=clock_timestamp();
   end loop;
   for item in select value from jsonb_array_elements(coalesce(p_payload->'existing','[]'::jsonb)) loop
     owner_id:=(item->>'userId')::uuid; key_value:=item->>'key';
     if coalesce(item->>'version','')!~'^[1-9]\d{0,8}$' then raise exception using errcode='22023',message='기존 공고 버전을 확인해 주세요.'; end if;
     version_value:=(item->>'version')::integer;
     if not exists(select 1 from public.bid_alert_settings where user_id=owner_id and settings->>'enabled'='true') or
        not exists(select 1 from bid_alert_private.observations where notice_key=key_value and version=version_value) then continue; end if;
     if item?'initial' and jsonb_typeof(item->'initial') is distinct from 'boolean' then raise exception using errcode='22023',message='기존 공고 묶음 구분을 확인해 주세요.'; end if;
     insert into bid_alert_private.memberships(user_id,notice_key,last_version,initial) values(owner_id,key_value,version_value,coalesce((item->>'initial')::boolean,true))
       on conflict(user_id,notice_key) do update set last_version=greatest(bid_alert_private.memberships.last_version,excluded.last_version),
         initial=bid_alert_private.memberships.initial or excluded.initial,updated_at=clock_timestamp();
   end loop;
   for owner_id in select distinct (value->>'userId')::uuid from jsonb_array_elements(coalesce(p_payload->'existing','[]'::jsonb)) where coalesce((value->>'initial')::boolean,true) loop
     select count(*) into existing_count_value from bid_alert_private.memberships where user_id=owner_id and initial;
     if existing_count_value=0 then continue; end if;
     insert into public.bid_alert_inbox(user_id,notice_key,version,kind,message,existing_count) values(owner_id,'@initial',0,'initial','설정한 조건에 맞는 기존 공고를 모았습니다.',existing_count_value)
       on conflict(user_id,notice_key,version) do nothing returning id into notification_id;
     if notification_id is null then
       update public.bid_alert_inbox set existing_count=existing_count_value where user_id=owner_id and notice_key='@initial' and version=0;
     elsif exists(select 1 from public.bid_alert_settings where user_id=owner_id and settings->>'enabled'='true' and settings->>'pushEnabled'='true') then
       insert into bid_alert_private.deliveries(notification_id,subscription_id) select notification_id,s.id from bid_alert_private.subscriptions s where s.user_id=owner_id on conflict do nothing;
     end if;
   end loop;
   if bid_alert_private.storage_bytes()>=cfg.storage_ceiling then
     -- Reject the batch atomically instead of leaving a partially advanced baseline.
     raise exception using errcode='54000',message='알림 저장 한도에 도달했습니다. 기존 자료는 보존되며 다음 작업에서 다시 확인합니다.';
   end if;
   result:=jsonb_build_object('storageFull',false,'observations',observation_count,'events',new_events);
   finalize:=coalesce((p_payload->>'finish')::boolean,false);
   if not finalize then return result; end if;
 elsif p_action='deliveries' then
   if p_payload?'limit' and coalesce(p_payload->>'limit','')!~'^\d{1,2}$' then raise exception using errcode='22023',message='전송 배치 크기를 확인해 주세요.'; end if;
   page_limit:=least(30,greatest(1,coalesce((p_payload->>'limit')::integer,30)));
   update bid_alert_private.deliveries set status='failed' where status='pending' and attempts>=5 and next_attempt_at<=clock_timestamp();
   select array_agg(q.id) into ids from (select d.id from bid_alert_private.deliveries d join public.bid_alert_inbox i on i.id=d.notification_id
     join bid_alert_private.subscriptions s on s.id=d.subscription_id left join public.bid_alert_settings p on p.user_id=i.user_id
     where d.status='pending' and d.attempts<5 and d.next_attempt_at<=clock_timestamp() and s.user_id=i.user_id and
       (i.kind='test' or (p.settings->>'enabled'='true' and p.settings->>'pushEnabled'='true')) order by d.next_attempt_at,d.id limit page_limit for update of d) q;
   update bid_alert_private.deliveries set attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '2 minutes' where id=any(coalesce(ids,'{}'::uuid[]));
   return jsonb_build_object('deliveries',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'subscription',s.subscription,'notification',bid_alert_private.inbox_json(i)) order by d.id),'[]'::jsonb)
     from bid_alert_private.deliveries d join bid_alert_private.subscriptions s on s.id=d.subscription_id join public.bid_alert_inbox i on i.id=d.notification_id where d.id=any(coalesce(ids,'{}'::uuid[]))));
 elsif p_action='settle' then
   if jsonb_typeof(p_payload->'results') is distinct from 'array' or jsonb_array_length(p_payload->'results')>30 then raise exception using errcode='22023',message='전송 결과 배치를 확인해 주세요.'; end if;
   for item in select value from jsonb_array_elements(p_payload->'results') loop
     status_value:=item->>'status';
     if status_value not in ('sent','expired','retry','failed') or status_value is null then raise exception using errcode='22023',message='전송 결과를 확인해 주세요.'; end if;
     select d.subscription_id,d.attempts into subscription_id,attempt_value from bid_alert_private.deliveries d where d.id=(item->>'id')::uuid and d.status='pending' for update;
     if not found then continue; end if;
     if status_value='expired' then delete from bid_alert_private.subscriptions where id=subscription_id;
     elsif status_value='sent' then update bid_alert_private.deliveries set status='sent' where id=(item->>'id')::uuid;
     elsif status_value='failed' or attempt_value>=5 then update bid_alert_private.deliveries set status='failed' where id=(item->>'id')::uuid;
     else
       delay_seconds:=least(86400,300*power(2,greatest(0,attempt_value-1))::integer);
       if item?'retryAfterSeconds' then
         if coalesce(item->>'retryAfterSeconds','')!~'^\d{1,6}$' then raise exception using errcode='22023',message='푸시 재시도 시각을 확인해 주세요.'; end if;
         delay_seconds:=greatest(delay_seconds,least(86400,(item->>'retryAfterSeconds')::integer)); end if;
       update bid_alert_private.deliveries set next_attempt_at=clock_timestamp()+make_interval(secs=>delay_seconds) where id=(item->>'id')::uuid;
     end if;
   end loop;
   return jsonb_build_object('ok',true);
 elsif p_action='finish' then finalize:=true; result:=jsonb_build_object('ok',true);
 else raise exception using errcode='22023',message='지원하지 않는 알림 작업입니다.';
 end if;

 if finalize then
   error_value:=nullif(left(p_payload->>'error',300),'');
   if cfg.lease_failed or error_value is not null then
     if p_payload?'retryWindowMinutes' and (coalesce(p_payload->>'retryWindowMinutes','')!~'^\d{1,2}$' or
       (p_payload->>'retryWindowMinutes')::integer not between 1 and 60) then raise exception using errcode='22023',message='알림 재확인 구간을 점검해 주세요.'; end if;
     update bid_alert_private.runtime set last_error=coalesce(error_value,last_error),
       window_minutes=case when cfg.lease_collecting and p_payload?'retryWindowMinutes' then (p_payload->>'retryWindowMinutes')::integer else window_minutes end,
       lease_id=null,lease_until=null,lease_collecting=false where singleton;
   else
     checkpoint:=p_payload->'checkpoint';
     if checkpoint is not null and checkpoint<>'null'::jsonb then
       if jsonb_typeof(checkpoint)<>'object' or length(coalesce(checkpoint->>'cursor',''))>100 or length(coalesce(checkpoint->>'coverageFrom',''))>100 or
          (checkpoint->>'backfillDay' is not null and checkpoint->>'backfillDay'!~'^\d{4}-\d{2}-\d{2}$') then raise exception using errcode='22023',message='알림 확인 범위를 점검해 주세요.'; end if;
       if checkpoint?'windowMinutes' and (coalesce(checkpoint->>'windowMinutes','')!~'^\d{1,2}$' or
          (checkpoint->>'windowMinutes')::integer not between 1 and 60) then raise exception using errcode='22023',message='알림 확인 구간을 점검해 주세요.'; end if;
     end if;
     update bid_alert_private.runtime set
       cursor_value=case when cfg.lease_collecting and checkpoint?'cursor' then checkpoint->>'cursor' else cursor_value end,
       backfill_day=case when cfg.lease_collecting and checkpoint?'backfillDay' then checkpoint->>'backfillDay' else backfill_day end,
       coverage_from=case when cfg.lease_collecting and checkpoint?'coverageFrom' then checkpoint->>'coverageFrom' else coverage_from end,
       window_minutes=case when cfg.lease_collecting and checkpoint?'windowMinutes' then (checkpoint->>'windowMinutes')::integer else window_minutes end,
       last_checked_at=case when cfg.lease_collecting then clock_timestamp() else last_checked_at end,
       last_error=case when cfg.lease_collecting then nullif(left(p_payload->>'warning',300),'') else last_error end,
       lease_id=null,lease_until=null,lease_collecting=false,lease_failed=false where singleton;
   end if;
   return result;
 end if;
 return jsonb_build_object('ok',true);
end $$;

-- pg_net, pg_cron and Vault are Supabase-provided extensions. Only this private
-- cron function reads the Vault plaintext; it never returns it or embeds it in SQL.
create or replace function bid_alert_private.tick()
returns void language plpgsql security invoker set search_path='' as $$
declare cfg bid_alert_private.runtime%rowtype; token_value text;
begin
 select * into strict cfg from bid_alert_private.runtime where singleton;
 if not cfg.configured or cfg.endpoint is distinct from 'https://construction-bid-nine.vercel.app/api/alerts?action=worker' or cfg.lease_until>clock_timestamp() then return; end if;
 select decrypted_secret into token_value from vault.decrypted_secrets where id=cfg.vault_secret_id;
 if token_value is null then
   update bid_alert_private.runtime set last_error='알림 작업 연결 설정을 확인해 주세요.' where singleton; return; end if;
 perform net.http_post(url:=cfg.endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token_value),body:='{}'::jsonb,timeout_milliseconds:=55000);
end $$;

create or replace function public.bid_alert_admin_setup(p_token text,p_endpoint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare secret_id uuid; owner_id uuid:=auth.uid(); job bigint;
begin
 if owner_id is null or not exists(select 1 from public.bid_admin_users where user_id=owner_id) then raise exception using errcode='42501',message='admin_required',detail='관리자 권한이 필요합니다.'; end if;
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{43,128}$' or p_endpoint is distinct from 'https://construction-bid-nine.vercel.app/api/alerts?action=worker' then raise exception using errcode='22023',message='알림 서버 연결 설정을 확인해 주세요.'; end if;
 perform pg_advisory_xact_lock(62615003);
 select vault_secret_id into secret_id from bid_alert_private.runtime where singleton for update;
 if secret_id is null then
   select vault.create_secret(p_token,'bid-personal-alert-worker','Private token for the personalized alert worker only') into secret_id;
 else perform vault.update_secret(secret_id,p_token,'bid-personal-alert-worker','Private token for the personalized alert worker only'); end if;
 update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(p_token,'UTF8')),vault_secret_id=secret_id,endpoint=p_endpoint,
   last_error=null,lease_id=null,lease_until=null,lease_collecting=false,lease_failed=false where singleton;
 -- Named schedule updates only this feature's job. Existing collector jobs remain intact.
 select cron.schedule('bid-personal-alerts','*/10 * * * *','select bid_alert_private.tick();') into job;
 return jsonb_build_object('configured',true,'scheduled',true);
end $$;

revoke all on all tables in schema bid_alert_private from public,anon,authenticated;
revoke all on all functions in schema bid_alert_private from public,anon,authenticated;
revoke all on function public.bid_alert_worker(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.bid_alert_worker(text,text,jsonb) to anon,authenticated;
revoke all on function public.bid_alert_admin_setup(text,text) from public,anon,authenticated;
grant execute on function public.bid_alert_admin_setup(text,text) to authenticated;
commit;
