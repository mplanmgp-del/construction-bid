# MY입찰관리

The top-level 개찰결과 menu is replaced by MY입찰관리. Public opening results remain available in each notice's details.

## Current architecture: direct official queries

MY입찰관리 does **not** precollect company history or read saved history from the database. Opening the menu alone does not start history requests. The user searches for a company and selects a candidate, submits an exact business number, or clicks 내 업체 조회. Only then does the app load that company's official registration profile and start participation, final-award and contract queries.

- Blank dates mean the official procurement-company registration date through today in Asia/Seoul. There is no overall history-day limit. If the registration date is missing, the user must supply a start date; the app does not invent one.
- Date changes begin a new direct traversal. Table pagination and outcome filters operate on rows already received, rather than querying the database or rereading the registration profile.
- MY routes use a fresh provider client per request and return `Cache-Control: no-store`. The dashboard and source panels retain received rows/cursors only in the mounted browser view. Reloading, leaving the view or selecting another company starts a new lookup; stop/resume is not durable background work or a server archive.
- Member profiles can still store an optional business number. Existing owner-only workspace access and older profiles remain compatible. Public lookup does not read another member's profile, bookmarks or notes.
- `/api/company-history` is retired and returns **410 `LIVE_HISTORY_REQUIRED`**. It must not fall back to the preserved Supabase archive.

The ordinary notice-search cache and per-notice result functionality are separate from these MY direct-history routes.

Vercel rewrites the four `/api/company-*` history routes to the single `api/company-data.ts` function. The fixed action map preserves public URLs and query parameters while keeping the deployment within the Hobby function-count limit.

## Company candidates and exact selection

`/api/companies` uses official `UsrInfoService02` data, not the former archive directory or a search-engine result page.

- Name-keyword lookup requests basic company candidates by registration year and page. The UI works backwards from the current year, shows candidates as they arrive, and supports 업체 검색 중지 / 업체 더 찾기. Keyword search does not start the histories of every matching company.
- Selecting a candidate submits its exact ten-digit business number. Direct business-number search performs the same exact lookup and checks returned identities before selecting a company.
- Registration details, registered industries and supplied products are loaded for the selected company. Incomplete optional details produce an explicit warning; a failed registration request is not replaced with an archived name.
- Business numbers are normalized for lookup, while company-name similarity alone never establishes participation, an award or a contract.

## Source routes and date boundaries

| App route | Official source / operation | Date and continuation | Company matching |
| --- | --- | --- | --- |
| `/api/company-participation` | `PubDataOpnStdService/getDataSetOpnStdScsbidInfo` | One opening day, one source page per app request; 공사/용역, newest day first | The source has no usable business-number filter. Read the national page and return only the exact company's rows. |
| `/api/company-awards` | `ScsbidInfoService/getScsbidListSttusCnstwkPPSSrch` / `getScsbidListSttusServcPPSSrch` | Calendar-month slices of at most 31 inclusive opening days; server checks all pages within a bounded request | Official `bizno` filter, followed by another exact business-number check. |
| `/api/company-contracts` | `CntrctInfoService/getCntrctInfoListCnstwkPPSSrch` / `getCntrctInfoListServcPPSSrch` | Calendar-month slices of at most 31 inclusive **contract-conclusion days**; one source page per app request | No official business-number filter. Read the national page and match the published `corpList` business number exactly. |

Participation and contract pages request **999** source rows. National source `totalCount` and `sourceCount` describe traversal work, not this company's result count. A page with zero company matches does not finish a range while `hasMore` is true. The client continues through every page and date/type slice unless stopped or blocked.

The standard participation service accepts only one opening day at a time. This per-request source restriction is handled by daily continuation; it is not an app history-range cap. Contract filtering uses the contract conclusion date, which can differ from the date the contract was registered in the API.

