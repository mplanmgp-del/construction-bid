-- Disposable PostgreSQL regression: private source dates never become deadlines.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;
delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.groups;
delete from bid_active_catalog_private.sources;
delete from bid_active_catalog_private.live_cursors;
create function pg_temp.private_notice(p_number text default 'R26BK01774453') returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000',
 'title','민간 철거공사','agency','민간 발주기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute','deadline','','openingAt',now()+interval '2 days',
 'status','접수중','source','live','procurementSource','private','bidMethod','직찰','licenses','[]'::jsonb,
 'allowedRegions','["전국"]'::jsonb,'regionComplete',true,'licenseComplete',true,'contractMethod','일반경쟁','estimatedPrice',100000000);
$$;
create function pg_temp.private_query(p_more jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','','filters','{}'::jsonb,'limit',50)||p_more;
$$;
do $$declare n jsonb:=pg_temp.private_notice();c jsonb;r jsonb;s jsonb;scope text;lease text;job jsonb;before_cursor timestamptz;failed boolean:=false;pub jsonb;public_pending text;begin
 assert bid_active_catalog_private.ongoing(n),'private notice with missing deadline and future opening remains reviewable';
 assert not bid_active_catalog_private.ongoing(n-'procurementSource'),'public missing-deadline policy is unchanged';
 assert not bid_active_catalog_private.ongoing(n||jsonb_build_object('openingAt',now()-interval '1 minute')),'past private opening cannot stay ongoing';
 assert not bid_active_catalog_private.ongoing(n||'{"openingAt":"","deadline":""}'::jsonb),'private dates both unknown cannot be advertised current';
 assert not bid_active_catalog_private.ongoing(n||'{"deadline":"invalid"}'::jsonb),'malformed nonempty private deadline is rejected';
 assert not bid_active_catalog_private.ongoing((n-'procurementSource')||jsonb_build_object('deadline',now()+interval '3 days','openingAt','invalid')),'malformed public opening remains rejected';
 assert not bid_active_catalog_private.ongoing(n||'{"status":"취소"}'::jsonb),'private cancellations are inactive';
 assert bid_active_catalog_private.phase(n,now())='확인필요','opening does not manufacture active submission or countdown';
 assert bid_active_catalog_private.compact(n)->>'procurementSource'='private' and bid_active_catalog_private.compact(n)->>'bidMethod'='직찰','private origin and bid method survive compaction';
 assert bid_active_catalog_private.alarm_active(n),'reviewable private heads reach rule matching';
 begin perform public.bid_active_catalog_worker('bad','claim','{}');exception when insufficient_privilege then failed:=true;end;
 assert failed and not exists(select 1 from bid_active_catalog_private.sources),'bad token cannot seed either provider';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');scope:=c->>'scopeVersion';lease:=c->>'leaseId';
 assert lease is not null,'existing authenticated catalog lease is used';
 assert c#>>'{sources,0,procurementSource}'='private','private work receives a bounded early call slot';
 assert exists(select 1 from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'kind'='current'),'private monthly discovery runs independently of public backlog';
 assert exists(select 1 from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'kind'='registered'),'private registration stream is independently checkpointed';
 assert exists(select 1 from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'kind'='modified'),'private posted stream uses the documented modified transport kind';
 assert c#>>'{status,privateCoverage,complete}'='false','private partial collection has its own honest coverage';
 assert c#>>'{status,currentCoverage,pending}'=(select count(*)::text from bid_active_catalog_private.sources where procurement_source='public' and kind='current' and completed_at is null),'public coverage excludes all private current windows';
 assert c#>>'{status,pendingSources}'=(select count(*)::text from bid_active_catalog_private.sources where procurement_source='public' and kind<>'current' and completed_at is null),'public pending-source metadata stays provider-specific';
 public_pending:=c#>>'{status,currentCoverage,pending}';
 select value into job from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'type'='공사' and x->>'kind'='registered' limit 1;
 select cursor_at into before_cursor from bid_active_catalog_private.live_cursors where scope_version=scope and type='공사' and kind='registered';
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',job->>'id','page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert r->>'ok'='true','unknown private deadline is durably indexed';
 assert exists(select 1 from bid_active_catalog_private.deadline_index where number=n->>'number' and deadline is null and search_at=(n->>'postedAt')::timestamptz),'real deadline stays null; posted date is stored separately for range';
 assert exists(select 1 from bid_active_catalog_private.verification where number=n->>'number'),'private heads still require exact revision verification';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.private_query());
 assert r->>'totalCount'='0','unverified private notice is withheld';
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sources',jsonb_build_array(jsonb_build_object('id',job->>'id','page',1,'totalCount',1,'receivedCount',1,'items','[]'::jsonb,'observed','[]'::jsonb,'complete',true))));
 assert r->>'ok'='true','private page completes through existing index fence';
 assert (select cursor_at=before_cursor from bid_active_catalog_private.live_cursors where scope_version=scope and type='공사' and kind='registered'),'private completion never advances public cursor';
 assert (select cursor_at=(job->>'to')::timestamptz from bid_active_catalog_private.private_cursors where scope_version=scope and type='공사' and kind='registered'),'private cursor advances only after durable page acknowledgement';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'=n->>'number' and x#>>'{notice,procurementSource}'='private'),'verification receives the preserved private provider hint';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'groups',jsonb_build_array(jsonb_build_array(n))));
 assert r->>'ok'='true','exact private revision verification publishes';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.private_query());
 assert r->>'totalCount'='1' and r#>>'{items,0,deadline}'='' and r#>>'{items,0,procurementSource}'='private','verified private notice is searchable without invented deadline';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',pg_temp.private_query(jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion')));
 assert s#>>'{privateCoverage,complete}'='false' and exists(select 1 from jsonb_array_elements_text(s->'warnings') w where w like '%민간%'),'search explicitly reports private collection coverage';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.private_query(jsonb_build_object('from',to_char(now()-interval '1 day','YYYY-MM-DD'),'to',to_char(now()-interval '1 day','YYYY-MM-DD'))));
 assert r->>'totalCount'='1','private unknown deadline is ranged by posted day';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.private_query(jsonb_build_object('from',to_char(now()+interval '2 days','YYYY-MM-DD'),'to',to_char(now()+interval '2 days','YYYY-MM-DD'))));
 assert r->>'totalCount'='0','opening day never substitutes for the search date';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.private_query('{"filters":{"deadlineFrom":"1995-10-01"}}'::jsonb));
 assert r->>'totalCount'='0','an explicit real-deadline filter excludes unknown private deadlines';
 assert bid_active_catalog_private.current_coverage()->>'pending'=public_pending,'private completion/publication does not change public source coverage';
 -- A public source still indexes and verifies through the same lease and gates.
 select value into job from jsonb_array_elements(c->'sources') x where x->>'procurementSource' is distinct from 'private' and x->>'type'='공사' and x->>'kind'='registered' limit 1;
 pub:=(pg_temp.private_notice('R26PUBLICPRESERVED')-array['procurementSource','bidMethod'])||jsonb_build_object('deadline',now()+interval '3 days','openingAt',now()+interval '4 days');
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',job->>'id','page',1,'batch',0,'batches',1,'notices',jsonb_build_array(pub),'removed','[]'::jsonb));
 assert r->>'ok'='true' and exists(select 1 from bid_active_catalog_private.deadline_index where number=pub->>'number' and deadline=(pub->>'deadline')::timestamptz and search_at=deadline),'public deadlines retain their original search date';
 -- A failed private stream preserves cursor and next-attempt backoff.
 select value into job from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'kind'='modified' and x->>'type'='공사' limit 1;
 select cursor_at into before_cursor from bid_active_catalog_private.private_cursors where scope_version=scope and type='공사' and kind='modified';
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'failedSources',jsonb_build_array(jsonb_build_object('id',job->>'id','error','provider retry later'))));
 assert r->>'ok'='true' and (select cursor_at=before_cursor from bid_active_catalog_private.private_cursors where scope_version=scope and type='공사' and kind='modified'),'failed private stream cannot advance its cursor';
 assert exists(select 1 from bid_active_catalog_private.sources where id=job->>'id' and failures=1 and next_attempt>now() and completed_at is null),'private stream retains durable provider backoff';
 assert not has_schema_privilege('anon','bid_active_catalog_private','usage') and not has_table_privilege('authenticated','bid_active_catalog_private.private_cursors','select'),'private checkpoints add no role access';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime) and (select storage_ceiling=33554432 from bid_alert_private.runtime),'existing allocated budgets are unchanged';
