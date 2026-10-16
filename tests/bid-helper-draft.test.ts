import { describe, expect, it } from 'vitest';
import { restoreBidHelperState, serializeBidHelperState, type BidHelperFields } from '../src/bid-helper/draft';
import type { BidHelperSeed } from '../src/bid-helper/notice-seed';

const seed: BidHelperSeed = { noticeId: 'g2b:공사:R26BK00012345:002', title: '철거공사', number: 'R26BK00012345', revision: '002', baseAmount: 63_620_000, lowerRate: 89.745, netCost: 0, rangeMin: -3, rangeMax: 3, aApplied: true, notes: ['A값은 직접 입력하세요.'] };
const edited: BidHelperFields = { baseAmount: '63,620,000', aValue: '123,456', lowerRate: '89.745', plannedPrice: '', bidAmount: '0', noticeRate: '99.875', targetRate: '89.765', rangeMin: '-3', rangeMax: '3' };
const encoded = (fields: unknown = edited, storedSeed: unknown = seed) => JSON.stringify({ version: 1, fields, seed: storedSeed });

describe('bid helper draft restoration', () => {
  it('preserves edited fields when reopening the same disclosed notice', () => {
    const raw = serializeBidHelperState({ fields: edited, seed });
    const restored = restoreBidHelperState({ ...seed, title: '철거공사 정정 제목', notes: ['최신 원문 안내'] }, raw);
    expect(restored.fields.aValue).toBe('123,456');
    expect(restored.fields.noticeRate).toBe('99.875');
    expect(restored.fields.targetRate).toBe('89.765');
    expect(restored.seed?.title).toBe('철거공사 정정 제목');
    expect(restored.seed?.notes).toEqual(['최신 원문 안내']);
  });

  it('never carries edited values to a different notice', () => {
    const other = { ...seed, noticeId: 'g2b:공사:R26BK00067890:000', number: 'R26BK00067890', revision: '000' };
    const restored = restoreBidHelperState(other, encoded());
    expect(restored.fields.aValue).toBe('');
    expect(restored.fields.noticeRate).toBe('100');
    expect(restored.fields.targetRate).toBe('89.745');
    expect(restored.fields.bidAmount).toBe('');
    expect(restored.seed?.number).toBe('R26BK00067890');
  });

  it.each([
    { baseAmount: 64_000_000 }, { lowerRate: 87.745 }, { netCost: 1 },
    { rangeMin: -2 }, { rangeMax: 2 }, { aApplied: false },
  ])('starts with fresh inputs when a disclosed source value changes: %j', patch => {
    const restored = restoreBidHelperState({ ...seed, ...patch }, encoded());
    expect(restored.fields.aValue).toBe(patch.aApplied === false ? '0' : '');
    expect(restored.fields.noticeRate).toBe('100');
    expect(restored.fields.targetRate).toBe(patch.lowerRate === undefined ? '89.745' : '87.745');
  });

  it('uses a newly disclosed base amount after a source refresh', () => {
    const restored = restoreBidHelperState({ ...seed, baseAmount: 64_000_000 }, encoded());
    expect(restored.fields.baseAmount).toBe('64,000,000');
    expect(restored.fields.aValue).toBe('');
  });

  it('fills the applicable A amount and preserves edits only while the disclosed A amount is unchanged', () => {
    const source = { ...seed, aValue: 689_664 };
    expect(restoreBidHelperState(source, null).fields.aValue).toBe('689,664');
    const raw = serializeBidHelperState({ fields: edited, seed: source });
    expect(restoreBidHelperState(source, raw).fields.aValue).toBe('123,456');
    const refreshed = restoreBidHelperState({ ...source, aValue: 700_000 }, raw);
    expect(refreshed.fields.aValue).toBe('700,000');
    expect(refreshed.fields.noticeRate).toBe('100');
    expect(restoreBidHelperState(source, encoded()).fields.aValue).toBe('689,664');
  });

  it('restores the latest draft together with its notice metadata when no explicit seed is supplied', () => {
    const restored = restoreBidHelperState(undefined, encoded());
    expect(restored.fields).toEqual(edited);
    expect(restored.seed).toEqual(seed);
    expect(restoreBidHelperState(undefined, serializeBidHelperState(restored))).toEqual(restored);
  });

  it('preserves empty and zero input strings without adding notice attribution', () => {
    const restored = restoreBidHelperState(undefined, serializeBidHelperState({ fields: edited }));
    expect(restored.fields.plannedPrice).toBe('');
    expect(restored.fields.bidAmount).toBe('0');
    expect(restored.seed).toBeUndefined();
    const zeroSeed = restoreBidHelperState({ ...seed, baseAmount: 0, rangeMin: 0, rangeMax: 0, aApplied: false }, null);
    expect(zeroSeed.fields.baseAmount).toBe('0');
    expect(zeroSeed.fields.aValue).toBe('0');
    expect(zeroSeed.fields.rangeMin).toBe('0');
    expect(zeroSeed.fields.rangeMax).toBe('0');
  });

  it('rejects an invalid stored seed without restoring misattributed edited fields', () => {
    for (const invalidSeed of [{ ...seed, aValue: -1 }, { ...seed, aValue: '100' }, { ...seed, aValue: 100, aApplied: false }, { ...seed, revision: '../../' }, { ...seed, baseAmount: -1 }, null]) {
      const restored = restoreBidHelperState(undefined, encoded(edited, invalidSeed));
      expect(restored.fields.aValue).toBe('');
      expect(restored.fields.baseAmount).toBe('');
      expect(restored.seed).toBeUndefined();
    }
    expect(restoreBidHelperState(seed, encoded(edited, { ...seed, aValue: -1 })).fields.aValue).toBe('');
  });

  it('falls back safely on malformed, oversized, legacy, or nonexact field data', () => {
    const { aValue: _removed, ...missing } = edited;
    const rawValues = ['{broken', JSON.stringify(edited), ' '.repeat(20_001), JSON.stringify({ version: 2, fields: edited }),
      encoded({ ...edited, unexpected: '100' }), encoded(missing), encoded({ ...edited, aValue: 0 }),
      encoded({ ...edited, aValue: '1'.repeat(61) }), encoded({ ...edited, aValue: '10\u0000' })];
    for (const raw of rawValues) {
      const restored = restoreBidHelperState(undefined, raw);
      expect(restored.fields.baseAmount).toBe('');
      expect(restored.fields.noticeRate).toBe('100');
      expect(restored.seed).toBeUndefined();
    }
  });

  it('does not serialize invalid fields or invalid notice metadata over a valid draft', () => {
    expect(() => serializeBidHelperState({ fields: { ...edited, aValue: '1'.repeat(61) }, seed })).toThrow();
    expect(() => serializeBidHelperState({ fields: edited, seed: { ...seed, lowerRate: -1 } })).toThrow();
  });
});
