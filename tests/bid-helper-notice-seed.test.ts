import { describe, expect, it } from 'vitest';
import type { G2bDetailSection, G2bNoticeDetail } from '../src/g2b-types';
import { NOTICES } from '../src/data';
import { buildBidHelperSeed, clearPendingBidHelperSeed, readPendingBidHelperSeed, storePendingBidHelperSeed } from '../src/bid-helper/notice-seed';
import { restoreBidHelperState } from '../src/bid-helper/draft';
import { mapDetailSections } from '../server/g2b-detail';

const bid = { ...NOTICES[0], id: 'g2b:공사:R26BK00012345:002', number: 'R26BK00012345', revision: '002', title: '공고에서 불러올 철거공사', estimatedPrice: 70_000_000 };
const section = (id: string, values: Record<string, string | null>): G2bDetailSection => ({ id, label: id, fields: Object.entries(values).map(([key, value]) => ({ key, label: key, value })) });
const detail = (sections: G2bDetailSection[]): G2bNoticeDetail => ({ number: bid.number, revision: bid.revision, allowedRegions: null, licenses: [], regionComplete: true, licenseComplete: true, fetchedAt: '2026-10-16T00:00:00Z', warnings: [], sections });
const base = { bssamt: '63,620,000 원', bssAmtPurcnstcst: '48,900,000 원', rsrvtnPrceRngBgnRate: '-3%', rsrvtnPrceRngEndRate: '+3%', bidPrceCalclAYn: '예', insuranceManagementSum: '4,748,790 원' };
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe('notice values passed to the bid helper', () => {
  it('uses the disclosed base amount, A sum and percent fields when A applies', () => {
    const seed = buildBidHelperSeed(bid, detail([section('pricing', { sucsfbidLwltRate: '89.745%' }), section('baseAmount', base)]));
    expect(seed).toMatchObject({ noticeId: bid.id, title: bid.title, number: 'R26BK00012345', revision: '002', baseAmount: 63_620_000, aValue: 4_748_790, lowerRate: 89.745, netCost: 48_900_000, rangeMin: -3, rangeMax: 3, aApplied: true });
    expect(restoreBidHelperState(seed, null).fields.aValue).toBe('4,748,790');
  });

  it('transfers the displayed insurance sum through the official detail mapping into helper inputs', () => {
    const sections = mapDetailSections({ type: '공사', baseRows: [{ bssamt: '63620000', bidPrceCalclAYn: 'Y',
      npnInsrprm: '100000', mrfnHealthInsrprm: '200000', rtrfundNon: '0', odsnLngtrmrcprInsrprm: '89664', sftyMngcst: '100000', sftyChckMngcst: '200000', qltyMngcst: '0' }] });
    const fields = restoreBidHelperState(buildBidHelperSeed(bid, detail(sections)), null).fields;
    expect(fields.baseAmount).toBe('63,620,000');
    expect(fields.aValue).toBe('689,664');
  });

  it.each(['아니오', null, '미공개'])('does not apply a disclosed sum when the flag is %s', applied => {
    const seed = buildBidHelperSeed(bid, detail([section('baseAmount', { ...base, bidPrceCalclAYn: applied })]));
    expect(seed).not.toHaveProperty('aValue');
    expect(restoreBidHelperState(seed, null).fields.aValue).toBe(applied === '아니오' ? '0' : '');
  });

  it.each([null, '-1 원', '9007199254740992 원', '689,664 원 임의문구'])('leaves A empty when an applicable sum is unavailable or invalid: %s', sum => {
    const seed = buildBidHelperSeed(bid, detail([section('baseAmount', { ...base, insuranceManagementSum: sum })]));
    expect(seed).not.toHaveProperty('aValue');
    expect(restoreBidHelperState(seed, null).fields.aValue).toBe('');
  });

  it('imports a real zero but leaves duplicate A amounts unresolved', () => {
    const zero = buildBidHelperSeed(bid, detail([section('baseAmount', { ...base, insuranceManagementSum: '0 원' })]));
    expect(restoreBidHelperState(zero, null).fields.aValue).toBe('0');
    const duplicate = section('baseAmount', base);
    duplicate.fields.push({ key: 'insuranceManagementSum', label: '보험료·관리비 합계', value: '1 원' });
    expect(restoreBidHelperState(buildBidHelperSeed(bid, detail([duplicate])), null).fields.aValue).toBe('');
  });

  it('never fills missing base money with estimated price or a missing cost with zero', () => {
    const seed = buildBidHelperSeed(bid, detail([section('baseAmount', { bssamt: null, bssAmtPurcnstcst: null })]));
    expect(seed.baseAmount).toBeUndefined();
    expect(seed.netCost).toBeUndefined();
    expect(seed.lowerRate).toBeUndefined();
    expect(seed.aApplied).toBeUndefined();
    expect(seed).not.toHaveProperty('aValue');
  });

  it('requires choosing a disclosure when several base amount rows exist', () => {
    const seed = buildBidHelperSeed(bid, detail([section('pricing', { sucsfbidLwltRate: '87.745%' }), section('baseAmount', { baseAmountCount: '2건' }), section('baseAmount-1', base), section('baseAmount-2', { ...base, bssamt: '1,000 원' })]));
    expect(seed.lowerRate).toBe(87.745);
    expect(seed.baseAmount).toBeUndefined();
    expect(seed.netCost).toBeUndefined();
    expect(seed.aApplied).toBeUndefined();
    expect(seed.notes.join(' ')).toContain('복수');
  });

  it('accepts a real zero and rejects malformed or unsafe numbers and mismatched revisions', () => {
    const seed = buildBidHelperSeed(bid, detail([section('pricing', { sucsfbidLwltRate: '89.7% 임의 문구' }), section('baseAmount', { bssamt: '9007199254740992 원', bssAmtPurcnstcst: '0 원', rsrvtnPrceRngBgnRate: 'NaN%', bidPrceCalclAYn: '아니오' })]));
    expect(seed.baseAmount).toBeUndefined(); expect(seed.lowerRate).toBeUndefined(); expect(seed.rangeMin).toBeUndefined();
    expect(seed.netCost).toBe(0); expect(seed.aApplied).toBe(false);
    expect(buildBidHelperSeed(bid, { ...detail([section('baseAmount', base)]), revision: '001' }).baseAmount).toBeUndefined();
  });
});

