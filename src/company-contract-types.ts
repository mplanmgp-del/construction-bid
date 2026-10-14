export interface CompanyContractQuery {
  businessNumber: string;
  type: '공사' | '용역';
  from: string;
  to: string;
  page: number;
}

/** A published contract record, including contracts without an auction notice.
 * Contract changes retain their full confirmed contract number; this DTO does
 * not merge original/change records or claim a company's lifetime award total. */
export interface CompanyContract {
  id: string;
  type: '공사' | '용역';
  businessNumber: string;
  companyName: string;
  title: string;
  agency: string;
  contractDate: string;
  contractNumber: string;
  unifiedContractNumber: string;
  referenceNumber: string;
  noticeNumber: string;
  method: string;
  /** Published current contract total, NOT this company's joint-venture share. */
  contractAmount: number | null;
  totalContractAmount: number | null;
  /** Present only when one unambiguous company share is published. */
  shareRate: number | null;
  sourceUrl: string;
  registeredAt: string;
  changedAt: string;
}

export interface CompanyContractPage extends CompanyContractQuery {
  items: CompanyContract[];
  pageSize: number;
  /** Counts describe the unfiltered official contract page, not company matches. */
  sourceCount: number;
  totalCount: number;
  hasMore: boolean;
  /** True only on a valid last page. The caller must also verify earlier pages. */
  complete: boolean;
  /** Allows the continuation client to detect a repeated provider page. */
  sourceFingerprint: string;
  warnings: string[];
  fetchedAt: string;
  source: string;
}
