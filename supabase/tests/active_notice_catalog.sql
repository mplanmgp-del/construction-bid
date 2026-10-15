-- Disposable PostgreSQL only. All fixtures and capacity overrides roll back.
begin;
do $$ begin
 assert not has_schema_privilege('anon','bid_active_catalog_private','usage'),'catalog remains private';
 assert not has_table_privilege('authenticated','bid_active_catalog_private.groups','select'),'members cannot bypass catalog server';
 assert has_function_privilege('anon','public.bid_active_catalog_worker(text,text,jsonb)','execute'),'token RPC remains available';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'existing 32MiB ceiling unchanged';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'catalog shares budget with a 16MiB inner ceiling';
end $$;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
insert into auth.users(id,email) values('33333333-3333-4333-8333-333333333333','catalog@example.invalid') on conflict do nothing;
insert into public.bid_alert_settings(user_id,settings) values('33333333-3333-4333-8333-333333333333',jsonb_set(bid_alert_private.defaults(),'{enabled}','true')) on conflict do nothing;
do $$ declare c jsonb; again jsonb; failed boolean:=false; begin
 begin perform public.bid_active_catalog_worker('wrong','claim','{}'); exception when insufficient_privilege then failed:=true; end;
 assert failed,'invalid worker token denied';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is not null,'claim succeeds';
 assert c->>'scopeVersion' is not null and jsonb_array_length(c->'rules')=1,'claim carries private enabled rules and immutable scope';
 assert not exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'pageSize'<>'999'),'each source reads provider maximum 999 rows';
 assert jsonb_array_length(c->'sources')<=6 and jsonb_array_length(c->'verify')<=8,'bounded source and verification work';
 assert exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'kind'='history'),'history cannot starve behind four live streams';
 assert (select min(from_at)='1995-10-01T00:00:00+09:00' from bid_active_catalog_private.sources where kind='history'),'source supported origin seeded without recent-day cutoff';
 assert (select count(distinct type)=2 from bid_active_catalog_private.sources where kind='history'),'both business types seeded';
 assert not exists(select 1 from bid_active_catalog_private.sources where kind='history' and extract(day from from_at at time zone 'Asia/Seoul')<>1),'history windows use every Korean calendar month, independent of database timezone';
 assert (select count(*)=2*((extract(year from now() at time zone 'Asia/Seoul')::int-1995)*12+extract(month from now() at time zone 'Asia/Seoul')::int-10+1) from bid_active_catalog_private.sources where kind='history'),'no calendar month omitted by UTC interval rollover';
 assert not bid_active_catalog_private.active('{"status":"마감","deadline":"2100-01-01T00:00:00Z"}'),'explicit closed state overrides retained future date';
 assert not bid_active_catalog_private.active('{"status":"접수중","noticeKind":"취소공고","deadline":"2100-01-01T00:00:00Z"}'),'cancellation source kind overrides derived status';
 assert (select count(*)=4 from bid_active_catalog_private.sources where kind in ('registered','modified')),'independent registration and change windows';
 again:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert again->>'leaseId' is null,'concurrent claim receives no lease';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;
create function pg_temp.notice(p_number text,p_revision text,p_status text default '접수중') returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':'||p_revision,'type','공사','number',p_number,'revision',p_revision,
 'title','과거 게시 철거공사','agency','서울시','category','철거·해체','province','서울특별시','district','영등포구',
 'postedAt','1999-01-01T10:00:00+09:00','sourceUpdatedAt','2026-10-15T10:00:00+09:00','deadline','2100-01-01T10:00:00+09:00',
 'status',p_status,'source','live','description',repeat('detail',1000),'requirements',jsonb_build_array('details'),'documents',jsonb_build_array(jsonb_build_object('name','detail')));
$$;
create function pg_temp.source(p_id text,p_page integer,p_total integer,p_items jsonb,p_complete boolean,p_received integer default null) returns jsonb language sql as $$
 select jsonb_build_object('id',p_id,'page',p_page,'totalCount',p_total,'receivedCount',coalesce(p_received,jsonb_array_length(p_items)),
 'items',p_items,'observed',coalesce((select jsonb_agg(distinct jsonb_build_object('type',n->>'type','number',n->>'number')) from jsonb_array_elements(p_items) n),'[]'::jsonb),'complete',p_complete);
