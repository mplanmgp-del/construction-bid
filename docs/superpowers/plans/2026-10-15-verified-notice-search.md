# Verified notice search implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the tasks below.

**Goal:** Collect and verify public notices in the background, then search a wide deadline range directly from the verified shared index.

**Architecture:** Preserve the durable 999-row source-page collector and independent registration/change cursors. Queue every public ongoing candidate for full revision and condition verification, publish only verified current heads, and serve filtered 50-row pages with a generation-bound cursor. A concurrent index change expires the cursor explicitly rather than silently skipping rows; this avoids storing duplicate snapshots within the existing storage cap.

**Tech Stack:** TypeScript, React, Vercel Functions, Supabase PostgreSQL/pg_cron.

**Spec:** `docs/notice-search-research.md`, approved by the user on 2026-10-15, with explicit approval required before any storage increase.

## Global constraints

- Keep the existing 16MiB catalog and 32MiB overall alert caps. Stop collection safely at capacity and request approval before increasing either limit.
- Preserve account records, bookmarks, inbox deletion/recovery, alarm rules, delivery deduplication and the rolling seven-day alarm window.
- Latest cancellation, completed opening and newer same-revision updates override old active records.
- Source checkpoints advance only after complete validated data has been durably stored.
- Search never calls the provider once per displayed notice. Details and exact-number lookup remain on demand.
- Display incomplete source coverage, verification backlog, source watermark, source error and capacity state accurately.
- Do not claim all history has been collected while any source or verification work is pending.

## Review focus

- New cancellation/title/deadline updates invalidate old verified facts before they can match filters.
- Changes during pagination produce SEARCH_CHANGED; retries do not merge two generations.
- Region/license/amount filters run before global sorting and pagination, including unknown conditions.
- Public collection and verification work even with zero enabled personal alarm rules.
- Timeouts, quota limits, capacity rollback and a second worker cannot advance an uncommitted source page or lose pending verification.

### Task 1: Verified publication and paginated SQL search

**Files:** new additive migration and `supabase/tests/verified_notice_search.sql`; shared RPC types owned by root.

- [ ] Add failing SQL regressions for verified-only publication, cancellation invalidation, private-rule independence, wide ranges and filter-before-page ordering.
- [ ] Implement public verification enqueue/claim, lease-bound `search_publish`, generation tracking and `search_page` using the existing token boundary and storage guards.
- [ ] Return `VerifiedNoticeSearchPage` with exact matching count, next cursor, snapshotVersion/asOf, source/verification coverage and capacity metadata.
- [ ] Check all existing catalog/alarm SQL regressions plus repeated migration application in PGlite.

### Task 2: Fair background collection and full verification

**Files:** `server/active-catalog-worker.ts`, worker tests; root owns store interfaces and HTTP budgets.

- [ ] Add tests proving unrelated public matches and no-rule runs are fully verified, while old revisions/partial histories cannot publish.
- [ ] Give verification work a bounded lane before source work; preserve 999-row source reads and durable batches.
- [ ] Fetch current participation regions/licenses independently of personal rules, publish compact current heads and keep personal full history only when needed by alerts.
- [ ] Verify timeout/quota/capacity handling leaves durable work pending.

### Task 3: Bounded public search API

**Files:** `src/live/active-catalog-types.ts`, `server/active-catalog-store.ts`, new `server/verified-notice-search.ts`, `server/http.ts`, `server/alert-http.ts`, API tests.

- [ ] Validate dates in 1995–2100, combined business types, filters, minimal company geography, fixed maximum page size 50 and opaque cursors.
- [ ] Serve `mode=search` only from the shared RPC; map changed-generation responses to HTTP 409 and reject invalid input before storage.
- [ ] Keep authorization/menu checks and private no-store behavior, exclude personal contact details from requests.
- [ ] Give catalog collection and alarm dispatch separate authenticated 43-second HTTP executions, each within the existing 60-second function limit; preserve a ten-minute cadence and run delivery one minute after collection.

### Task 4: Immediate page UI and collection status

**Files:** indexed search controller/hook, `LiveSearch.tsx`, `App.tsx`, relevant UI components and tests.

- [ ] Replace per-candidate lookups with one verified-index request per page, debounce filter changes and cancel stale responses.
- [ ] Send all filters before pagination; render global counts and 50-row cursor pages without filtering only a local subset.
- [ ] Disable provider-backed list hydration; preserve explicit detail/number lookup and bookmarks/demo behavior.
- [ ] Add wide date selection and show source/verification/capacity status, including a visible restart action for changed search generations.

### Task 5: Integration and live acceptance

- [ ] Independent review of SQL, controller races and worker checkpoint/capacity guards.
- [ ] Run complete tests with bounded workers, TypeScript/Vite build and SQL integration regressions.
- [ ] Apply compatible schema, deploy the approved application changes and verify actual worker progress within unchanged storage caps.
- [ ] Check missing-record examples, newest cancellation, multi-year API queries and the actual browser request path; record first-page timing separately from source completion.
- [ ] Report any remaining source backlog or concrete storage approval needed without overstating completeness.
