-- Build the same regional source text without four aggregate subqueries for
-- every notice. CLI-generated and ordered after the existing regional patches.
begin;

create or replace function bid_active_catalog_private.region_keyword_corpus(p_notice jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare corpus text;field text;items jsonb;entry text;i integer;
begin
 corpus:=concat_ws(' ',
   p_notice->>'regionSearchText',p_notice->>'title',p_notice->>'agency',p_notice->>'demandAgency',
   p_notice->>'province',p_notice->>'district',p_notice->>'description',p_notice->>'duration',
   p_notice->>'contractMethod',p_notice->>'noticeKind',p_notice->>'bidMethod',p_notice->>'category',p_notice->>'type');
 foreach field in array array['allowedRegions','requirements','licenses'] loop
   items:=p_notice->field;
   if jsonb_typeof(items)='array' then
     for i in 0..jsonb_array_length(items)-1 loop
       entry:=items->>i;
       if entry is not null then corpus:=corpus||' '||entry;end if;
     end loop;
   end if;
 end loop;
 items:=p_notice->'documents';
 if jsonb_typeof(items)='array' then
   for i in 0..jsonb_array_length(items)-1 loop
     entry:=items->i->>'name';
     if entry is not null then corpus:=corpus||' '||entry;end if;
   end loop;
 end if;
 return lower(bid_active_catalog_private.clean_search_text(corpus));
end $$;

revoke all on function bid_active_catalog_private.region_keyword_corpus(jsonb) from public,anon,authenticated;
commit;
