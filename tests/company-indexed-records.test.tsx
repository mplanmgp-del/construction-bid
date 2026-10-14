import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CompanyHistory, CompanyParticipation } from '../src/company-types';
import type { CompanyContract } from '../src/company-contract-types';
import { CompanyIndexedRecords } from '../src/company/CompanyIndexedRecords';

const coverage: CompanyHistory['coverage'] = { status: 'collecting', from: null, to: null, updatedAt: null, message: '기간별 수집 진행 중' };
const page = { items: [], totalCount: 0, page: 1, pageSize: 30, coverage };
const history: CompanyHistory = { company: null, items: [], totalCount: 0, page: 1, pageSize: 30, summary: { participationCount: 0, winCount: 0, pendingCount: 0, winningAmount: null, bidAmount: null, averageBidRate: null }, monthly: [], agencies: [], coverage, awards: page, contracts: page };
const render = (value: CompanyHistory) => renderToStaticMarkup(<CompanyIndexedRecords history={value} onAwardPage={() => {}} onContractPage={() => {}} onOpening={() => {}} />);
const award: CompanyParticipation = { id: 'award', number: 'R26BK123', revision: '000', type: '공사', title: '공식 낙찰 공고', agency: '기관', openingAt: '2026-10-14', rank: '1', participantCount: null, bidAmount: null, bidRate: null, awarded: true, winningAmount: 100, method: '일반경쟁' };
const contract: CompanyContract = { id: 'contract', businessNumber: '8488802470', companyName: '업체', type: '공사', title: '공고 없는 계약', agency: '기관', contractDate: '2026-10-13', contractNumber: 'C001', unifiedContractNumber: '', referenceNumber: '', noticeNumber: '', method: '수의계약', contractAmount: 200, totalContractAmount: null, shareRate: null, sourceUrl: 'https://www.g2b.go.kr/', registeredAt: '', changedAt: '' };

describe('indexed award and contract presentation', () => {
  it('shows incomplete empty sources as unconfirmed, not zero or a completed lifetime search', () => {
    const markup = render(history);
    expect(markup).not.toContain('0건');
    expect(markup).toContain('낙찰 이력을 아직 확인하지 못했습니다');
    expect(markup).toContain('계약 이력을 아직 확인하지 못했습니다');
    expect(markup).toContain('수집 진행 중');
  });
  it('shows a confirmed empty collected range as zero while preserving the source scope', () => {
    const ready = { ...coverage, status: 'ready' as const };
    const markup = render({ ...history, awards: { ...page, coverage: ready }, contracts: { ...page, coverage: ready } });
    expect(markup).toContain('0건');
    expect(markup).toContain('확인된 수집 범위');
    expect(markup).not.toContain('전체 조회 완료');
  });
  it('keeps awards and direct contracts distinct and never combines their amounts', () => {
    const markup = render({ ...history, awards: { ...page, items: [award], totalCount: 1 }, contracts: { ...page, items: [contract], totalCount: 1 } });
    expect(markup).toContain('수집된 참여 중 낙찰');
    expect(markup).toContain('공식 낙찰 공고');
    expect(markup).toContain('공고 없는 계약');
    expect(markup).toContain('수의계약');
    expect(markup).toContain('계약 건수를 입찰 낙찰 건수에 더하지 않습니다');
    expect(markup).toContain('100원'); expect(markup).toContain('200원'); expect(markup).not.toContain('300원');
    expect(markup).not.toContain('/api/company-awards'); expect(markup).not.toContain('/api/company-contracts');
  });
  it('offers recovery when indexed totals shrink below the selected page', () => {
    const markup = render({ ...history, contracts: { ...page, page: 11, totalCount: 1 } });
    expect(markup).toContain('첫 페이지 보기');
    expect(markup).not.toContain('301–1');
  });
  it('does not turn an unsafe contract URL into a clickable link', () => {
    const markup = render({ ...history, contracts: { ...page, items: [{ ...contract, sourceUrl: 'javascript:alert(1)' }], totalCount: 1 } });
    expect(markup).not.toContain('javascript:'); expect(markup).toContain('공고 없는 계약');
  });
});
