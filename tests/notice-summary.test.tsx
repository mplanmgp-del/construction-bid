import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoticeSummary, PendingNoticeDetails } from '../src/live/NoticeSummary';
import { BidDetail } from '../src/components/BidDetail';
import { mapNotice } from '../server/g2b';
import type { G2bNoticeDetail } from '../src/g2b-types';

const bid = mapNotice({ bidNtceNo: 'TEST', bidNtceOrd: '000', presmptPrce: '57836364', bdgtAmt: '94340000', bidClseDt: '2099-01-01 10:00:00' }, '공사');
const detail: G2bNoticeDetail = { number: 'TEST', revision: '000', allowedRegions: null, licenses: [], regionComplete: false, licenseComplete: false, fetchedAt: '', warnings: [], sections: [{ id: 'pricing', label: '금액', fields: [
  { key: 'bdgtAmt', label: '공사 예정금액', value: '94,340,000 원' },
  { key: 'bssamt', label: '기초금액', value: '63,620,000 원' },
] }] };

describe('notice summary through detail loading', () => {
  it('maps the budget independently and uses it before and after detail arrives', () => {
    expect(bid).toMatchObject({ estimatedPrice: 57836364, plannedAmount: 94340000 });
    for (const html of [renderToStaticMarkup(<NoticeSummary bid={bid} pending />), renderToStaticMarkup(<NoticeSummary bid={bid} detail={detail} />)]) {
      expect(html).toContain('94,340,000');
      expect(html).toContain('57,836,364');
      expect(html).toContain('공사 예정금액');
      expect(html).not.toContain('63,620,000');
    }
  });
  it('distinguishes pending, failed and confirmed absence without substituting the base amount', () => {
    const unknown = { ...bid, plannedAmount: undefined };
    expect(renderToStaticMarkup(<PendingNoticeDetails bid={unknown} failed={false} />)).toContain('조회 중');
    const failed = renderToStaticMarkup(<PendingNoticeDetails bid={unknown} failed />);
    expect(failed).toContain('조회 실패');
    expect(failed).toContain('aria-busy="false"');
    const missing = { ...detail, sections: [{ ...detail.sections![0], fields: [{ key: 'bdgtAmt', label: '공사 예정금액', value: null }] }] };
    const html = renderToStaticMarkup(<NoticeSummary bid={bid} detail={missing} />);
    expect(html).toContain('원문 확인 필요');
    expect(html).not.toContain('94,340,000');
    expect(renderToStaticMarkup(<NoticeSummary bid={{ ...bid, plannedAmount: 0 }} />)).toContain('>0원<');
  });
  it('renders the shared summary on the first drawer render instead of the old simple card', () => {
    const html = renderToStaticMarkup(<BidDetail bid={bid} profile={{ id: 'test', companyName: '테스트', province: '', district: '', address: '', licenses: [], contactName: '', email: '' }} assessment={{ status: 'review', reason: '' }} isBookmarked={false} onClose={() => {}} onToggleBookmark={() => {}} />);
    expect(html).toContain('fnd-key-summary');
    expect(html).toContain('94,340,000');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('detail-price-block');
    expect(html).not.toContain('금액 검색 및 정렬에 사용하는');
  });
});
