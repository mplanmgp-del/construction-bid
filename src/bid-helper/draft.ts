import { isBidHelperSeed, type BidHelperSeed } from './notice-seed';

export type BidHelperFields = Record<'baseAmount' | 'aValue' | 'lowerRate' | 'plannedPrice' | 'bidAmount' | 'noticeRate' | 'targetRate' | 'rangeMin' | 'rangeMax', string>;
export const EMPTY_FIELDS: BidHelperFields = {
  baseAmount: '', aValue: '', lowerRate: '', plannedPrice: '', bidAmount: '',
  noticeRate: '100', targetRate: '', rangeMin: '-3', rangeMax: '3',
};
export type BidHelperState = { fields: BidHelperFields; seed?: BidHelperSeed };
const MAX_DRAFT_LENGTH = 20_000;
const fieldKeys = Object.keys(EMPTY_FIELDS) as Array<keyof BidHelperFields>;

function validFields(value: unknown): value is BidHelperFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === fieldKeys.length && fieldKeys.every(key =>
    typeof row[key] === 'string' && row[key].length <= 60 && !/[\u0000-\u001f\u007f]/.test(row[key]));
}

function seededFields(seed?: BidHelperSeed): BidHelperFields {
  if (!seed) return { ...EMPTY_FIELDS };
  return {
    ...EMPTY_FIELDS,
    baseAmount: seed.baseAmount === undefined ? '' : seed.baseAmount.toLocaleString('ko-KR'),
    lowerRate: seed.lowerRate?.toString() ?? '',
    targetRate: seed.lowerRate?.toString() ?? '',
    aValue: seed.aApplied === false ? '0' : '',
    rangeMin: seed.rangeMin?.toString() ?? '-3',
    rangeMax: seed.rangeMax?.toString() ?? '3',
  };
}

function noticeFingerprint(seed: BidHelperSeed): string {
  return JSON.stringify([
    seed.noticeId, seed.number, seed.revision,
    seed.baseAmount, seed.lowerRate, seed.netCost, seed.rangeMin, seed.rangeMax, seed.aApplied,
  ]);
}

function copyState(fields: BidHelperFields, seed?: BidHelperSeed): BidHelperState {
  return { fields: { ...fields }, ...(seed ? { seed: { ...seed, notes: [...seed.notes] } } : {}) };
}

function parseDraft(raw: string | null): BidHelperState | undefined {
  if (!raw || raw.length > MAX_DRAFT_LENGTH) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.version !== 1 || Object.keys(envelope).some(key => !['version', 'fields', 'seed'].includes(key))
      || !validFields(envelope.fields) || ('seed' in envelope && !isBidHelperSeed(envelope.seed))) return undefined;
    return copyState(envelope.fields, envelope.seed as BidHelperSeed | undefined);
  } catch { return undefined; }
}

/** Reuse edits only for the same notice and the same disclosed calculation inputs. */
export function restoreBidHelperState(explicitSeed: BidHelperSeed | undefined, rawDraft: string | null): BidHelperState {
  if (explicitSeed !== undefined && !isBidHelperSeed(explicitSeed)) return copyState(EMPTY_FIELDS);
  const draft = parseDraft(rawDraft);
  if (!explicitSeed) return draft ?? copyState(EMPTY_FIELDS);
  if (draft?.seed && noticeFingerprint(draft.seed) === noticeFingerprint(explicitSeed)) return copyState(draft.fields, explicitSeed);
  return copyState(seededFields(explicitSeed), explicitSeed);
}

export function serializeBidHelperState(state: BidHelperState): string {
  if (!validFields(state.fields) || (state.seed !== undefined && !isBidHelperSeed(state.seed))) throw new Error('투찰 도우미 임시저장 형식이 올바르지 않습니다.');
  const encoded = JSON.stringify({ version: 1, ...copyState(state.fields, state.seed) });
  if (encoded.length > MAX_DRAFT_LENGTH) throw new Error('투찰 도우미 임시저장 내용이 너무 큽니다.');
  return encoded;
}
