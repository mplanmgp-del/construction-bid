-- Avoid per-notice parsing and SQL iteration when the corresponding filter
-- is absent. Requested filters retain their existing audited checks verbatim.
begin;
do $migration$
declare definition text;anchor text;replacement text;occurrences integer;
 start_at integer;end_at integer;block_text text;
begin
 select replace(pg_get_functiondef('bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('skip-unused-search-filter-work-v1' in definition)>0 then return;end if;
 if position('saved-profile-code-match-v1' in definition)=0
   or position('private-real-deadline-filter-v1' in definition)=0
   or position('industry-code-match-v1' in definition)=0 then
   raise exception 'Audited search matcher prerequisites changed';end if;

 anchor:=$a$for excluded in select btrim(value) from unnest(string_to_array(lower(bid_active_catalog_private.clean_search_text(p_filters->>'excludeKeyword')),',')) value loop$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited excluded-keyword loop changed';end if;
 start_at:=position(anchor in definition);
 anchor:=$a$if excluded<>'' and strpos(search_text,excluded)>0 then return 'excluded';end if;$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 or position(anchor in definition)<=start_at then
   raise exception 'Audited excluded-keyword predicate changed';end if;
 anchor:='end loop;';
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited excluded-keyword loop ending changed';end if;
 end_at:=position(anchor in definition)+length(anchor);
 if end_at<=position($a$if excluded<>'' and strpos(search_text,excluded)>0 then return 'excluded';end if;$a$ in definition) then
   raise exception 'Audited excluded-keyword boundaries changed';end if;
 block_text:=substring(definition from start_at for end_at-start_at);
 replacement:=E' -- skip-unused-search-filter-work-v1\n if coalesce(p_filters->>''excludeKeyword'','''')<>'''' then\n'
   ||block_text||E'\n end if;';
 definition:=overlay(definition placing replacement from start_at for end_at-start_at);

 anchor:=$a$price:=case when jsonb_typeof(p_notice->'estimatedPrice')='number' and (p_notice->>'estimatedPrice')::numeric>=0 then (p_notice->>'estimatedPrice')::numeric end;$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited search amount parser changed';end if;
 start_at:=position(anchor in definition);
 anchor:=$a$if price<lower_amount or price>upper_amount then return 'excluded';end if;$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited search amount bound changed';end if;
 end_at:=position(anchor in definition)+length(anchor);
 if end_at<=start_at then raise exception 'Audited search amount block changed';end if;
 block_text:=substring(definition from start_at for end_at-start_at);
 if position($a$if (lower_amount is not null or upper_amount is not null) and price is null then return 'excluded';end if;$a$ in block_text)=0 then
   raise exception 'Audited missing-amount guard changed';end if;
 definition:=overlay(definition placing E' if lower_amount is not null or upper_amount is not null then\n'||block_text||E'\n end if;'
   from start_at for end_at-start_at);

 anchor:=$a$closing_day:=(bid_active_catalog_private.safe_time(p_notice->>'deadline') at time zone 'Asia/Seoul')::date;$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited real-deadline parser changed';end if;
 start_at:=position(anchor in definition);
 anchor:=$a$if coalesce(p_filters->>'deadlineTo','')<>'' and closing_day>(p_filters->>'deadlineTo')::date then return 'excluded';end if;$a$;
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited search deadline bound changed';end if;
 end_at:=position(anchor in definition)+length(anchor);
 if end_at<=start_at then raise exception 'Audited search deadline block changed';end if;
 block_text:=substring(definition from start_at for end_at-start_at);
 -- Includes the private procurement rule: a requested date range requires a
 -- real deadline. With neither bound requested that rule already does nothing.
 if position('private-real-deadline-filter-v1' in block_text)=0 then
   raise exception 'Audited private real-deadline guard changed';end if;
 replacement:=E' if coalesce(p_filters->>''deadlineFrom'','''')<>'''' or coalesce(p_filters->>''deadlineTo'','''')<>'''' then\n'
   ||block_text||E'\n end if;';
 definition:=overlay(definition placing replacement from start_at for end_at-start_at);
 execute definition;
end $migration$;
revoke all on function bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz) from public,anon,authenticated;
commit;
