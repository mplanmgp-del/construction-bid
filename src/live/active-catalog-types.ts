import type { AlertNotice, WorkerRule } from '../alerts/types';
import type { G2bBusinessType, G2bNoticePage } from '../g2b-types';

export interface ActiveCatalogIdentity {
  type: G2bBusinessType; number: string; tracked?: boolean;
  /** Minimum source facts that a later full-history response must contain. */
  revision?: string; sourceUpdatedAt?: string;
}
export interface ActiveCatalogSourceJob {
  id: string; type: G2bBusinessType; kind: 'history' | 'registered' | 'modified';
  from: string; to: string; page: number; pageSize: 999; totalCount: number | null;
}
export interface ActiveCatalogStatus {
  groupCount: number; activeCount: number; pendingSources: number; pendingVerification: number;
  completedSources: number; coverageFrom: string | null; bootstrapComplete: boolean;
  lastCheckedAt: string | null; error: string | null; storageBytes: number; storageCeiling: number;
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