Sources: [나라장터 낙찰정보서비스](https://www.data.go.kr/data/15129397/openapi.do), [나라장터 계약정보서비스](https://www.data.go.kr/data/15129427/openapi.do). Search-engine results cannot establish complete, authoritative participation or contract history.

## Progress, limits and stop/resume

The company panels and candidate lookup share `fetchCompanyApi` in `src/company/company-request.ts`, limiting concurrent browser-to-app company requests to **two**. This is a per-browser concurrency gate, not a global provider-quota guarantee; individual app requests can make multiple official calls. The server's existing burst guard and provider limits still apply.

The user can stop a source panel and resume remaining work in the same view. Previously received results remain visible during normal stop/error handling. Quota errors stop that source's remaining requests instead of treating the error as an empty result. Missing, malformed or inconsistent responses stay incomplete. Changed totals or repeated pages require the affected interval to be checked again; contract retries retain the previous visible rows until a complete replacement traversal succeeds.

Daily participation traversal and national contract traversal can require many calls, particularly for a company registered years ago. **Unlimited selectable dates do not mean unlimited traffic, instant results or guaranteed full-period completion.** Provider daily quotas, unavailable historical records, inconsistent pages, network failures and bounded server execution can interrupt a lookup. A partial response never means the company's lifetime history has been completely checked. An operational API quota increase may improve throughput, but cannot change these source guarantees by itself.

The UI reports received results and completed/remaining slices separately. Before all slices finish, zero means “currently confirmed zero / still checking,” not “no history.” Results are displayed 30 at a time, with page-number groups of ten. Unknown public values remain `-`.

## Participation, awards and contracts are separate

- Participation contains submitted bids, including unsuccessful and unknown-outcome records. The standard service does not publish authoritative lot/rebid identifiers for these rows. Rank 1 alone is not promoted to a final award.
- Final-award queries return official successful-award records with bid classification and rebid round. They do not return unsuccessful bidders or direct contracts made without a bidding notice. The dashboard's participation statistics are calculated from the participation rows received so far; they are not silently combined with separate award totals.
- Contract history includes negotiated/direct contracts (`수의계약`) even when there is no notice number. It presents contract title, institution, conclusion date, method, published current contract total and the company's published share.
- A joint contract's total amount is not the selected company's individual revenue. Unknown/ambiguous shares remain `-`. Full confirmed contract numbers retain amendment suffixes; original and amended records are not silently merged or added into an asserted lifetime award total.
- Company-specific endpoints filter exact business identities on the server before returning rows. Received data and any visible totals remain scoped to the selected company.

## Verification and observed limits

Tests cover exact business identity, old profiles, multi-year/date-boundary traversal, page counts, repeated/changed pages, continuation after a zero-match page, unknown money, safe official links, amendment identities, quota/error propagation and preserving contract rows during restart. Client tests also cover the shared two-request gate and aborting queued requests. Run the relevant `tests/company-*.test.ts` suites and `npm run typecheck` after modifying these paths; successful tests alone are not live-provider acceptance.

Live official-source verification for **2026-10-01 through 2026-10-14** read all **19 construction-contract pages** in that interval and found the following exact match:

| Field | Verified official value |
| --- | --- |
| Company | 주식회사 함께하는개발 (`8488802470`) |
| Contract | 송파문화예술회관 여가교실 철거공사 |
| Institution | 서울특별시 송파구 |
| Contract conclusion date | 2026-10-07 |
| Method / published amount | 수의계약 / 40,640,000원 |
| Confirmed / unified contract number | `R26TA0229571200` / `R26TE18812747` |
| Notice number | Not published |

This proves ordinary monthly pagination can find the direct contract without a hard-coded company or title filter. It is **not** verification of the company's entire lifetime, all service contracts, or all unsuccessful participation. An award-only lookup would not find this contract because it has no competitive-award notice in the verified response.

## Historical archive: preserved, disabled

The previous Supabase implementation (`supabase/company-history.sql`, `company-collector.sql`, `company-notice-archive.sql` and their rollback tests) remains preserved for historical reference and data retention. Its settings were verified as **`enabled=false`** during this transition. The daily and precise-opening workers share this disabled setting; the current MY flow neither enqueues archive work nor queries it. Do not reactivate collectors as part of this direct-query workflow.

Earlier collection and recovery verified public participation records, including 17 non-winning records for 함께하는개발. Those saved snapshots are historical evidence, not the current MY data source or proof of complete coverage. Existing public archive data and member-owned workspace data are retained; this change does not delete them. A future return to precollection would require a separate architecture decision, quota/capacity review and end-to-end verification.
