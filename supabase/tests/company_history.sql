-- Run in a local/test PostgreSQL or Supabase database after company-history.sql.
-- No pgTAP extension is needed. Assertion failures abort; all fixtures roll back.
begin;

insert into public.bid_archive_companies(business_number, name) values
  ('9999900001', '공개 이력 검증 업체 A'), ('9999900002', '공개 이력 검증 업체 B'),
  ('9999900003', '공개 이력 검증 업체 C');
insert into public.bid_archive_notices(id, number, revision, type, title, agency, opening_at, method, participant_count) values
  ('__history_test_old', 'TEST-OLD', '000', '공사', '2020년 공사', '기관 A', '2020-01-01 09:00:00+09', '일반경쟁', 10),
  ('__history_test_start', 'TEST-START', '001', '용역', '시작 경계', '기관 B', '2026-01-01 00:00:00+09', '제한경쟁', null),
  ('__history_test_end', 'TEST-END', '000', '공사', '종료 경계', '기관 B', '2026-01-02 23:59:59.999+09', '', 4),
  ('__history_test_next', 'TEST-NEXT', '000', '공사', '다음 날', '기관 A', '2026-01-03 00:00:00+09', '일반경쟁', 2);
insert into public.bid_archive_entries(id, notice_id, business_number, bidding_at, bid_amount, bid_rate, rank, awarded, winning_amount) values
  ('__history_test_a_old', '__history_test_old', '9999900001', '2020-01-01 08:00:00+09', 100, 80, '1', true, 100),
  ('__history_test_a_start', '__history_test_start', '9999900001', '2025-12-31 12:00:00+09', 200, 90, '1', null, null),
  ('__history_test_a_rebid', '__history_test_start', '9999900001', '2025-12-31 13:00:00+09', 201, 91, '1', null, null),
  ('__history_test_a_end', '__history_test_end', '9999900001', null, 300, null, '2', false, 999),
  ('__history_test_a_next', '__history_test_next', '9999900001', null, 400, 100, '1', true, 400),
  ('__history_test_b_start', '__history_test_start', '9999900002', null, null, null, '1', true, null),
  ('__history_test_b_rebid', '__history_test_start', '9999900002', '2025-12-31 14:00:00+09', null, null, '1', true, null),
  ('__history_test_c_old', '__history_test_old', '9999900003', null, 100, null, '2', false, null);
insert into public.bid_archive_entries(id, notice_id, business_number, bid_amount, rank, awarded, winning_amount, archived) values
  ('__history_test_a_archived', '__history_test_old', '9999900001', 9999, '1', true, 9999, true),
  ('__history_test_b_archived', '__history_test_old', '9999900002', 9999, '1', true, 9999, true),
  ('__history_test_c_archived', '__history_test_start', '9999900003', 9999, '1', true, 9999, true);

-- Repeating the same collector fingerprint must update, not add a participation.
insert into public.bid_archive_entries(id, notice_id, business_number, bid_amount, awarded, winning_amount)
values ('__history_test_a_old', '__history_test_old', '9999900001', 100, true, 100)
on conflict(id) do update set updated_at = excluded.updated_at;

do $$
declare
  history jsonb;
  filtered jsonb;
  page_two jsonb;
