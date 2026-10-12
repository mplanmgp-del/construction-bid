import { describe, expect, it } from 'vitest';
import { resolveDisplayedBid } from '../src/components/BidDetail';
import { assessRegion } from '../src/domain';
import { NOTICES } from '../src/data';
import type { BidNotice, CompanyProfile } from '../src/types';
import type { G2bNoticeDetail } from '../src/g2b-types';

const saved: BidNotice = {
  ...NOTICES[0], id: 'g2b:공사:NOTICE:000', number: 'NOTICE', revision: '000', type: '공사', source: 'live',
  title: '저장된 공고명', deadline: '2099-01-10T10:00:00+09:00', allowedRegions: ['경기도 화성시'], licenses: ['기존 면허'],
  specialRegionCondition: false, documents: [{ name: '이전 공고.pdf', size: '크기 미제공' }],
};
const refreshed: BidNotice = {
  ...saved, title: '최신 공고명', deadline: '2099-02-10T10:00:00+09:00', estimatedPrice: null,
  allowedRegions: ['서울특별시'], licenses: ['새 면허'], documents: [{ name: '최신 첨부.hwpx', size: '크기 미제공', url: 'https://www.g2b.go.kr/download?file=latest' }],
};
const detail: G2bNoticeDetail = {
  number: saved.number, revision: saved.revision, notice: refreshed, allowedRegions: refreshed.allowedRegions, licenses: refreshed.licenses,
  regionComplete: true, licenseComplete: true, fetchedAt: '', warnings: [], sourceUrl: 'https://www.g2b.go.kr/link/PNPE027_01/?bidPbancNo=NOTICE&bidPbancOrd=000',
};
const company: CompanyProfile = { id: 'member', companyName: '업체', province: '경기도', district: '화성시', address: '', licenses: [], contactName: '', email: '' };

describe('consistent detail drawer display', () => {
  it('uses one refreshed title, deadline, price, attachment set and source link without changing saved data', () => {
    const previous = JSON.stringify(saved);
    const result = resolveDisplayedBid(saved, { bidId: saved.id, data: detail });
    expect(result.bid).toMatchObject({ id: saved.id, title: '최신 공고명', deadline: refreshed.deadline, estimatedPrice: null, documents: refreshed.documents, detailUrl: detail.sourceUrl });
    expect(result.detail).toBe(detail);
    expect(JSON.stringify(saved)).toBe(previous);
  });
  it('retains prior verified conditions for incomplete lookups while refreshing other public fields', () => {
    const result = resolveDisplayedBid(saved, { bidId: saved.id, data: { ...detail, regionComplete: false, licenseComplete: false, allowedRegions: null, licenses: [], notice: { ...refreshed, allowedRegions: null, licenses: [] } } });
    expect(result.bid.title).toBe('최신 공고명');
    expect(result.bid.allowedRegions).toEqual(saved.allowedRegions);
    expect(result.bid.licenses).toEqual(saved.licenses);
    expect(result.bid.documents).toEqual(refreshed.documents);
  });
  it('updates the region decision from latest conditions and joint-bidding flags', () => {
    expect(assessRegion(saved, company).status).toBe('matched');
    const result = resolveDisplayedBid(saved, { bidId: saved.id, data: detail });
    expect(assessRegion(result.bid, company).status).toBe('excluded');
    const special = resolveDisplayedBid(saved, { bidId: saved.id, data: { ...detail, notice: { ...refreshed, specialRegionCondition: true } } });
    expect(assessRegion(special.bid, company).status).toBe('review');
  });
  it('does not render previous selection data before request effects clear state', () => {
    const loaded = { bidId: saved.id, data: detail };
    const next = { ...saved, id: 'g2b:공사:NEXT:000', number: 'NEXT', title: '다른 공고' };
    expect(resolveDisplayedBid(next, loaded)).toEqual({ bid: next, detail: null });
    expect(resolveDisplayedBid(saved, { bidId: saved.id, data: { ...detail, revision: '001' } })).toEqual({ bid: saved, detail: null });
    expect(resolveDisplayedBid(saved, { bidId: saved.id, data: { ...detail, notice: { ...refreshed, type: '용역' } } })).toEqual({ bid: saved, detail: null });
  });
  it('can refresh region-only responses and never enriches a demonstration notice', () => {
    const result = resolveDisplayedBid(saved, { bidId: saved.id, data: { ...detail, notice: undefined } });
    expect(result.bid.title).toBe(saved.title);
    expect(result.bid.allowedRegions).toEqual(['서울특별시']);
    expect(result.bid.documents).toEqual(saved.documents);
    const demonstration = { ...saved, source: 'demo' as const };
    expect(resolveDisplayedBid(demonstration, { bidId: demonstration.id, data: detail })).toEqual({ bid: demonstration, detail: null });
  });
});