$$;

do $$ declare c jsonb; lease text; result jsonb; n0 jsonb:=pg_temp.notice('R26CAT00001','000');n1 jsonb:=pg_temp.notice('R26CAT00001','001'); begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,claimed_lease)
 values('fixture:old','공사','history','1999-01-01T00:00:00+09:00','1999-01-31T23:59:00+09:00',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:old',1,2,jsonb_build_array(n0,n1),true))));
 assert (select count(*)=0 from bid_active_catalog_private.groups),'discovery never publishes unverified source rows';
 assert (select revision=1 from bid_active_catalog_private.verification where number='R26CAT00001'),'highest candidate revision retained';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(jsonb_build_array(n0,n1))));
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{}');
 assert jsonb_array_length(result->'groups')=1,'active notice posted decades ago has no search date cutoff';
 assert result#>>'{groups,0,latest,revision}'='001' and jsonb_array_length(result#>'{groups,0,versions}')=2,'latest and every revision preserved';
 assert result#>>'{groups,0,latest,description}'='' and result#>'{groups,0,latest,documents}'='[]'::jsonb,'large details excluded from compact index';
 assert octet_length((result#>'{groups,0,latest}')::text)<1500,'fixture stays within compact core budget';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;
do $$ declare c jsonb;lease text;result jsonb;n2 jsonb:=pg_temp.notice('R26CAT00001','002','취소');failed boolean:=false; begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,claimed_lease)
 values('fixture:cancel','공사','modified',now()-interval '1 hour',now(),lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:cancel',1,1,jsonb_build_array(n2),true))));
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26CAT00001'),'tracked cancellation is reverified';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 begin
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(jsonb_build_array(pg_temp.notice('R26CAT00001','001'),n2))));
 exception when others then failed:=true; end;
 assert failed and (select revision=1 from bid_active_catalog_private.groups where number='R26CAT00001'),'incomplete replacement cannot drop prior history';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(
 jsonb_build_array(pg_temp.notice('R26CAT00001','000'),pg_temp.notice('R26CAT00001','001'),n2))));
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{}');
 assert jsonb_array_length(result->'groups')=0,'cancelled latest does not leave original falsely actionable';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{"includeInactive":true}');
 assert result#>>'{groups,0,latest,revision}'='002' and jsonb_array_length(result#>'{groups,0,versions}')=3,'cancellation history remains available to alert rescan';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;
do $$ declare c jsonb;lease text;failed boolean:=false;items jsonb;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,claimed_lease)
 values('fixture:pages','공사','history','2000-01-01','2000-01-31',lease::uuid);
 items:='[]'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:pages',1,1000,items,false,999)||jsonb_build_object('observed',jsonb_build_array(jsonb_build_object('type','공사','number','R26UNRELATED'))))));
 assert (select page=2 and completed_at is null from bid_active_catalog_private.sources where id='fixture:pages'),'page resumes before final completion';
 assert (select processed_count=999 from bid_active_catalog_private.sources where id='fixture:pages'),'discarded raw rows still advance durable read count';
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26UNRELATED'),'unmatched observed IDs are discarded without a candidate record';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture:pages'),'discarded rows do not create an identity ledger';
 update bid_active_catalog_private.sources set claimed_lease=lease::uuid where id='fixture:pages';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'failedSources',jsonb_build_array(jsonb_build_object('id','fixture:pages','error','temporary timeout'))));
 assert (select page=2 and expected_total=1000 and processed_count=999 from bid_active_catalog_private.sources where id='fixture:pages'),'ordinary timeout never rereads completed pages';
 update bid_active_catalog_private.sources set claimed_lease=lease::uuid where id='fixture:pages';
 begin perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:pages',2,1001,jsonb_build_array(pg_temp.notice('R26PAGE01000','000')),true))));
 exception when others then failed:=true;end;
 assert failed and (select page=2 and expected_total=1000 and completed_at is null from bid_active_catalog_private.sources where id='fixture:pages'),'unstable total never advances checkpoint';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'failedSources',jsonb_build_array(jsonb_build_object('id','fixture:pages','error','total changed','restart',true))));
 assert (select page=1 and expected_total is null from bid_active_catalog_private.sources where id='fixture:pages'),'failed snapshot restarts to avoid stuck page';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture:pages'),'failed snapshot discards only temporary page identity ledger';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;

