import { renderToStaticMarkup } from 'react-dom/server';
import { Children, isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { BidDetail, resolveDisplayedBid } from '../src/components/BidDetail';
import { DEMO_PROFILES, NOTICES } from '../src/data';
import { historicNoticeForDetail, NoticeNumberResults } from '../src/live/NoticeNumberLookup';
import { buildNoticeNumberResult } from '../src/live/notice-number-search';
import { mergeNoticeDetail } from '../src/member/workspace';
import { NOTICE_REVISION_CONTEXT, type BidNotice } from '../src/types';
import type { G2bNoticeDetail } from '../src/g2b-types';

const original: BidNotice = { ...NOTICES[0], id: 'g2b:공사:R26BK01359594:000', number: 'R26BK01359594', revision: '000',
  type: '공사', source: 'live', status: '접수중', noticeKind: '등록공고', deadline: '2027-03-04T10:00:00+09:00',
  openingAt: '2027-03-04T11:00:00+09:00', biddingStartAt: '2026-02-27T10:00:00+09:00' };
const latest: BidNotice = { ...original, id: 'g2b:공사:R26BK01359594:001', revision: '001', status: '취소', noticeKind: '취소공고' };
const detail: G2bNoticeDetail = { number: original.number, revision: '000', notice: { ...original, title: 'API 원본 공고명' },
  regionComplete: true, licenseComplete: true, allowedRegions: ['전국'], licenses: ['철거'], fetchedAt: '', warnings: [] };
const render = (bid: BidNotice) => renderToStaticMarkup(<BidDetail bid={bid} profile={DEMO_PROFILES[0]}
  assessment={{ status: 'review', reason: '' }} isBookmarked={false} onClose={() => {}} onToggleBookmark={() => {}}
  now={Date.parse('2026-10-15T12:00:00+09:00')} />);

describe('historical revision detail context', () => {
  it('attaches latest-revision context only to historical details without changing original schedule or status', () => {
    const selected = historicNoticeForDetail(original, latest);
    expect(selected[NOTICE_REVISION_CONTEXT]).toEqual({ latestRevision: '001', latestStatus: '취소', latestNoticeKind: '취소공고' });
    expect(selected.status).toBe('접수중'); expect(selected.deadline).toBe(original.deadline);
    expect(original[NOTICE_REVISION_CONTEXT]).toBeUndefined();
    expect(historicNoticeForDetail(latest, latest)).toBe(latest);
  });
  it('keeps context when the fetched original notice replaces the selected object and member detail enrichment spreads it', () => {
    const selected = historicNoticeForDetail(original, latest), enriched = mergeNoticeDetail(selected, detail);
    expect(enriched[NOTICE_REVISION_CONTEXT]).toEqual(selected[NOTICE_REVISION_CONTEXT]);
    const displayed = resolveDisplayedBid(enriched, { bidId: original.id, data: detail });
    expect(displayed.bid.title).toBe('API 원본 공고명');
    expect(displayed.bid[NOTICE_REVISION_CONTEXT]).toEqual(selected[NOTICE_REVISION_CONTEXT]);
    expect(displayed.bid.status).toBe('접수중'); expect(displayed.bid.deadline).toBe(original.deadline);
    expect(render(displayed.bid)).toContain('최신 001차수 · 취소공고');
  });
  it('does not serialize transient context into bookmarks, drafts, or workspace snapshots', () => {
    const selected = historicNoticeForDetail(original, latest);
    expect(structuredClone(selected)[NOTICE_REVISION_CONTEXT]).toBeUndefined();
    expect(JSON.stringify(selected)).not.toContain('latestRevision');
    expect({ ...selected }[NOTICE_REVISION_CONTEXT]).toBeDefined();
  });
  it('passes context through the actual historical detail action while leaving the latest action unchanged', () => {
    const group = buildNoticeNumberResult({ items: [original, latest], totalCount: 2, page: 1, pageSize: 999,
      hasMore: false, source: '나라장터', fetchedAt: '' }, { number: original.number, revision: '000' }, '공사')!;
    const opened: BidNotice[] = [];
    const tree = NoticeNumberResults({ snapshot: { userId: 'a', loading: false, attempted: true,
      query: { number: original.number, revision: '000' }, groups: [group], errors: [], error: '' },
      bookmarks: [], onBookmark: () => {}, onOpen: notice => opened.push(notice) });
    function action(node: ReactNode, label: string): (() => void) | undefined {
      let found: (() => void) | undefined;
      Children.forEach(node, child => {
        if (found || !isValidElement(child)) return;
        const props = child.props as { children?: ReactNode; 'aria-label'?: string; onClick?: () => void };
        found = props['aria-label'] === label ? props.onClick : action(props.children, label);
      });
      return found;
    }
    action(tree, `${original.number}-000 이전 차수 상세보기`)?.();
    action(tree, `${original.number}-001 최신 차수 상세보기`)?.();
    expect(opened).toHaveLength(2);
    expect(opened[0][NOTICE_REVISION_CONTEXT]?.latestStatus).toBe('취소');
    expect(opened[0].revision).toBe('000'); expect(opened[0].status).toBe('접수중');
    expect(opened[1][NOTICE_REVISION_CONTEXT]).toBeUndefined();
  });
  it('shows an old revision badge and a latest-cancellation warning immediately without a green current-state badge', () => {
    const html = render(historicNoticeForDetail(original, latest));
    expect(html).toContain('이전 000차수'); expect(html).toContain('최신 001차수 · 취소공고');
    expect(html).toContain('이전 차수의 기록'); expect(html).not.toContain('class="nl-state is-active"');
    expect(html).toContain('revision=001'); expect(html).toContain('최신 차수 넓은 화면으로 보기');
  });
  it('does not label an old revision current when the latest revision is a changed active notice either', () => {
    const html = render(historicNoticeForDetail(original, { ...latest, status: '접수중', noticeKind: '변경공고' }));
    expect(html).toContain('최신 001차수 · 변경공고'); expect(html).not.toContain('class="nl-state is-active"');
  });
  it('leaves the usual current-notice status unchanged', () => {
    const html = render(original); expect(html).toContain('class="nl-state is-active"');
    expect(html).not.toContain('이전 차수의 기록');
  });
});
