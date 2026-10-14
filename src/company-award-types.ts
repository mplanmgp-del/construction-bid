import type { CompanyParticipation } from './company-types.ts';

export interface CompanyAwardQuery {
  businessNumber: string;
  from: string;
  to: string;
  type: '공사' | '용역';
}

/** Final-award data only; it is not a list of every bid the company submitted. */
export interface CompanyAward extends CompanyParticipation {
  businessNumber: string;
  classification: string;
  rebid: string;
  awardDate: string;
  awardRate: number | null;
}

export interface CompanyAwardPage extends CompanyAwardQuery {
  items: CompanyAward[];
  totalCount: number;
  complete: boolean;
  warnings: string[];
  source: string;
  fetchedAt: string;
}
