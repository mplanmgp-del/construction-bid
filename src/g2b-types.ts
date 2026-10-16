import type { BidNotice } from './types.ts';

export type G2bBusinessType = '공사' | '용역';

export interface G2bPage<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  fetchedAt: string;
  source: string;
  warnings?: string[];
}
export type G2bNoticePage = G2bPage<BidNotice> & { quotaExceeded?: boolean; retryAfterSeconds?: number };

export interface G2bNoticeRegions {
  number: string;
  revision: string;
  type: G2bBusinessType;
  procurementSource?: 'public' | 'private';
  allowedRegions: string[] | null;
  complete: boolean;
  fetchedAt: string;
  error?: string;
}

export interface G2bNoticeRegionsPage {
  items: G2bNoticeRegions[];
  quotaExceeded?: boolean;
  retryAfterSeconds?: number;
}

export interface G2bDetailField {
  key: string;
  label: string;
  value: string | null;
  note?: string;
  wide?: boolean;
}
export interface G2bDetailSection {
  id: string;
  label: string;
  fields: G2bDetailField[];
}

export interface G2bNoticeDetail {
  number: string;
  revision: string;
  allowedRegions: string[] | null;
  licenses: string[];
  licenseCodes?: string[];
  regionComplete: boolean;
  licenseComplete: boolean;
  fetchedAt: string;
  warnings: string[];
  notice?: BidNotice;
  sections?: G2bDetailSection[];
  sourceUrl?: string;
}

export interface G2bRelatedRecord {
  id: string;
  title: string;
  fields: G2bDetailField[];
  sourceUrl?: string;
}
export interface G2bRelatedGroup {
  id: string;
  label: string;
  status: 'ok' | 'empty' | 'unavailable';
  message?: string;
  records: G2bRelatedRecord[];
}
export interface G2bRelatedDetail {
  number: string;
  revision: string;
  type: G2bBusinessType;
  fetchedAt: string;
  groups: G2bRelatedGroup[];
  warnings: string[];
}

/** Public opening data, never evidence that a private submission was accepted. */
export interface G2bOpeningResult {
  id: string;
  number: string;
  revision: string;
  title: string;
  type: G2bBusinessType;
  agency: string;
  openingAt: string;
  result: string;
  rank: string;
  companyName: string;
  businessNumber: string;
  bidAmount: number | null;
  bidRate: number | null;
  winnerName: string;
  winnerBusinessNumber: string;
  winningAmount: number | null;
  awarded: boolean | null;
  disqualificationReason: string;
  dataAsOf: string;
}
export type G2bResultPage = G2bPage<G2bOpeningResult>;

export interface G2bResultSummary {
  /** Completeness of the opening states, independent of the winner list. */
  openingComplete?: boolean;
  number: string; revision: string; type: G2bBusinessType;
  firstCompanies: string[]; winnerCompanies: string[]; result: string;
  complete: boolean; fetchedAt: string;
}

export interface G2bApiError {
  error: { code: string; message: string; retryAfterSeconds?: number };
}
