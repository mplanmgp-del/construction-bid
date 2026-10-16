-- Disposable database only: record retained rows before the additive migration.
insert into bid_active_catalog_private.groups(type,number,revision,latest,versions,source_updated_at,verified_at,published_at,next_check_at)
select '공사',number,0,n,jsonb_build_array(n),now()-interval '2 days',now()-interval '31 minutes',now()-interval '1 day',due
from(values
 ('R26TENRETAIN',false,now()+interval '1 hour'),
 ('R26TENEARLY',false,now()-interval '1 hour'),
 ('R26TENCLOSED',true,now()+interval '1 hour'))t(number,closed,due)
cross join lateral(select jsonb_build_object('id','g2b:공사:'||number||':000','type','공사','number',number,'revision','000',
 'title','철거 공사','agency','공공기관','status',case when closed then '취소' else '접수중' end,'source','live',
 'postedAt',now()-interval '2 days','sourceUpdatedAt',now()-interval '2 days','biddingStartAt',now()-interval '1 day',
 'deadline',now()+interval '30 days','openingAt',now()+interval '31 days',
 'allowedRegions','[]'::jsonb,'licenses','[]'::jsonb,'regionComplete',true,'licenseComplete',true)n)s;
create temporary table tracked_recheck_before as select * from bid_active_catalog_private.groups where number like 'R26TEN%';
do $$declare definition text;begin
 select pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure) into definition;
 execute replace(replace(definition,E'\r\n',E'\n'),E'\n',E'\r\n');
end $$;
