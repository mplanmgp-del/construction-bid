export interface PublicCompany {
  businessNumber: string;
  name: string;
  representative: string;
  address: string;
  phone: string;
  registrationDate: string;
  companyType: string;
  licenses: string[];
  products: string[];
  updatedAt: string;
}
export interface CompanyParticipation {
  id: string;
  number: string;
  revision: string;
  type: '공사' | '용역';
  title: string;
  agency: string;
  openingAt: string;
  rank: string;
  participantCount: number | null;
  bidAmount: number | null;
  bidRate: number | null;
  awarded: boolean | null;
  winningAmount: number | null;
  method: string;
}
export interface CompanyGroupSummary {
  name: string;
  participationCount: number;
  winCount: number;
  winningAmount: number | null;
}
export interface CompanyHistory {
  company: PublicCompany | null;
  items: CompanyParticipation[];
  totalCount: number;
  page: number;
  pageSize: number;
  summary: {
    participationCount: number;
    winCount: number;
    pendingCount: number;
    winningAmount: number | null;
    bidAmount: number | null;
    averageBidRate: number | null;
  };
  monthly: { month: string; participationCount: number; winCount: number; winningAmount: number | null }[];
  agencies: CompanyGroupSummary[];
  businessTypes?: CompanyGroupSummary[];
  methods?: CompanyGroupSummary[];
  competitors?: { businessNumber: string; name: string; sharedCount: number; winCount: number }[];
  coverage: {
    status: 'collecting' | 'ready' | 'unavailable';
    from: string | null;
    to: string | null;
    updatedAt: string | null;
    message: string;
  };
}
