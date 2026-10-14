import type { CompanyParticipation } from './company-types';

export interface CompanyParticipationQuery {
  businessNumber: string;
  type: '공사' | '용역';
  /** One Korean calendar opening date. The provider limits this operation to one day. */
  day: string;
  page: number;
}

export interface CompanyLiveParticipation extends CompanyParticipation {
  businessNumber: string;
  biddingAt: string;
  /** The standard source does not publish lot/round identifiers. Never infer them. */
  classification: string;
  rebid: string;
}

export interface CompanyParticipationPage extends CompanyParticipationQuery {
  items: CompanyLiveParticipation[];
  pageSize: number;
  /** National source rows for this date and business type, not this company's participation count. */
  totalCount: number;
  /** Rows examined before exact-company filtering. An empty items array can still have more pages. */
  sourceCount: number;
  hasMore: boolean;
  /** This page has been validated. It does not mean the whole date or requested history is complete. */
  complete: boolean;
  /** Opaque digest used to detect a repeated provider page across server instances. */
  pageFingerprint: string;
  warnings: string[];
  fetchedAt: string;
  source: string;
}
