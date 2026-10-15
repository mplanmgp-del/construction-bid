import {describe,expect,it} from 'vitest';
import {toggleNoticeBookmark} from '../src/member/bookmarks';
import {emptyMemberWorkspace,validateWorkspace} from '../src/member/workspace';
import {NOTICES} from '../src/data';
describe('notice bookmarks shared by search and alerts',()=>{
  it('saves a full notice snapshot even when the notice is outside the current search results',()=>{
    const current=emptyMemberWorkspace('member');const notice={...NOTICES[0],id:'alert-only'};const saved=toggleNoticeBookmark(current,notice);
    expect(saved.bookmarks).toEqual(['alert-only']);expect(saved.noticeSnapshots['alert-only']).toEqual(notice);expect(current.bookmarks).toEqual([]);expect(current.noticeSnapshots).toEqual({});expect(validateWorkspace(saved,'member')).toEqual(saved);
  });
  it('removes only the selected bookmark and keeps unrelated notices and account settings',()=>{
    const current=emptyMemberWorkspace('member');current.preferences.autoRegion=true;const one=NOTICES[0],other={...NOTICES[0],id:'other'};
    const both=toggleNoticeBookmark(toggleNoticeBookmark(current,one),other);const removed=toggleNoticeBookmark(both,one);
    expect(removed.bookmarks).toEqual(['other']);expect(removed.noticeSnapshots[one.id]).toBeUndefined();expect(removed.noticeSnapshots.other).toEqual(other);expect(removed.profile).toEqual(current.profile);expect(removed.preferences).toEqual(current.preferences);
  });
  it('retains preparation records and their notice snapshot when unbookmarking',()=>{
    const notice=NOTICES[0];const current=toggleNoticeBookmark(emptyMemberWorkspace('member'),notice);current.preparations[notice.id]={stage:'준비중',note:'검토 내용',updatedAt:'2026-10-15T03:00:00Z'};
    const removed=toggleNoticeBookmark(current,notice);expect(removed.bookmarks).toEqual([]);expect(removed.preparations).toEqual(current.preparations);expect(removed.noticeSnapshots[notice.id]).toEqual(notice);
  });
});