do $$ declare c jsonb;lease text;result jsonb;n0 jsonb:=pg_temp.notice('R26REORDER','000');begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,claimed_lease)
 values('fixture:reorder','공사','history','2001-01-01','2001-01-31',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:reorder',1,1001,jsonb_build_array(n0),false,999))));
 update bid_active_catalog_private.sources set claimed_lease=lease::uuid where id='fixture:reorder';
 result:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources',jsonb_build_array(
 pg_temp.source('fixture:reorder',2,1001,jsonb_build_array(n0,pg_temp.notice('R26REORDER2','000')),true,2))));
 assert result->>'ok'='true' and result->>'restartRequired'='true','cross-page duplicate is a recoverable source restart';
 assert (select page=1 and expected_total is null and processed_count=0 and completed_at is null and claimed_lease is null from bid_active_catalog_private.sources where id='fixture:reorder'),'same-count reorder resets only this source atomically';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture:reorder'),'restart clears temporary identities so page 1 cannot get stuck';
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26REORDER2'),'unstable page does not publish partial new candidates';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;


do $$ declare original jsonb;enriched jsonb;result jsonb;before_time timestamptz;c jsonb;lease text;begin
 select latest,verified_at into original,before_time from bid_active_catalog_private.groups where number='R26CAT00001';
 enriched:=original||jsonb_build_object('allowedRegions',jsonb_build_array('서울특별시'),'regionComplete',true,
 'licenses',jsonb_build_array('석면해체·제거업'),'licenseComplete',true,'description','SHOULD_NOT_STORE','revision','002');
 result:=public.bid_active_catalog_worker(repeat('a',64),'enrich',jsonb_build_object('notice',enriched));
 assert result->>'ok'='true','verified exact revision accepts condition enrichment';
 assert (select latest->'allowedRegions'='["서울특별시"]'::jsonb and latest->>'licenseComplete'='true' and latest->>'description'='' and revision=2 and verified_at=before_time from bid_active_catalog_private.groups where number='R26CAT00001'),'enrichment changes only allowlisted condition fields';
 enriched:=enriched||'{"sourceUpdatedAt":"2020-01-01T00:00:00Z","allowedRegions":["SHOULD_NOT_STORE"]}'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'enrich',jsonb_build_object('notice',enriched));
 assert (select latest->'allowedRegions'='["서울특별시"]'::jsonb from bid_active_catalog_private.groups where number='R26CAT00001'),'stale condition response cannot overwrite current fields';
 perform public.bid_active_catalog_worker(repeat('a',64),'enrich',jsonb_build_object('notice',enriched||'{"number":"R26MISSING"}'::jsonb));
 assert not exists(select 1 from bid_active_catalog_private.groups where number='R26MISSING'),'enrichment never creates a missing head';
 perform public.bid_active_catalog_worker(repeat('a',64),'enrich',jsonb_build_object('notice',original||'{"revision":"001","allowedRegions":["SHOULD_NOT_STORE"],"regionComplete":true}'::jsonb));
 assert (select versions->1->>'regionComplete' is distinct from 'true' from bid_active_catalog_private.groups where number='R26CAT00001'),'superseded head response cannot update history conditions';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,claimed_lease)
 values('공사','R26CAT00001',2,'2026-10-15T10:00:00+09:00',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(jsonb_build_array(
 pg_temp.notice('R26CAT00001','000'),pg_temp.notice('R26CAT00001','001'),pg_temp.notice('R26CAT00001','002','취소')||jsonb_build_object('sourceOmittedDigest',repeat('c',64))))));
 assert (select latest->'allowedRegions'='["서울특별시"]'::jsonb and latest->>'licenseComplete'='true' from bid_active_catalog_private.groups where number='R26CAT00001'),'identical source recheck preserves completed condition enrichment';
 assert (select latest->>'sourceOmittedDigest'=repeat('c',64) from bid_active_catalog_private.groups where number='R26CAT00001'),'omitted content hash survives compact projection';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;
