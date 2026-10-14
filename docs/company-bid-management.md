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

The private queue persists day/type/page and cross-page fingerprints. It checks page completeness, restarts on changed provider counts/order, preserves failed positions, and marks coverage only after a complete stable snapshot. Withdrawn/replaced rows are soft archived. Parsed HTTP response bodies are removed from pg_net after consumption. The current day stays incomplete because new events can arrive. Company/notices/participations are stored separately; large repeated raw provider JSON is not retained.

After production proxy verification, activate from an authorized SQL session:

```sql
update bid_archive_private.settings set enabled=true where singleton;
select cron.schedule('company-history-collector', '* * * * *', 'select bid_archive_private.tick();');
select bid_archive_private.tick();
```

The scheduler launches at most two provider pages per minute, advances historical days backwards, and revisits recent/older days for changes. It initially enqueues both today and yesterday to avoid current-day changes blocking backfill. A 600-call/day collection budget reserves upstream quota for interactive searches. This is a collector budget, not a user date restriction. The budget and a 400 MiB database guard are private operational settings. The free database cannot store unlimited national history; provision appropriate capacity before increasing these settings. Pausing collection never deletes archived history or limits its searchable dates. `bid_archive_health` exposes a non-sensitive reason when collection waits for quota/storage.

## Source limits

The currently approved standard dataset provides construction/service public opening participation. It does not provide an authoritative lot/rebid identifier or contracts made without bidding. Record fingerprints use notice, company, opening/submission times and amount; ambiguous identical source rows cause a visible collection retry rather than a false complete flag.

Apply for [나라장터 낙찰정보서비스](https://www.data.go.kr/data/15129397/openapi.do) to enrich classification/rebid identifiers; the current local key returned 403 for that service. This is not silently treated as an empty result. [Official company participation report](https://www.data.go.kr/data/15050832/fileData.do) can support a separately verified bulk backfill; its current report UI limits individual exports to 12 months, not the app's search range. Search-engine results cannot substitute for complete authoritative bid history.

## Verification

Unit coverage includes unlimited multi-decade query spans, real date validation, exact company identity, profile backward compatibility, provider errors, complete page counts, repeated pages, immutable record identity, and missing amounts. SQL checks include KST boundaries, multi-year aggregation, unknown outcomes, other-company isolation, co-bidders, pagination, soft archives and SELECT-only public permissions. Production must additionally prove the actual collector writes source data and the corresponding company displays it.