end $$;
-- Nonfocus private notices may match a saved user rule without entering the
-- focused current index. Their exact-history lookup must retain its provider.
insert into auth.users(id,email) values('38383838-3838-4838-8838-383838383838','private-nonfocus@example.invalid') on conflict do nothing;
insert into public.bid_alert_settings(user_id,settings) values('38383838-3838-4838-8838-383838383838','{"enabled":true,"filter":{"keyword":"리모델링"}}') on conflict(user_id) do update set settings=excluded.settings;
do $$declare c jsonb;r jsonb;job jsonb;n jsonb;lease text;scope text;begin
 select lease_id::text into lease from bid_active_catalog_private.runtime where singleton;
 if lease is not null then perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));end if;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';scope:=c->>'scopeVersion';
 select value into job from jsonb_array_elements(c->'sources') x where x->>'procurementSource'='private' and x->>'kind'='current' and x->>'type'='공사' limit 1;
 n:=pg_temp.private_notice('R26PRIVATENONFOCUS')||'{"title":"리모델링 공사"}'::jsonb;
 assert not bid_active_catalog_private.current_focus(n),'fixture is outside the focused title index';
 assert exists(select 1 from jsonb_array_elements(c->'rules') u where u#>>'{settings,filter,keyword}'='리모델링'),'fixture has an actual saved matching user rule';
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',job->>'id','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 assert r->>'ok'='true','an empty public-search index fence precedes personal source commit';
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
 'sources',jsonb_build_array(jsonb_build_object('id',job->>'id','page',1,'totalCount',1,'receivedCount',1,'items',jsonb_build_array(n),'observed',jsonb_build_array(jsonb_build_object('type','공사','number',n->>'number','revision','000','sourceUpdatedAt',n->>'sourceUpdatedAt','procurementSource','private')),'rawIdentities',jsonb_build_array((n->>'number')||':000'),'complete',true))));
 assert r->>'ok'='true' and exists(select 1 from bid_active_catalog_private.verification where number=n->>'number'),'nonfocus user-rule candidate enters durable verification queue';
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number=n->>'number') and not exists(select 1 from bid_active_catalog_private.groups where number=n->>'number'),'provider hint cannot depend on indexed/tracked copies';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert exists(select 1 from jsonb_array_elements(c->'verify') v where v->>'number'=n->>'number' and v->>'procurementSource'='private'),'nonfocus private lookup keeps its provider without an index/group hint';
end $$;
rollback;