do $$ declare c jsonb;lease text;result jsonb;first_cursor text;n jsonb;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 for i in 1..3 loop
   n:=bid_active_catalog_private.compact(pg_temp.notice('R26KEY0000'||i,'000'));
   insert into bid_active_catalog_private.groups(type,number,latest,versions,revision,source_updated_at,next_check_at)
   values('공사',n->>'number',n,jsonb_build_array(n),0,(n->>'sourceUpdatedAt')::timestamptz,now()-interval '1 hour');
 end loop;
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert exists(select 1 from jsonb_array_elements(c->'verify') v where v->>'number' like 'R26KEY%'),'known active heads are periodically reverified';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{"limit":1}');
 assert jsonb_array_length(result->'groups')=1 and result->>'nextCursor' is not null,'keyset query has one look-ahead row';
 first_cursor:=result->>'nextCursor';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page',jsonb_build_object('cursor',first_cursor,'limit',1));
 assert result#>>'{groups,0,key}'>first_cursor,'keyset resumes strictly after previous row';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{"changedSince":"2200-01-01T00:00:00Z"}');
 assert jsonb_array_length(result->'groups')=0,'changed-since filters timestamps without a posting cutoff';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;
-- Delta bounds use publication time; neither provider age nor recheck time can lose changes.
do $$ declare result jsonb;begin
 update bid_active_catalog_private.groups set published_at='2026-10-15T00:00:00Z',source_updated_at='1999-01-01T00:00:00Z',verified_at='2027-01-01T00:00:00Z' where number='R26KEY00001';
 update bid_active_catalog_private.groups set published_at='2026-10-15T00:10:00Z',source_updated_at='1999-01-01T00:00:00Z',verified_at='2027-01-01T00:00:00Z' where number='R26KEY00002';
 update bid_active_catalog_private.groups set published_at='2026-10-15T00:20:00Z',source_updated_at='1999-01-01T00:00:00Z',verified_at='2027-01-01T00:00:00Z' where number='R26KEY00003';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page','{"changedSince":"2026-10-15T00:05:00Z","changedThrough":"2026-10-15T00:15:00Z"}');
 assert jsonb_array_length(result->'groups')=1 and result#>>'{groups,0,number}'='R26KEY00002','delta is bounded by publication interval independently of source and recheck age';
end $$;

do $$ declare c jsonb;lease text;result jsonb;watermark timestamptz:=clock_timestamp()-interval '1 second';
 published timestamptz;n0 jsonb:=pg_temp.notice('R26LATE0001','000')||'{"sourceUpdatedAt":"2020-01-01T00:00:00Z"}'::jsonb;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,claimed_lease)
 values('공사','R26LATE0001',0,'2020-01-01T00:00:00Z',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(jsonb_build_array(n0))));
 result:=public.bid_active_catalog_worker(repeat('a',64),'page',jsonb_build_object('changedSince',watermark,'changedThrough',clock_timestamp()));
 assert exists(select 1 from jsonb_array_elements(result->'groups') g where g->>'number'='R26LATE0001'),'delayed verification publishes an old source after the already advanced delta watermark';
 select published_at into published from bid_active_catalog_private.groups where number='R26LATE0001';
 assert (select source_updated_at<watermark and published_at>=watermark from bid_active_catalog_private.groups where number='R26LATE0001'),'publication watermark is distinct from provider staleness timestamp';
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,claimed_lease)
 values('공사','R26LATE0001',0,'2020-01-01T00:00:00Z',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'groups',jsonb_build_array(jsonb_build_array(n0))));
 assert (select published_at=published from bid_active_catalog_private.groups where number='R26LATE0001'),'identical periodic verification does not republish an unchanged head';
 result:=public.bid_active_catalog_worker(repeat('a',64),'page',jsonb_build_object('changedSince',published+interval '1 microsecond','changedThrough',clock_timestamp()));
 assert not exists(select 1 from jsonb_array_elements(result->'groups') g where g->>'number'='R26LATE0001'),'unchanged refresh does not enter a later delta window';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;

