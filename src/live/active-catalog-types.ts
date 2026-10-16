import type { AlertNotice, WorkerRule } from '../alerts/types';
import type { G2bBusinessType, G2bNoticePage } from '../g2b-types';
import type { SearchFilters } from '../types';

export interface ActiveCatalogIdentity {
  type: G2bBusinessType; number: string; tracked?: boolean;
  /** Minimum source facts that a later full-history response must contain. */
  revision?: string; sourceUpdatedAt?: string;
  notice?: AlertNotice;
}
export interface ActiveCatalogSourceJob {
  id: string; type: G2bBusinessType; kind: 'history' | 'current' | 'registered' | 'modified';
  from: string; to: string; page: number; pageSize: 999; totalCount: number | null;
}
export interface ActiveCatalogStatus {
  groupCount: number; activeCount: number; pendingSources: number; pendingVerification: number;
  completedSources: number; coverageFrom: string | null; bootstrapComplete: boolean;
  lastCheckedAt: string | null; error: string | null; storageBytes: number; storageCeiling: number;
  /** Current-only posting sweep; never substitutes for unfiltered history coverage. */
  currentCoverage?: CurrentCatalogCoverage;
}
export interface CurrentCatalogCoverage {
  cutoff: string | null; checked: number; pending: number; verificationPending: number;
  scope?: string; keywords?: string[]; globalUnknownPending?: number; complete: boolean;
  syncedThrough?: string | null; requiredThrough?: string | null;
}
export interface ActiveCatalogGroup extends ActiveCatalogIdentity {
  key: string; latest: AlertNotice; versions: AlertNotice[]; verifiedAt: string;
}
export interface ActiveCatalogPage {
  groups: ActiveCatalogGroup[]; nextCursor: string | null; status: ActiveCatalogStatus;
}
export interface ActiveCatalogClaim {
  leaseId: string | null; scopeVersion: string; rules: WorkerRule[];
  sources: ActiveCatalogSourceJob[]; verify: ActiveCatalogIdentity[]; status: ActiveCatalogStatus;
}
export interface ActiveCatalogCommit {
  scopeVersion: string;
  sources?: { id: string; page: number; totalCount: number; receivedCount: number;
    /** Every current raw number:revision, including nonfocus titles, until its source completes. */
    rawIdentities?: string[];
    /** Raw identities are transient: retained heads are rechecked even after losing eligibility. */
    observed: ActiveCatalogIdentity[]; items: AlertNotice[]; complete: boolean }[];
  groups?: AlertNotice[][];
  rejectedGroups?: ActiveCatalogIdentity[];
  failedSources?: { id: string; error: string; restart?: boolean }[];
  failedGroups?: (ActiveCatalogIdentity & { error: string })[];
}
export interface ActiveCatalogPageQuery {
  cursor?: string | null; limit?: number; types?: G2bBusinessType[];
  changedSince?: string; changedThrough?: string; includeInactive?: boolean;
  includeIndex?: boolean; deadlineFrom?: string; deadlineTo?: string;
}

export interface DeadlineCatalogQuery {
  from: string; to: string; type: G2bBusinessType; keyword?: string; page?: number; pageSize?: number; now?: number;
}
export type DeadlineCatalogPage = G2bNoticePage & {
  indexCoverage: { complete: boolean; pending: number; checked: number };
};
export interface DeadlineIndexBatch {
  scopeVersion: string; sourceId: string; page: number; batch: number; batches: number;
  notices: AlertNotice[]; removed: ActiveCatalogIdentity[];
}

export interface VerifiedNoticeSearchQuery {
  type: G2bBusinessType | '공사·용역'; from: string; to: string; keyword: string;
  filters: SearchFilters; profile?: { province: string; district: string };
  limit?: number; cursor?: string;
}
export type VerifiedNoticeSearchStatusQuery = Omit<VerifiedNoticeSearchQuery, 'cursor'> & { asOf: string; snapshotVersion: string };
export interface VerifiedNoticeSearchResults extends G2bNoticePage {
  nextCursor: string | null; snapshotVersion: string; asOf: string;
  validUntil?: string;
}
export interface VerifiedNoticeSearchStatus {
  snapshotVersion: string; asOf: string;
  indexCoverage: { complete: boolean; pending: number; checked: number };
  sourceSyncedThrough: string | null; verifiedCount: number; pendingCount: number; conditionPendingCount: number;
  storage: { bytes: number; ceiling: number; full: boolean };
  sourceError?: string | null;
  currentCoverage?: CurrentCatalogCoverage;
  warnings?: string[];
}
/** Compatibility response for the existing combined search endpoint. */
export interface VerifiedNoticeSearchPage extends VerifiedNoticeSearchResults, VerifiedNoticeSearchStatus {}
/** Browser result state; aggregate metadata may still be loading or unavailable. */
export interface VerifiedNoticeSearchView extends VerifiedNoticeSearchResults {
  status: VerifiedNoticeSearchStatus | null; statusLoading: boolean; statusError: string;
}
export interface SearchVerifiedBatch {
  scopeVersion: string; groups: AlertNotice[][];
  /** Exact locked source version, only after fresh listing/history agreement. */
  expectedSourceVersion?: string;
}
export interface SearchPublicationResult {
  ok: boolean; storageFull?: boolean; retryRequired?: boolean; reason?: 'source_changed';
  conflict?: 'older_revision' | 'older_source_time' | 'same_clock_content';
  changedFields?: string[]; indexedHead?: AlertNotice; sourceVersion?: string;
}
