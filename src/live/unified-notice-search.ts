import type { NoticeQuery } from './notice-search';
import { indexedSearchDateError } from './indexed-notice-search';
import { parseNoticeNumberInput, type NoticeNumberType } from './notice-number-search';

export type NoticeSearchKind = 'title' | 'number';
export type NoticeSearchTarget = 'auto' | NoticeSearchKind;
export interface UnifiedSearchDraft { query: NoticeQuery; target: NoticeSearchTarget; owner: string | null; resetKey?: number }
export type UnifiedNoticeSearchPlan = { kind: 'title'; query: NoticeQuery }
  | { kind: 'number'; input: string; type: NoticeNumberType };

/** The number parser also accepts English words; only familiar identities are automatic. */
export function noticeSearchKind(input: string, target: NoticeSearchTarget): NoticeSearchKind {
  if (target !== 'auto') return target;
  return /^(?:R\d{2}[A-Z]{2}\d{8}|\d{11})(?:-[^\s]*)?$/i.test(input.trim()) ? 'number' : 'title';
}

/** Keep pending public edits while removing another account's explicit number search. */
export function reconcileUnifiedSearchDraft(previous: UnifiedSearchDraft, before: NoticeQuery, query: NoticeQuery, owner: string | null, resetKey?: number): UnifiedSearchDraft {
  if (previous.resetKey !== resetKey) return { owner, resetKey, query: { ...query, keyword: '' }, target: 'auto' };
  const privateDraft = previous.owner !== null && previous.owner !== owner && noticeSearchKind(previous.query.keyword, previous.target) === 'number';
  return { owner, resetKey, target: privateDraft ? 'auto' : previous.target, query: {
    type: previous.query.type === before.type ? query.type : previous.query.type,
    from: previous.query.from === before.from ? query.from : previous.query.from,
    to: previous.query.to === before.to ? query.to : previous.query.to,
    keyword: privateDraft ? '' : previous.query.keyword === before.keyword ? query.keyword : previous.query.keyword,
  } };
}

export function planUnifiedNoticeSearch(input: string, target: NoticeSearchTarget, query: NoticeQuery): UnifiedNoticeSearchPlan {
  const keyword = input.trim();
  if (!['공사', '용역', '공사·용역'].includes(query.type)) throw new Error('업무 구분을 확인해 주세요.');
  if (noticeSearchKind(keyword, target) === 'number') {
    parseNoticeNumberInput(keyword);
    return { kind: 'number', input: keyword, type: query.type };
  }
  const error = indexedSearchDateError(query.from, query.to);
  if (error) throw new Error(`제출마감 기간: ${error}`);
  if (keyword.length > 100 || /[\u0000-\u001f]/.test(keyword)) throw new Error('검색어는 100자 이내로 입력해 주세요.');
  return { kind: 'title', query: { ...query, keyword } };
}
