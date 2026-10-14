# MY입찰관리

The top-level 개찰결과 menu is replaced by MY입찰관리. Per-notice public results remain available in notice details.

## Queries and ownership

- Public company registration lookup uses `UsrInfoService02`, matching an exact ten-digit business number. Name search uses the archive directory and explicitly identifies that scope. Missing/failed registration can fall back to an archived company name.
- Member profiles may store an optional business number. Existing owner-only workspace RLS and old profiles remain compatible. Public company lookup never reads another member's profile or notes.
- `/api/company-history` reads the shared Supabase index. Blank dates mean all stored history; there is no maximum query duration. Results paginate 30 records, with all matching rows used for statistics. Opening-day boundaries are inclusive in Asia/Seoul.
- The selected public company profile is loaded once; changing dates/pages does not call G2B again.
- Amounts not published by the provider remain null (`-`). Rank 1 alone is not a final award. Partial collections never claim complete lifetime history.

## Collection

Apply `supabase/company-history.sql` followed by `supabase/company-collector.sql` in the construction-bid project. These scripts are additive to the member schema. Public tables expose SELECT only, and the collector schema, tables and functions are inaccessible to anonymous/authenticated API roles. Run both files in `supabase/tests/` to validate inside rollback-only transactions.

The SQL collector uses pg_net to read the fixed public application endpoint `/api/archive-page`, so neither G2B keys nor Supabase privileged keys are copied into SQL or frontend code. The proxy retrieves a single source day in pages of **999**, which was verified against the real provider. A request for 1000 silently returns only ten rows and must not be used.

The private queue persists day/type/page and cross-page fingerprints. It checks page completeness, restarts on changed provider counts/order, and preserves failed positions. Two complete traversals must produce the same full identity set before coverage is marked complete or missing rows are soft archived. A malformed historical day remains retryable while its predecessor can continue after repeated failures. Parsed HTTP response bodies are removed from pg_net after consumption. The current day stays incomplete because new events can arrive. Company/notices/participations are stored separately; large repeated raw provider JSON is not retained.

After production proxy verification, activate from an authorized SQL session:

```sql
update bid_archive_private.settings set enabled=true where singleton;
select cron.schedule('company-history-collector', '* * * * *', 'select bid_archive_private.tick();');
select bid_archive_private.tick();
```

The scheduler launches at most two provider pages per minute, advances historical days backwards, and revisits recent/older days for changes. It initially enqueues both today and yesterday to avoid current-day changes blocking backfill. A 600-call/day collection budget reserves upstream quota for interactive searches. This is a collector budget, not a user date restriction. The budget and a 400 MiB database guard are private operational settings. The free database cannot store unlimited national history; provision appropriate capacity before increasing these settings. Pausing collection never deletes archived history or limits its searchable dates. `bid_archive_health` exposes a non-sensitive reason when collection waits for quota/storage.

## Source limits

The currently approved standard dataset provides construction/service public opening participation. It does not provide an authoritative lot/rebid identifier or contracts made without bidding. Record fingerprints use notice, company, opening/submission times and amount; ambiguous identical source rows cause a visible collection retry rather than a false complete flag.

[나라장터 낙찰정보서비스](https://www.data.go.kr/data/15129397/openapi.do) was approved on 2026-10-14 and verified with the existing server key (HTTP 200 / resultCode 00). Its development account currently allows 1,000 daily requests per operation. Company history continues to use the shared bulk archive; precise notice results use the dedicated service only when opened. The dedicated response separates bid classifications and rebid rounds. List summaries query opening/winner summaries without loading every participant. Complete public responses have short CDN caching, and explicit refreshes bypass it.

[Official company participation report](https://www.data.go.kr/data/15050832/fileData.do) can support a separately verified bulk backfill; its current report UI limits individual exports to 12 months, not the app's search range. Search-engine results cannot substitute for complete authoritative bid history.

## Verification

Unit coverage includes unlimited multi-decade query spans, real date validation, exact company identity, profile backward compatibility, provider errors, complete page counts, repeated pages, immutable record identity, and missing amounts. SQL checks include KST boundaries, multi-year aggregation, unknown outcomes, other-company isolation, co-bidders, pagination, soft archives and SELECT-only public permissions. Production must additionally prove the actual collector writes source data and the corresponding company displays it.

On 2026-10-14 the production collector was enabled after both SQL rollback suites passed. A production snapshot contained 4,877 participation rows, 4,493 companies and 144 notices (17 MB total database). `/api/company-history?businessNumber=3028128785` and the deployed UI returned the real 황간고 본관 석면철거공사 award (55,968,000 KRW). These are initial collection counts, not a completed national or lifetime backfill.

## Precise opening archive and direct awards

Apply `supabase/company-notice-archive.sql` **after** both older scripts, including on reapply. Its rollback test is `supabase/tests/company_notice_archive.sql`. Successful opening detail reads enqueue only a validated public notice identity. The private worker fetches official results itself; public clients cannot inject bidder payloads. After deploying the bounded archive endpoint, schedule `bid-company-opening-archive` with `select bid_archive_private.tick_openings()` once a minute.

The worker shares the existing daily budget and storage ceiling, reserves at most 15 provider calls per job, and permits one in-flight notice. Archive requests allow three pages per operation. Larger notices remain available through interactive detail pagination; background work defers them for a day instead of repeatedly consuming the same first pages. This is an explicit background archive limitation, not a complete-history guarantee.

Precise rows identify the notice, revision, bid classification, rebid round, company and bidding time. A read view suppresses duplicate standard rows only while the precise snapshot covers every advertised participant group. Older rebid groups sometimes advertise participants but omit their list; available rows are stored, and existing standard records are preserved. Missing precise rows are soft archived only after two newer identical complete identity sets. Original standard rows are not deleted.

The optional **확정 낙찰 직접 조회** tab uses company-filtered `getScsbidListSttusCnstwkPPSSrch` / `ServcPPSSrch` (`bizno`, opening-date query). It retrieves calendar-month slices with all provider pages, starting at registration date unless the user supplies dates. There is no overall date-span cap. These operations provide final awards only, not unsuccessful participation or direct contracts. Opening-summary operations do not honor `bizno` and must never be used as a company participation filter.

Two client workers expose progress and preserve results on stop/error. Quota responses stop remaining work. Complete public award slices share a cache for three minutes near the present and one day for older dates, measured from the original response timestamp. Incomplete/warning responses never renew cache life or count as completed periods.

Recovery on 2026-10-14 identified 17 public notice references for 함께하는개발 and independently retrieved their official G2B opening responses: 3,193 public participant rows, including 17 non-winning records for business number 8488802470. Sixteen notices had complete groups; one omitted an older rebid's 220-person list while providing the later 117-person group. The separate 40,640,000 KRW direct contract shown by the reference service is not a competitive award and is not included in these participation statistics.