-- Same-fingerprint newer revisions create distinct snapshots without key migration.
insert into auth.users(id,email) values('33333333-3333-4333-8333-333333333333','catalog@example.invalid') on conflict do nothing;
insert into public.bid_alert_settings(user_id,settings) values('33333333-3333-4333-8333-333333333333',jsonb_set(bid_alert_private.defaults(),'{enabled}','true')) on conflict do nothing;
update bid_alert_private.runtime set lease_id=null,lease_until=null,last_checked_at=null;
do $$ declare c jsonb;lease text;n0 jsonb:=pg_temp.notice('R26EVENT0001','000');n1 jsonb:=pg_temp.notice('R26EVENT0001','001'); observations jsonb;events jsonb;begin
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 observations:=jsonb_build_array(jsonb_build_object('key','g2b:공사:R26EVENT0001','notice',n0,'fingerprint',repeat('b',64),'version',1),
 jsonb_build_object('key','g2b:공사:R26EVENT0001','notice',n1,'fingerprint',repeat('b',64),'version',2));
 events:=jsonb_build_array(jsonb_build_object('userId','33333333-3333-4333-8333-333333333333','key','g2b:공사:R26EVENT0001','version',1,'kind','new','message','first','changeFields','[]'::jsonb),
 jsonb_build_object('userId','33333333-3333-4333-8333-333333333333','key','g2b:공사:R26EVENT0001','version',2,'kind','changed','message','second','changeFields','["공고 차수"]'::jsonb));
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'observations',observations,'events',events));
 assert (select count(*)=2 from public.bid_alert_inbox where notice_key='g2b:공사:R26EVENT0001'),'both revisions survive observation overwrite';
 assert (select notice->>'revision'='000' from public.bid_alert_inbox where notice_key='g2b:공사:R26EVENT0001' and version=1),'event snapshots use exact accepted revision';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'observations','[]'::jsonb,'events',events));
 assert (select count(*)=2 from public.bid_alert_inbox where notice_key='g2b:공사:R26EVENT0001'),'repeated payload deduplicates';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'finish',true,'checkpoint',jsonb_build_object('cursor',now(),'backfillDay',null,'coverageFrom','1995-10-01','catalogCursor','공사:R26EVENT0001','catalogDeltaFrom','2026-10-15T00:00:00Z','catalogDeltaThrough','2026-10-15T00:10:00Z','catalogDeltaCursor','공사:R26DELTA')));
 assert (select catalog_cursor='공사:R26EVENT0001' and catalog_delta_from='2026-10-15T00:00:00Z' and catalog_delta_through='2026-10-15T00:10:00Z' and catalog_delta_cursor='공사:R26DELTA' from bid_alert_private.runtime),'baseline and fixed delta checkpoints persist independently';
end $$;

do $$ declare c jsonb;lease text;begin
 update bid_alert_private.runtime set lease_id=null,lease_until=null,last_checked_at=clock_timestamp(),last_error=null,
 catalog_cursor='공사:R26BASELINE',catalog_delta_through=null,catalog_delta_cursor=null;
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert c->>'collectionDue'='true' and lease is not null,'initial comparison immediately continues after an earlier successful alert tick';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'checkpoint',jsonb_build_object('catalogCursor','__complete__','catalogDeltaThrough',null,'catalogDeltaCursor',null)));
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 assert c->>'collectionDue'='false','completed baseline returns to normal ten-minute collection cadence';
 if c->>'leaseId' is not null then perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','finish',true));end if;
 update bid_alert_private.runtime set catalog_delta_through=clock_timestamp()::text;
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert c->>'collectionDue'='true' and lease is not null,'unfinished fixed delta resumes without waiting another ten minutes';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'checkpoint',jsonb_build_object('catalogDeltaThrough',null,'catalogDeltaCursor',null)));
end $$;
do $$ declare c jsonb;lease text;settings jsonb;history_count bigint;begin
 select count(*) into history_count from bid_active_catalog_private.sources where kind='history';
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 settings:=jsonb_set(jsonb_set(bid_alert_private.defaults(),'{enabled}','true'),'{filter,keywords}','["새로운 조건"]');
 perform public.bid_alert_user('save',jsonb_build_object('settings',settings));
 assert (select catalog_cursor is null from bid_alert_private.runtime),'changed user conditions restart catalog baseline comparison';
 assert (select count(*)=history_count from bid_active_catalog_private.sources where kind='history'),'personal filter changes never reset global historical progress';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,completed_at)
 select 'fixture:finished:'||i,'공사','registered',now()-interval '20 minutes',now()-interval '10 minutes',now() from generate_series(1,100) i;
 for i in 1..3 loop
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert not exists(select 1 from bid_active_catalog_private.sources where kind in ('registered','modified') and completed_at is not null),'finished live transport metadata is discarded after durable cursor checkpoint';
 assert (select count(*)<=4 from bid_active_catalog_private.sources where scope_version=bid_active_catalog_private.scope_version() and kind in ('registered','modified')),'current live job metadata stays bounded by four independent streams';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 end loop;
 assert (select count(*)>history_count from bid_active_catalog_private.sources where kind='history'),'new eligible conditions enqueue a complete new history scope without deleting old coverage';
