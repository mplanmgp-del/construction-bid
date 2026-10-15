-- Recoverable inbox deletion. Notice versions and membership ledgers remain
-- unchanged, so hiding an alert can never cause its old version to notify again.
begin;
alter table public.bid_alert_inbox add column if not exists deleted_at timestamptz;
create index if not exists bid_alert_inbox_visible on public.bid_alert_inbox(user_id,created_at desc,id desc) where deleted_at is null;
create index if not exists bid_alert_inbox_deleted on public.bid_alert_inbox(user_id,deleted_at desc,id desc) where deleted_at is not null;

create or replace function bid_alert_private.inbox_json(i public.bid_alert_inbox)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',i.id,'kind',i.kind,'notice',i.notice,'message',i.message,'changeFields',i.change_fields,
 'createdAt',i.created_at,'readAt',i.read_at,'deletedAt',i.deleted_at)
 ||case when i.existing_count is null then '{}'::jsonb else jsonb_build_object('existingCount',i.existing_count) end;
$$;

-- Preserve the current service status and latest catalog predicates in the
-- original overview; exclude hidden rows BEFORE pagination and unread counts.
do $$ declare definition text;begin
 select pg_get_functiondef('bid_alert_private.overview(uuid,integer,integer)'::regprocedure) into definition;
 if position('deleted_at is null' in definition)=0 then
   definition:=replace(definition,'from public.bid_alert_inbox where user_id=p_user',
     'from public.bid_alert_inbox where user_id=p_user and deleted_at is null');
   execute definition;
 end if;
end $$;

create or replace function bid_alert_private.overview(p_user uuid,p_offset integer,p_existing_offset integer,p_deleted_offset integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;deleted_items jsonb;deleted_count bigint;
begin
 if p_deleted_offset is null or p_deleted_offset not between 0 and 999999 then
 raise exception using errcode='22023',message='삭제한 알림 페이지를 확인해 주세요.';end if;
 result:=bid_alert_private.overview(p_user,p_offset,p_existing_offset);
 select count(*) into deleted_count from public.bid_alert_inbox where user_id=p_user and deleted_at is not null;
 select coalesce(jsonb_agg(bid_alert_private.inbox_json(q) order by q.deleted_at desc,q.id desc),'[]'::jsonb) into deleted_items
 from (select * from public.bid_alert_inbox where user_id=p_user and deleted_at is not null
   order by deleted_at desc,id desc limit 30 offset p_deleted_offset) q;
 return result||jsonb_build_object('deletedNotifications',deleted_items,'deletedCount',deleted_count,
   'deletedHasMore',deleted_count>p_deleted_offset+30);
end $$;

do $$ declare definition text;begin
 select pg_get_functiondef('public.bid_alert_user(text,jsonb)'::regprocedure) into definition;
 if position('deleted_offset integer' in definition)=0 then
   definition:=replace(definition,'existing_offset integer:=0;',
     'existing_offset integer:=0; deleted_offset integer:=0; affected_ids uuid[];');
   definition:=replace(definition,
     'elsif p_action<>''get'' then raise exception',
     $branch$elsif p_action in ('delete','restore') then
   if (p_payload?'id' and p_payload?'all') or
     (not(p_payload?'id') and p_payload->'all' is distinct from 'true'::jsonb) or
     (p_payload?'id' and (jsonb_typeof(p_payload->'id') is distinct from 'string' or
       coalesce(p_payload->>'id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
     raise exception using errcode='22023',message='삭제하거나 복원할 알림을 확인해 주세요.';
   end if;
   if p_action='delete' then
     -- The statement snapshot defines "all"; a later new alert stays visible.
     with affected as (
       update public.bid_alert_inbox set deleted_at=stamp where user_id=owner_id and deleted_at is null
         and (p_payload->'all'='true'::jsonb or id=(p_payload->>'id')::uuid) returning id
     ) select coalesce(array_agg(id),'{}'::uuid[]) into affected_ids from affected;
   else
     with affected as (
       update public.bid_alert_inbox set deleted_at=null where user_id=owner_id and deleted_at is not null
         and (p_payload->'all'='true'::jsonb or id=(p_payload->>'id')::uuid) returning id
     ) select coalesce(array_agg(id),'{}'::uuid[]) into affected_ids from affected;
     -- Restoring the inbox never resets delivery state or resends old pushes.
   end if;
   -- Also settle a stale pending insert that raced with the earlier deletion.
   update bid_alert_private.deliveries d set status='failed'
     where d.status='pending' and d.notification_id=any(affected_ids);
   return jsonb_build_object('ok',true);
 elsif p_action<>'get' then raise exception$branch$);
   definition:=replace(definition,
     'return bid_alert_private.overview(owner_id,page_offset,existing_offset);',
     $paging$if p_payload?'deletedOffset' then
   if coalesce(p_payload->>'deletedOffset','')!~'^\d{1,6}$' then
     raise exception using errcode='22023',message='삭제한 알림 페이지를 확인해 주세요.';
   end if;
   deleted_offset:=(p_payload->>'deletedOffset')::integer;
 end if;
 return bid_alert_private.overview(owner_id,page_offset,existing_offset,deleted_offset);$paging$);
   definition:=replace(definition,'where user_id=owner_id and read_at is null',
     'where user_id=owner_id and deleted_at is null and read_at is null');
   definition:=replace(definition,'where user_id=owner_id and id::text in',
     'where user_id=owner_id and deleted_at is null and id::text in');
   execute definition;
 end if;
 -- Both selection and its final response guard visibility. A stale delivery
 -- inserted by concurrent work is settled on the next dispatch attempt.
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('deleted_at' in definition)=0 then
   definition:=replace(definition,
     'update bid_alert_private.deliveries set status=''failed'' where status=''pending'' and attempts>=5',
     'update bid_alert_private.deliveries d set status=''failed'' from public.bid_alert_inbox i where i.id=d.notification_id and i.deleted_at is not null and d.status=''pending''; update bid_alert_private.deliveries set status=''failed'' where status=''pending'' and attempts>=5');
   definition:=replace(definition,
     'where d.status=''pending'' and d.attempts<5',
     'where i.deleted_at is null and d.status=''pending'' and d.attempts<5');
   definition:=replace(definition,
     'where d.id=any(coalesce(ids,''{}''::uuid[]))',
     'where i.deleted_at is null and d.status=''pending'' and d.id=any(coalesce(ids,''{}''::uuid[]))');
   execute definition;
 end if;
end $$;

-- Existing owner RLS, worker token checks and 16/32 MiB ceilings stay intact.
revoke all on function bid_alert_private.overview(uuid,integer,integer,integer) from public,anon,authenticated;
revoke all on function bid_alert_private.inbox_json(public.bid_alert_inbox) from public,anon,authenticated;
revoke all on function public.bid_alert_user(text,jsonb) from public,anon,authenticated;
grant execute on function public.bid_alert_user(text,jsonb) to authenticated;
commit;
