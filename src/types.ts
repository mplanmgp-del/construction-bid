export const CATEGORIES = ['철거·해체', '석면', '건축·리모델링', '토목', '보수·유지관리', '전기·통신·소방', '기계·설비', '조경', '폐기물', '조사·설계·감리'] as const;
export type Category = typeof CATEGORIES[number] | '기타';
export type BidStatus = '접수중' | '접수예정' | '마감' | '취소' | '확인필요';
// In-memory navigation context survives object spreads but is omitted by JSON
// and structuredClone, so historical-detail context cannot become saved data.
export const NOTICE_REVISION_CONTEXT = Symbol('noticeRevisionContext');
export const NOTICE_STATUSES = ['개찰 완료', '진행중', '마감 임박', '예정'] as const;
export type NoticeStatus = typeof NOTICE_STATUSES[number];
export type RegionStatus = 'matched' | 'excluded' | 'review';
export interface RegionAssessment { status: RegionStatus; reason: string; }
export interface SearchRegion { province: string; district?: string; locality?: string; }
export interface QuickLink { label: string; url: string; }
export interface CompanyProfile {
  id: string; companyName: string; province: string; district: string;
  address: string; licenses: string[]; contactName: string; email: string;
  businessNumber?: string;
  quickLinks?: QuickLink[];
}
export interface BidNotice {
  [NOTICE_REVISION_CONTEXT]?: { latestRevision: string; latestStatus: BidStatus; latestNoticeKind?: string };
  id: string; number: string; revision: string; title: string; agency: string;
  type: '공사' | '용역'; category: Category; province: string; district: string;
  procurementSource?: 'public' | 'private';
  bidMethod?: string;
  allowedRegions: string[] | null; estimatedPrice: number | null;
  plannedAmount?: number | null;
  demandAgency?: string;
  regionSearchText?: string;
  regionSearchDigest?: string;
  noticeKind?: string;
  contractMethod: string; status: BidStatus;
  postedAt: string; deadline: string; openingAt: string; registrationDeadline: string;
  sourceUpdatedAt?: string;
  biddingStartAt?: string;
  openingCompleted?: boolean;
  licenses: string[]; duration: string; description: string; requirements: string[];
  documents: { name: string; size: string; url?: string }[]; revised: boolean;
  source?: 'live' | 'demo'; detailUrl?: string;
  specialRegionCondition?: boolean;
}
export interface SearchFilters {
  keyword: string; excludeKeyword: string; category: Category | '전체';
  type: '전체' | '공사' | '용역'; siteProvince: string; license: string;
  minAmount: string; maxAmount: string; status: NoticeStatus | '전체';
  statuses?: NoticeStatus[]; regions?: SearchRegion[]; includeUnknownRegions?: boolean;
  contractMethod: string; deadlineFrom: string; deadlineTo: string;
  regionView: 'all' | RegionStatus; autoRegion: boolean;
  sort: 'deadline' | 'newest' | 'amountAsc' | 'amountDesc';
}