end $$;
do $$ declare c jsonb;lease text;old_scope text;new_scope text;old_completed bigint;failed boolean:=false;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';old_scope:=c->>'scopeVersion';
 select count(*) into old_completed from bid_active_catalog_private.sources where scope_version=old_scope and completed_at is not null;
 update public.bid_alert_settings set settings=jsonb_set(settings,'{filter,keywords}','["다음 조건"]') where user_id='33333333-3333-4333-8333-333333333333';
 begin
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',old_scope,'sources','[]'::jsonb));
 exception when insufficient_privilege then failed:=true;end;
 assert failed,'changed private rule snapshot rejects stale worker atomically';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');new_scope:=c->>'scopeVersion';lease:=c->>'leaseId';
 assert new_scope<>old_scope and lease is not null,'new scope supersedes outstanding old-scope lease';
 assert (select count(*)=old_completed from bid_active_catalog_private.sources where scope_version=old_scope and completed_at is not null),'new scope retains old completion log';
 assert exists(select 1 from bid_active_catalog_private.sources where scope_version=new_scope and kind='history' and completed_at is null),'new conditions scan discarded historical rows again under a new recorded scope';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 update public.bid_alert_settings set settings=jsonb_set(jsonb_set(settings,'{updatedAt}',to_jsonb(clock_timestamp())),'{pushEnabled}','true') where user_id='33333333-3333-4333-8333-333333333333';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert c->>'scopeVersion'=new_scope,'delivery toggles and save timestamps do not restart source discovery';
 insert into bid_active_catalog_private.verification(type,number,claimed_lease) values('공사','R26REJECTED',lease::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',new_scope,'rejectedGroups',jsonb_build_array(jsonb_build_object('type','공사','number','R26REJECTED'))));
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26REJECTED'),'fully checked nonmatching candidates leave no stored public notice';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease,'error','provider quota','retryAfterSeconds',600));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is null and (select retry_after_at>clock_timestamp()+interval '9 minutes' from bid_active_catalog_private.runtime),'actual provider retry-after suspends further provider claims';
 update bid_active_catalog_private.runtime set retry_after_at=null;
end $$;

do $$ declare c jsonb;lease text;before_count bigint;groups_count bigint;result jsonb;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 select count(*) into before_count from bid_active_catalog_private.sources where completed_at is not null;
 select count(*) into groups_count from bid_active_catalog_private.groups;
 execute $replace$create or replace function bid_active_catalog_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as 'select 16777216::bigint'$replace$;
 result:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',bid_active_catalog_private.scope_version(),'sources','[]'::jsonb));
 assert result->>'storageFull'='true','capacity is explicit';
 assert (select count(*)=before_count from bid_active_catalog_private.sources where completed_at is not null),'capacity never advances source cursors';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');assert c->>'leaseId' is null,'capacity prevents new lease';
 assert (select count(*)=groups_count from bid_active_catalog_private.groups),'capacity preserves existing history';
end $$;
rollback;
