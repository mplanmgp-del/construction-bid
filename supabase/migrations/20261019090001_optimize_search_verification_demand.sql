-- Keep the same bounded, ordered verification demand while evaluating its
-- expensive possible-match classifier only until the first 100 matches.
-- No result, count, retry, lease, source, token, privilege or budget changes.
begin;
do $migration$
declare definition text;anchor text;replacement text;candidate_query text;matcher text;
 aggregate_at integer;candidate_at integer;matcher_at integer;request_age_at integer;end_at integer;occurrences integer;
begin
 select replace(pg_get_functiondef('bid_active_catalog_private.request_search_verification(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('ordered-search-demand-v1' in definition)>0 then return;end if;
 -- Demand must include both existing industry-refresh relaxations and the
 -- saved-profile code projection before its classifier is moved unchanged.
 if position('saved-profile-code-demand-v1' in definition)=0
   or position('preserve-current-matching-priority-v1' in definition)=0
   or position('private-search-date-v1' in definition)=0 then
   raise exception 'Audited verification demand prerequisites changed';end if;
 anchor:='title_keyword text;';
 occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
 if occurrences<>1 then raise exception 'Audited verification demand declaration changed';end if;
 definition:=replace(definition,anchor,anchor||' candidate record;selected_count integer;');

 aggregate_at:=position(' select coalesce(jsonb_agg(jsonb_build_object(''type'',q.type,''number'',q.number))' in definition);
 candidate_at:=position('   select d.type,d.number,v.number is not null queued' in definition);
 matcher_at:=position('     and bid_active_catalog_private.search_match(d.notice,f' in definition);
 request_age_at:=position('     and (v.search_requested_at is null or v.search_request_key is distinct from request_key' in definition);
 anchor:=E' limit 100\n ) q;';
 end_at:=position(anchor in definition);
 if least(aggregate_at,candidate_at,matcher_at,request_age_at,end_at)<=0
   or not(aggregate_at<candidate_at and candidate_at<matcher_at and matcher_at<request_age_at and request_age_at<end_at) then
   raise exception 'Audited verification demand query boundaries changed';end if;
 -- Retain every cheap candidate predicate and the exact existing priority,
 -- deadline, publication-time, previous-request and identity ordering.
 candidate_query:=substring(definition from candidate_at for matcher_at-candidate_at)
   ||substring(definition from request_age_at for end_at-request_age_at);
 candidate_query:=replace(candidate_query,'select d.type,d.number,v.number is not null queued',
   'select d.type,d.number,d.notice,d.verified_at,v.number is not null queued');
 matcher:=substring(definition from matcher_at+length('     and ') for request_age_at-matcher_at-length('     and '));
 matcher:=replace(replace(matcher,'d.notice','candidate.notice'),'d.verified_at','candidate.verified_at');
 if matcher~'(^|[^A-Za-z_])[dv][.]' then
   raise exception 'Audited verification classifier candidate fields changed';end if;
 replacement:=E' -- ordered-search-demand-v1: the sorted cursor has the same candidate snapshot as the old SELECT.\n'
   ||E' heads:=''[]''::jsonb;new_heads:=''[]''::jsonb;needed:=0;selected_count:=0;\n for candidate in\n'
   ||candidate_query||E'\n loop\n   if '||btrim(matcher)||E' then\n'
   ||E'     heads:=heads||jsonb_build_array(jsonb_build_object(''type'',candidate.type,''number'',candidate.number));\n'
   ||E'     if not candidate.queued then\n'
   ||E'       new_heads:=new_heads||jsonb_build_array(jsonb_build_object(''type'',candidate.type,''number'',candidate.number));needed:=needed+1;\n'
   ||E'     end if;\n     selected_count:=selected_count+1;exit when selected_count=100;\n   end if;\n end loop;';
 definition:=overlay(definition placing replacement from aggregate_at for end_at+length(anchor)-aggregate_at);
 execute definition;
end $migration$;
revoke all on function bid_active_catalog_private.request_search_verification(jsonb) from public,anon,authenticated;
commit;