describe('same-tab bid helper transfer', () => {
  it('round-trips a validated notice and clears it after consumption', () => {
    const saved = storage();
    const seed = buildBidHelperSeed(bid, detail([section('baseAmount', base)]));
    expect(storePendingBidHelperSeed(seed, saved)).toBe(true);
    expect(readPendingBidHelperSeed(saved)).toEqual(seed);
    clearPendingBidHelperSeed(saved);
    expect(readPendingBidHelperSeed(saved)).toBeUndefined();
  });

  it('rejects malformed stored data and unexpected fields without changing unrelated storage', () => {
    const saved = storage();
    const seed = buildBidHelperSeed(bid);
    storePendingBidHelperSeed(seed, saved);
    const key = [...saved.values.keys()][0];
    const encoded = JSON.parse(saved.values.get(key)!);
    for (const patch of [{ baseAmount: -1 }, { lowerRate: '89.745' }, { notes: ['ok', 0] }, { aValue: -1 }, { aValue: 123 }, { revision: '../../' }]) {
      saved.values.set(key, JSON.stringify({ ...encoded, seed: { ...seed, ...patch } }));
      expect(readPendingBidHelperSeed(saved)).toBeUndefined();
    }
    saved.values.set('other-work', 'preserved');
    saved.values.set(key, '{broken');
    expect(readPendingBidHelperSeed(saved)).toBeUndefined();
    clearPendingBidHelperSeed(saved);
    expect(saved.values.get('other-work')).toBe('preserved');
  });

  it('continues safely when session storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(storePendingBidHelperSeed(buildBidHelperSeed(bid), broken)).toBe(false);
    expect(readPendingBidHelperSeed(broken)).toBeUndefined();
    expect(() => clearPendingBidHelperSeed(broken)).not.toThrow();
  });
});
