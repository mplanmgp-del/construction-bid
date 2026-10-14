import type { G2bBusinessType, G2bResultSummary } from './g2b-types.ts';

export interface OpeningResultsQuery {
  number: string;
  revision: string;
  type: G2bBusinessType;
}

export interface OpeningParticipant {
  id: string;
  rank: string;
  businessNumber: string;
  companyName: string;
  bidAmount: number | null;
  bidRate: number | null;
  biddingAt: string;
  result: string;
  remarks: string;
  /** True only when the final award endpoint identifies this business in this lot and round. */
  awarded: boolean | null;
}

export interface OpeningResultGroup {
  id: string;
  classification: string;
  rebid: string;
  title: string;
  agency: string;
  openingAt: string;
  status: string;
  participantCount: number | null;
  firstCompany: string;
  winnerCompany: string;
  winnerBusinessNumber: string;
  winningAmount: number | null;
  reason: string;
  deadline: string;
  participants: OpeningParticipant[];
}

export interface NoticeOpeningResults extends OpeningResultsQuery {
  fetchedAt: string;
  source: string;
  complete: boolean;
  warnings: string[];
  /** Archive requests only: the bounded page allowance was exhausted. Retrying the same allowance cannot complete this snapshot. */
  archiveLimitExceeded?: boolean;
  /** Number of participant records actually returned, across all lots and rebid rounds. */
  participantCount: number;
  groups: OpeningResultGroup[];
  summary: G2bResultSummary;
}