begin
  history := public.bid_company_history('999-99-00001');
  assert (history ->> 'totalCount')::integer = 5, 'all years, unique records, and rebids must be retained';
  assert history #>> '{company,businessNumber}' = '9999900001', 'business number normalization';
  assert history #>> '{items,0,number}' = 'TEST-NEXT', 'newest opening first';
  assert history #>> '{items,1,openingAt}' = '2026-01-02 23:59:59', 'KST display independent of session timezone';
  assert history #>> '{summary,participationCount}' = '5', 'only the selected company is counted';
  assert history #>> '{summary,winCount}' = '2', 'rank 1 pending rows must not become wins';
  assert history #>> '{summary,pendingCount}' = '2', 'unknown outcomes remain pending';
  assert history #>> '{summary,winningAmount}' = '500', 'false and unknown outcomes cannot contribute winning amounts';
  assert history #>> '{summary,bidAmount}' = '1201', 'participation bid total';
  assert (history #>> '{summary,averageBidRate}')::numeric = 90.25, 'missing rates ignored, not zero-filled';
  assert jsonb_array_length(history -> 'monthly') = 2, 'multi-year monthly aggregation';
  assert history #>> '{monthly,0,month}' = '2020-01', 'historical month retained without date cap';
  assert history #>> '{agencies,0,name}' = '기관 A', 'agencies ranked by confirmed wins';
  assert history #>> '{coverage,status}' = 'collecting', 'unbounded history must not claim full coverage';
  assert history #>> '{businessTypes,0,name}' = '공사', 'business types ordered by participation count';
  assert history #>> '{businessTypes,0,participationCount}' = '3', 'archived entries excluded from business type counts';
  assert history #>> '{businessTypes,0,winningAmount}' = '500', 'business type amount only confirmed wins';
  assert jsonb_array_length(history -> 'methods') = 3, 'unknown contract method retained as a separate group';
  assert exists (select 1 from jsonb_array_elements(history -> 'methods') m where m ->> 'name' = '-' and m ->> 'participationCount' = '1'), 'empty method displayed as dash';
  assert jsonb_array_length(history -> 'competitors') = 2, 'own company excluded from competitors';
  assert history #>> '{competitors,0,businessNumber}' = '9999900002', 'competitor tie ordered by business number';
  assert history #>> '{competitors,0,sharedCount}' = '1', 'rebids on both sides must not multiply shared notices';
  assert history #>> '{competitors,0,winCount}' = '1', 'competitor wins counted once per shared notice';
  assert history #>> '{competitors,1,sharedCount}' = '1', 'archived opponent entries must not create extra shared notices';
  assert history #>> '{competitors,1,winCount}' = '0', 'archived opponent wins excluded';

  filtered := public.bid_company_history('9999900001', '2020-01-01', '2026-01-03', 1, 1, 'won');
  assert (filtered ->> 'totalCount')::integer = 2, 'outcome filter counts all matching pages';
  assert jsonb_array_length(filtered -> 'items') = 1, 'page size honored';
  assert filtered -> 'summary' = history -> 'summary', 'summary must not shrink to outcome filter or current page';
  assert filtered -> 'monthly' = history -> 'monthly', 'monthly must not shrink to outcome filter or current page';
  assert filtered -> 'competitors' = history -> 'competitors', 'competitors must not shrink to outcome filter or current page';
  page_two := public.bid_company_history('9999900001', '2020-01-01', '2026-01-03', 2, 1, 'won');
  assert page_two #>> '{items,0,id}' = '__history_test_a_old', 'page two returns the older winning record';
  assert page_two #>> '{items,0,id}' <> filtered #>> '{items,0,id}', 'pages must not repeat rows';

  filtered := public.bid_company_history('9999900001', '2026-01-01', '2026-01-02');
  assert (filtered ->> 'totalCount')::integer = 3, 'KST inclusive start/end and next-day exclusion';
  assert jsonb_array_length(filtered -> 'competitors') = 1, 'competitors follow selected company date scope';
  assert filtered #>> '{competitors,0,businessNumber}' = '9999900002', 'an archived co-bid alone is not a competitor';
  assert (public.bid_company_history('9999900001', '2026-01-01', '2026-01-02', 1, 30, 'pending') ->> 'totalCount')::integer = 2, 'pending filter';
  assert (public.bid_company_history('9999900001', null, null, 1, 30, 'lost') ->> 'totalCount')::integer = 1, 'confirmed loss filter';
  assert (public.bid_company_history('9999900002') ->> 'totalCount')::integer = 2, 'other companies are independently queryable with rebids preserved';
  filtered := public.bid_company_history('9999900002');
  assert filtered #> '{summary,winningAmount}' = 'null'::jsonb, 'unpublished confirmed winning amounts stay null';
  assert filtered #> '{summary,bidAmount}' = 'null'::jsonb, 'unpublished bid amounts stay null';
  assert filtered #> '{monthly,0,winningAmount}' = 'null'::jsonb, 'monthly unknown amount stays null';
  assert filtered #> '{agencies,0,winningAmount}' = 'null'::jsonb, 'agency unknown amount stays null';
  assert filtered #> '{businessTypes,0,winningAmount}' = 'null'::jsonb, 'business type unknown amount stays null';
  assert filtered #> '{methods,0,winningAmount}' = 'null'::jsonb, 'contract method unknown amount stays null';
  filtered := public.bid_company_history('9999900001', '2026-01-04', '2026-01-05');
  assert filtered #>> '{coverage,status}' = 'collecting', 'missing history is not confirmed empty history';
  assert position('수집된 이력이 아직 없습니다' in filtered #>> '{coverage,message}') > 0, 'empty incomplete coverage must explain absence';
end;
$$;

insert into public.bid_archive_companies(business_number, name)
select (9999910000::bigint + n)::text, '경쟁업체 상한 검증 ' || n::text from generate_series(1, 22) n;
insert into public.bid_archive_entries(id, notice_id, business_number, awarded)
select '__history_test_limit_' || n::text, '__history_test_start', (9999910000::bigint + n)::text, false
from generate_series(1, 22) n;
do $$
declare history jsonb;
begin
  history := public.bid_company_history('9999900001');
  assert jsonb_array_length(history -> 'competitors') = 20, 'competitor response limited to top twenty';
  assert history #>> '{competitors,0,businessNumber}' = '9999900002', 'competitor limit keeps deterministic business-number ordering';
  assert (history ->> 'totalCount')::integer = 5, 'other company participation cannot alter selected company totals';
end;
$$;

-- A min/max span alone never proves coverage. Both types and every day count.
insert into public.bid_archive_coverage(type, day, complete) values
  ('공사', '2026-01-01', true), ('용역', '2026-01-01', true),
  ('공사', '2026-01-02', true), ('용역', '2026-01-02', false);
do $$
begin
  assert public.bid_company_history('9999900001', '2026-01-01', '2026-01-02') #>> '{coverage,status}' = 'collecting', 'one missing type/day keeps coverage incomplete';
end;
$$;
update public.bid_archive_coverage set complete = true where type = '용역' and day = '2026-01-02';
do $$
begin
  assert public.bid_company_history('9999900001', '2026-01-01', '2026-01-02') #>> '{coverage,status}' = 'ready', 'all requested type/days complete';
  assert public.bid_company_history('9999900001', '2025-12-31', '2026-01-02') #>> '{coverage,status}' = 'collecting', 'missing interior or boundary days not inferred from min/max';
  assert public.bid_company_history('9999900001') #>> '{coverage,status}' = 'collecting', 'no date bounds cannot certify all historical days';
  begin
    perform public.bid_company_history('bad');
    raise exception 'invalid number was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.bid_company_history('9999900001', '2026-01-02', '2026-01-01');
    raise exception 'reversed dates were accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.bid_company_history('9999900001', null, null, 0);
    raise exception 'zero page was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.bid_company_history('9999900001', null, null, 1, 101);
    raise exception 'oversized page was accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.bid_company_history('9999900001', null, null, 1, 30, 'invalid');
    raise exception 'invalid outcome was accepted';
  exception when invalid_parameter_value then null; end;
end;
$$;

set local role anon;
do $$
begin
  assert (public.bid_company_history('9999900002') ->> 'totalCount')::integer = 2, 'anonymous visitors can read public company histories';
  assert not exists (select 1 from public.bid_archive_entries where id = '__history_test_a_archived'), 'public table reads hide superseded records';
  assert not has_table_privilege(current_user, 'public.bid_archive_entries', 'INSERT'), 'anon cannot insert public records';
  assert not has_table_privilege(current_user, 'public.bid_archive_entries', 'UPDATE'), 'anon cannot change outcomes';
  assert not has_table_privilege(current_user, 'public.bid_archive_coverage', 'DELETE'), 'anon cannot change coverage';
  assert not (select prosecdef from pg_proc where oid = 'public.bid_company_history(text,date,date,integer,integer,text)'::regprocedure), 'history uses invoker rights';
end;
$$;
reset role;
set local role authenticated;
do $$
begin
  assert (public.bid_company_history('9999900001') ->> 'totalCount')::integer = 5, 'authenticated visitors can read all public histories';
  assert not has_table_privilege(current_user, 'public.bid_archive_companies', 'UPDATE'), 'members cannot change public company names';
  assert not has_table_privilege(current_user, 'public.bid_archive_notices', 'INSERT'), 'members cannot insert public notices';
  assert not has_table_privilege(current_user, 'public.bid_archive_entries', 'DELETE'), 'members cannot delete public entries';
end;
$$;
reset role;

select 'company history SQL assertions passed' as result;
rollback;
