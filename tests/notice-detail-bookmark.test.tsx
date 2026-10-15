import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoticeDetailBookmark, toggleDetailBookmark } from '../src/live/NoticeDetailPage';
import { emptyMemberWorkspace } from '../src/member/workspace';
import type { MemberWorkspaceAccess } from '../src/member/useMemberWorkspace';
import { NOTICES } from '../src/data';

const bid = { ...NOTICES[0], source: 'live' as const, title: '저장할 실제 철거 공고' };
function member(patch: Partial<MemberWorkspaceAccess> = {}): MemberWorkspaceAccess {
  return {
    configured: true, loading: false, user: { id: 'member' } as MemberWorkspaceAccess['user'],
    workspace: emptyMemberWorkspace('member'), ready: true, saveStatus: 'saved', error: null,
    authMessage: '', recoveryMode: false, signIn: async () => true, signUp: async () => true,
    requestPasswordReset: async () => true, updatePassword: async () => true, signOut: async () => true,
    updateWorkspace: () => {}, retrySave: async () => true, retryLoad: async () => {}, downloadDraftAndReload: async () => {},
    ...patch,
  };
}

describe('standalone notice bookmark', () => {
  it('saves the full displayed notice without replacing existing favorites or preparation records', () => {
    const current = emptyMemberWorkspace('member');
    current.bookmarks = ['other'];
    current.noticeSnapshots.other = { ...bid, id: 'other', title: '기존 저장 공고' };
    current.preparations[bid.id] = { stage: '준비중', note: '면허 확인', updatedAt: '2026-10-15' };
    const saved = toggleDetailBookmark(current, bid, 'member');
    expect(saved.bookmarks).toEqual(['other', bid.id]);
    expect(saved.noticeSnapshots[bid.id]).toEqual(bid);
    expect(saved.noticeSnapshots.other.title).toBe('기존 저장 공고');
    expect(saved.preparations[bid.id].note).toBe('면허 확인');
    expect(current.bookmarks).toEqual(['other']);
  });

  it('removes a favorite while keeping its saved detail and bid preparation record', () => {
    const current = emptyMemberWorkspace('member');
    current.bookmarks = [bid.id, bid.id, 'other'];
    current.noticeSnapshots[bid.id] = bid;
    current.preparations[bid.id] = { stage: '준비중', note: '서류 준비', updatedAt: '2026-10-15' };
    const removed = toggleDetailBookmark(current, bid, 'member');
    expect(removed.bookmarks).toEqual(['other']);
    expect(removed.noticeSnapshots[bid.id].title).toBe('저장할 실제 철거 공고');
    expect(removed.preparations[bid.id].note).toBe('서류 준비');
  });

  it('rejects a stale account or a titleless fallback notice', () => {
    const current = emptyMemberWorkspace('member');
    expect(toggleDetailBookmark(current, bid, 'someone-else')).toBe(current);
    expect(toggleDetailBookmark(current, { ...bid, title: '' }, 'member')).toBe(current);
  });

  it('shows login guidance for guests without exposing a stale member favorite', () => {
    const stale = emptyMemberWorkspace('member'); stale.bookmarks = [bid.id];
    const html = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member({ user: null, workspace: stale, ready: false })} />);
    expect(html).toContain('즐겨찾기');
    expect(html).toContain('href="/#account"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('클라우드 저장 완료');
  });

  it('distinguishes a pending or failed save from cloud completion and provides recovery', () => {
    const workspace = emptyMemberWorkspace('member'); workspace.bookmarks = [bid.id];
    const saving = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member({ workspace, saveStatus: 'saving' })} />);
    expect(saving).toContain('저장 중');
    expect(saving).not.toContain('클라우드 저장 완료');
    const failed = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member({ workspace, saveStatus: 'error', error: '서버에 저장하지 못했습니다.' })} />);
    expect(failed).toContain('서버에 저장하지 못했습니다.');
    expect(failed).toContain('다시 저장');
    expect(failed).not.toContain('클라우드 저장 완료');
    const saved = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member({ workspace })} />);
    expect(saved).toContain('클라우드 저장 완료');
    expect(saved).toContain('href="/#bookmarks"');
  });

  it('disables saving while loading the member or when only a fallback detail is available', () => {
    const loading = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member({ ready: false, loading: true, saveStatus: 'loading' })} />);
    expect(loading).toContain('disabled=""');
    expect(loading).toContain('불러오는 중');
    const fallback = renderToStaticMarkup(<NoticeDetailBookmark bid={bid} member={member()} available={false} />);
    expect(fallback).toContain('disabled=""');
    expect(fallback).toContain('공고 기본정보');
  });
});
