import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BidDetail } from '../src/components/BidDetail';
import { NoticeList } from '../src/components/NoticeList';
import { DEMO_PROFILES, NOTICES } from '../src/data';
import { CompleteNoticeDetails } from '../src/live/CompleteNoticeDetails';
import { NoticeNumberResults } from '../src/live/NoticeNumberLookup';
import { NoticeSummary, PendingNoticeDetails } from '../src/live/NoticeSummary';
import { PublicResults } from '../src/live/PublicResults';
import { UnifiedNoticeSearch } from '../src/live/UnifiedNoticeSearch';
import { buildNoticeNumberResult, type NoticeNumberSnapshot } from '../src/live/notice-number-search';
import type { BidNotice } from '../src/types';
import type { G2bNoticeDetail } from '../src/g2b-types';

const privateBid = { ...NOTICES[0], id: 'g2b:공사:R26BK01774453:000', number: 'R26BK01774453', revision: '000',
  source: 'live' as const, procurementSource: 'private' as const, bidMethod: '직찰',
  status: '확인필요' as const, deadline: '', openingAt: '', biddingStartAt: '',
  postedAt: '2026-10-16T09:00:00+09:00' };
const detail: G2bNoticeDetail = { number: privateBid.number, revision: privateBid.revision,
  allowedRegions: null, licenses: [], regionComplete: false, licenseComplete: false,
  fetchedAt: '', warnings: [], sections: [] };
const renderList = (bid: BidNotice) => renderToStaticMarkup(<NoticeList bids={[bid]} keyword=""
  profile={DEMO_PROFILES[0]} bookmarks={[]} selected={[]} onSelect={() => {}} onOpen={() => {}} onBookmark={() => {}} />);
function numberSnapshot(bid: BidNotice): NoticeNumberSnapshot {
  const group = buildNoticeNumberResult({ items: [bid], totalCount: 1, page: 1, pageSize: 999,
    hasMore: false, source: '나라장터', fetchedAt: '2026-10-16T09:00:00+09:00' },
  { number: bid.number, revision: bid.revision }, bid.type)!;
  return { userId: 'a', query: { number: bid.number, revision: bid.revision }, loading: false,
    attempted: true, groups: [group], errors: [], error: '' };
}

describe('private notice source and missing schedules', () => {
  it('does not present public result and contract feeds as private records', () => {
    const result = renderToStaticMarkup(<PublicResults bid={privateBid} />);
    expect(result).toContain('민간공고의 개찰·계약 결과는 나라장터에서 확인해 주세요.');
    expect(result).not.toContain('투찰업체와 개찰 결과를 조회하고 있습니다');
    const details = renderToStaticMarkup(<CompleteNoticeDetails bid={privateBid} detail={detail} />);
    expect(details).not.toContain('연관 정보 불러오기');
    expect(details).not.toContain('계약·진행 이력·기관</button>');
  });

  it('labels the private assigned budget separately from public planned construction amounts', () => {
    const html = renderToStaticMarkup(<NoticeSummary bid={{ ...privateBid, plannedAmount: 0 }} />);
    expect(html).toContain('<span>배정예산금액</span>');
    expect(html).not.toContain('공고에 공개된 공사 예정금액 기준');
  });
  it.each(['공사', '용역'] as const)('identifies private %s and its bid method in list and number results', type => {
    const bid = { ...privateBid, type };
    const htmls = [renderList(bid), renderToStaticMarkup(<NoticeNumberResults snapshot={numberSnapshot(bid)}
      bookmarks={[]} onBookmark={() => {}} onOpen={() => {}} />)];
    for (const html of htmls) {
      expect(html).toContain(`민간${type}`);
      expect(html).toContain('직찰');
      expect(html).toContain('공고서 확인');
      expect(html).toContain('>일정 확인 필요</span>');
      expect(html).not.toMatch(/datetime=""/i);
    }
  });

  it('keeps private missing deadlines actionable throughout loading and confirmed detail', () => {
    const summaries = [<NoticeSummary bid={privateBid} />, <PendingNoticeDetails bid={privateBid} failed={false} />,
      <PendingNoticeDetails bid={privateBid} failed />, <CompleteNoticeDetails bid={privateBid} detail={detail} />];
    for (const summary of summaries) {
      const html = renderToStaticMarkup(summary);
      expect(html).toContain('<span>입찰서 제출마감</span><strong>공고서 확인</strong>');
      expect(html).toContain('<span>개찰일시</span><strong>일정 확인 필요</strong>');
      expect(html).not.toContain('Invalid Date');
    }
  });

  it('identifies the private source and missing schedules in fallback detail fields', () => {
    const html = renderToStaticMarkup(<CompleteNoticeDetails bid={privateBid} detail={detail} showSummary={false} />);
    expect(html).toContain('민간공사');
    expect(html).toContain('직찰');
    expect(html).toContain('<dt>입찰서 제출마감</dt><dd>공고서 확인</dd>');
    expect(html).toContain('<dt>개찰일시</dt><dd>일정 확인 필요</dd>');
  });

  it('retains the private source and directs bidders to the notice document on the first drawer render', () => {
    const html = renderToStaticMarkup(<BidDetail bid={privateBid} profile={DEMO_PROFILES[0]}
      assessment={{ status: 'review', reason: '지역조건 확인 필요' }} isBookmarked={false}
      onClose={() => {}} onToggleBookmark={() => {}} />);
    expect(html).toContain('민간공사');
    expect(html).toContain('직찰');
    expect(html).toContain('일정은 공고서 확인');
    expect(html).not.toContain('>오늘 마감<');
  });

  it('keeps an actual private opening timestamp when only the submission deadline is absent', () => {
    const bid = { ...privateBid, openingAt: '2026-11-25T14:00:00+09:00' };
    const html = renderToStaticMarkup(<CompleteNoticeDetails bid={bid} detail={detail} />);
    expect(html).toContain('<span>입찰서 제출마감</span><strong>공고서 확인</strong>');
    expect(html).toContain('<span>개찰일시</span><strong>2026.11.25 14:00</strong>');
    expect(html).toContain('<dt>개찰일시</dt><dd>2026.11.25 14:00</dd>');
  });

  it('keeps cancellation visible instead of replacing it with a private schedule status', () => {
    const html = renderList({ ...privateBid, status: '취소', noticeKind: '취소공고' });
    expect(html).toContain('>취소된 공고</small>');
    expect(html).not.toContain('>일정 확인 필요</span>');
  });

  it('preserves actual public deadlines and does not label them as private', () => {
    const bid = { ...NOTICES[0], deadline: '2027-03-04T10:00:00+09:00', openingAt: '2027-03-04T11:00:00+09:00' };
    const html = renderList(bid);
    expect(html).toContain('2027.03.04 10:00');
    expect(html).not.toContain('민간공사');
    expect(html).not.toContain('공고서 확인');
  });

  it('explains why private notices without a deadline appear in a date-filtered title search', () => {
    const html = renderToStaticMarkup(<UnifiedNoticeSearch
      query={{ type: '공사·용역', keyword: '', from: '2026-04-16', to: '2027-04-16' }} loading={false}
      onSearch={() => {}} bookmarks={[]} onOpen={() => {}} onBookmark={() => {}}
      onLogin={() => {}} onResultModeChange={() => {}} />);
    expect(html).toContain('제출마감 미제공 민간공고는 게시일 기준으로 함께 표시합니다.');
  });
});
