import type { BidNotice } from '../types';
import type { MemberWorkspace } from './workspace';

export function toggleNoticeBookmark(workspace: MemberWorkspace, notice: BidNotice): MemberWorkspace {
  const saved = workspace.bookmarks.includes(notice.id);
  const noticeSnapshots = { ...workspace.noticeSnapshots };
  if (saved && !workspace.preparations[notice.id]) delete noticeSnapshots[notice.id];
  else if (!saved) noticeSnapshots[notice.id] = notice;
  return { ...workspace, noticeSnapshots, bookmarks: saved ? workspace.bookmarks.filter(id => id !== notice.id) : [...workspace.bookmarks, notice.id] };
}
