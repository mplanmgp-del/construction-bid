-- Keep signed keyset paging and explicit sort options. The default order adds
-- a snapshot-time phase rank and a latest-posted tie for equal deadlines.
begin;
do $$declare definition text;old_rank text;new_rank text;old_guard text;new_guard text;old_parts text[];new_parts text[];i integer;begin
 select pg_get_functiondef('bid_active_catalog_private.search_page(jsonb)'::regprocedure) into definition;
 if position('current-notice-priority-v1' in definition)>0 then return;end if;
 old_rank:=$anchor$case when sort_name in ('amountAsc','amountDesc') and jsonb_typeof(d.notice->'estimatedPrice') is distinct from 'number' then 1$anchor$;
 new_rank:=$replacement$case when sort_name='deadline' then -- current-notice-priority-v1
       case bid_active_catalog_private.phase(d.notice,as_of)
         when '마감 임박' then 0
         when '진행중' then case when d.deadline>as_of then 1 else 2 end
         when '예정' then 3 else 4 end
       when sort_name in ('amountAsc','amountDesc') and jsonb_typeof(d.notice->'estimatedPrice') is distinct from 'number' then 1$replacement$;
 old_guard:=$anchor$or last_null not in (0,1) or last_value is null$anchor$;
 new_guard:=$replacement$or last_null is null or (sort_name='deadline' and last_null not between 0 and 4)
   or (sort_name<>'deadline' and (last_null not in (0,1) or last_posted<>0))
   or last_value is null or last_value::text in ('NaN','Infinity','-Infinity')
   or last_posted is null or last_posted::text in ('NaN','Infinity','-Infinity')$replacement$;
 if position(old_rank in definition)=0 or position(old_guard in definition)=0 then
   raise exception 'Verified search priority anchors changed';
 end if;
 definition:=replace(replace(definition,old_rank,new_rank),old_guard,new_guard);
 old_parts:=array[
   $a$last_null integer;last_value numeric;last_type text;$a$,
   $a$last_value:=(cursor_data#>>'{k,s}')::numeric;$a$,
   $a$else extract(epoch from d.deadline)*1000 end,0) sort_value$a$,
   $a$null_rank,sort_value,type,number$a$,
   $a$last_null,last_value,last_type,last_number$a$,
   $a$p.null_rank,p.sort_value,p.type,p.number$a$,
   $a$jsonb_build_object('nr',null_rank,'s',sort_value,'t',type,'n',number)$a$
 ];
 new_parts:=array[
   $a$last_null integer;last_value numeric;last_posted numeric;last_type text;$a$,
   $a$last_value:=(cursor_data#>>'{k,s}')::numeric;last_posted:=(cursor_data#>>'{k,ps}')::numeric;$a$,
   $a$else extract(epoch from d.deadline)*1000 end,0) sort_value,
     case when sort_name='deadline' then coalesce(-extract(epoch from bid_active_catalog_private.safe_time(d.notice->>'postedAt'))*1000,1000000000000000000) else 0 end posted_sort_value$a$,
   $a$null_rank,sort_value,posted_sort_value,type,number$a$,
   $a$last_null,last_value,last_posted,last_type,last_number$a$,
   $a$p.null_rank,p.sort_value,p.posted_sort_value,p.type,p.number$a$,
   $a$jsonb_build_object('nr',null_rank,'s',sort_value,'ps',posted_sort_value,'t',type,'n',number)$a$
 ];
 for i in 1..cardinality(old_parts) loop
   if position(old_parts[i] in definition)=0 then raise exception 'Verified search posting tie anchor % changed',i;end if;
   definition:=replace(definition,old_parts[i],new_parts[i]);
 end loop;
 execute definition;
 -- Old tokens encode the earlier deadline ordering. Never let them silently
 -- continue after the tuple meaning changes; reruns do not churn generations.
 update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current() where singleton;
end $$;
commit;
