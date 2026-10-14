import { describe, expect, it, vi } from 'vitest';
import { emptyMemberWorkspace, mergeNoticeDetail, MemberWorkspaceController, validateWorkspace, WorkspaceConflict, type DraftStorage, type MemberWorkspace, type WorkspaceRepository } from '../src/member/workspace';
import { NOTICES } from '../src/data';
import type { G2bNoticeDetail } from '../src/g2b-types';

function storage(): DraftStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}
function repo(): WorkspaceRepository { return { load: vi.fn(async () => null), save: vi.fn(async () => 'stamp-1') }; }
const name = (value: string) => (current: MemberWorkspace): MemberWorkspace => ({ ...current, profile: { ...current.profile, companyName: value } });

describe('member workspace isolation and persistence', () => {
  it('starts each real member with a blank profile and no demo bookmarks', () => {
    const workspace = emptyMemberWorkspace('member-a', 'a@example.com');
    expect(workspace.profile).toEqual({ id: 'member-a', companyName: '', province: '', district: '', address: '', licenses: [], contactName: '', email: 'a@example.com' });
    expect(workspace.bookmarks).toEqual([]);
    expect(workspace.preparations).toEqual({});
    expect(workspace.noticeSnapshots).toEqual({});
  });
  it('rejects data for another account and malformed workspace data', () => {
    expect(() => validateWorkspace(emptyMemberWorkspace('a'), 'b')).toThrow();
    expect(() => validateWorkspace({ ...emptyMemberWorkspace('a'), bookmarks: [1] }, 'a')).toThrow();
    expect(() => validateWorkspace({ ...emptyMemberWorkspace('a'), preparations: { id: { stage: '실제제출됨', note: '', updatedAt: '' } } }, 'a')).toThrow();
  });
  it('accepts old profiles without a business number but rejects invalid supplied values', () => {
    const oldWorkspace = emptyMemberWorkspace('a');
    expect(validateWorkspace(oldWorkspace, 'a').profile.businessNumber).toBeUndefined();
    for (const businessNumber of [null, 1234567890, '123', '123a4567890']) {
      expect(() => validateWorkspace({ ...oldWorkspace, profile: { ...oldWorkspace.profile, businessNumber } }, 'a')).toThrow('Invalid workspace');
    }
  });
  it('saves and restores a normalized business number without changing the member profile or other account', async () => {
    let saved: MemberWorkspace | null = null;
    const repository = repo();
    repository.save = vi.fn(async (_userId, data) => { saved = structuredClone(data); return 'saved'; });
    const controller = new MemberWorkspaceController('a', 'a@example.com', repository, storage());
    await controller.load();
    controller.update(current => ({ ...current, profile: { ...current.profile, companyName: '서울 업체', province: '서울특별시', licenses: ['철거'], businessNumber: '001-02-00003' } }));
    expect(await controller.flush()).toBe(true);
    expect(saved!.profile).toMatchObject({ id: 'a', companyName: '서울 업체', province: '서울특별시', licenses: ['철거'], email: 'a@example.com', businessNumber: '0010200003' });
    repository.load = vi.fn(async () => ({ data: saved!, updatedAt: 'saved' }));
    const restored = new MemberWorkspaceController('a', '', repository, storage());
    await restored.load();
    expect(restored.getSnapshot().data?.profile.businessNumber).toBe('0010200003');
    expect(() => validateWorkspace(saved, 'b')).toThrow('Invalid workspace');
  });
  it('keeps usable saved notices and rejects malformed snapshots that would break filters', () => {
    const notice = NOTICES[0];
    const source = { ...emptyMemberWorkspace('a'), noticeSnapshots: { [notice.id]: notice, malformed: { id: 'malformed', title: 'Broken', documents: [] } } };
    const restored = validateWorkspace(source, 'a');
    expect(Object.keys(restored.noticeSnapshots)).toEqual([notice.id]);
    expect(restored.noticeSnapshots[notice.id]).toEqual(notice);
  });
  it('enriches a saved notice even outside current search while retaining unverified fields', () => {
    const notice = { ...NOTICES[0], allowedRegions: ['서울특별시'], licenses: ['기존 면허'] };
    const detail: G2bNoticeDetail = { number: notice.number, revision: notice.revision, allowedRegions: ['경기도'], licenses: [], regionComplete: true, licenseComplete: false, fetchedAt: '', warnings: [] };
    const enriched = mergeNoticeDetail(notice, detail);
    expect(enriched.allowedRegions).toEqual(['경기도']);
    expect(enriched.licenses).toEqual(['기존 면허']);
    expect(mergeNoticeDetail(enriched, detail)).toBe(enriched);
    expect(mergeNoticeDetail(notice, { ...detail, number: 'OTHER' })).toBe(notice);
  });
  it('queues writes serially and sends the newest edit using the preceding server version', async () => {
    const first = deferred<string>();
    const repository = repo();
    repository.save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('stamp-2');
    const controller = new MemberWorkspaceController('a', '', repository, storage());
    await controller.load();
    controller.update(name('First'));
    controller.update(name('Second'));
    controller.update(name('Latest'));
    expect(repository.save).toHaveBeenCalledTimes(1);
    first.resolve('stamp-1');
    expect(await controller.flush()).toBe(true);
    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repository.save).mock.calls[1].slice(0, 3)).toEqual(['a', expect.objectContaining({ profile: expect.objectContaining({ companyName: 'Latest' }) }), 'stamp-1']);
    expect(controller.getSnapshot().status).toBe('saved');
    expect(controller.hasUnsavedChanges()).toBe(false);
  });
  it('preserves failed edits in the current screen and account-specific browser draft until retry succeeds', async () => {
    const repository = repo();
    repository.save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('saved');
    const disk = storage();
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load();
    controller.update(name('Unsaved Company'));
    expect(await controller.flush()).toBe(false);
    expect(controller.getSnapshot().data?.profile.companyName).toBe('Unsaved Company');
    expect(controller.getSnapshot().status).toBe('error');
    expect(disk.getItem(controller.draftKey)).toContain('Unsaved Company');
    expect(await controller.flush()).toBe(true);
    expect(disk.getItem(controller.draftKey)).toBeNull();
  });
  it('recovers an interrupted save but waits for explicit retry before writing', async () => {
    const repository = repo(); const disk = storage();
    disk.setItem('construction-bid.member-draft.v1.a', JSON.stringify({ data: name('Recovered')(emptyMemberWorkspace('a')), baseUpdatedAt: null }));
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load();
    expect(controller.getSnapshot().status).toBe('recovery');
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getSnapshot().data?.profile.companyName).toBe('Recovered');
    expect(repository.save).not.toHaveBeenCalled();
    await controller.flush();
    expect(repository.save).toHaveBeenCalledTimes(1);
  });
  it('does not read another account’s draft or the existing demo storage', async () => {
    const disk = storage();
    disk.setItem('construction-bid.member-draft.v1.a', JSON.stringify({ data: name('A secret')(emptyMemberWorkspace('a')), baseUpdatedAt: null }));
    disk.setItem('construction-bid.prototype.v1', 'existing prototype data');
    const controller = new MemberWorkspaceController('b', '', repo(), disk);
    await controller.load();
    expect(controller.getSnapshot().data?.profile.companyName).toBe('');
    expect(disk.getItem('construction-bid.prototype.v1')).toBe('existing prototype data');
    expect(disk.getItem('construction-bid.member-draft.v1.a')).toContain('A secret');
  });
  it('blocks stale draft overwrite when the server has changed on another device', async () => {
    const repository = repo(); const disk = storage();
    repository.load = vi.fn(async () => ({ data: name('New cloud')(emptyMemberWorkspace('a')), updatedAt: 'new-stamp' }));
    disk.setItem('construction-bid.member-draft.v1.a', JSON.stringify({ data: name('Old draft')(emptyMemberWorkspace('a')), baseUpdatedAt: 'old-stamp' }));
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load();
    expect(controller.getSnapshot().ready).toBe(false);
    expect(await controller.flush()).toBe(false);
    controller.update(name('Overwrite attempt'));
    expect(repository.save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().data?.profile.companyName).toBe('Old draft');
    await controller.reloadCloudAfterBackup();
    expect(controller.getSnapshot().data?.profile.companyName).toBe('New cloud');
    expect(controller.getSnapshot().ready).toBe(true);
  });
  it('retains the draft and stops edits when an optimistic write detects a conflict', async () => {
    const repository = repo(); const disk = storage();
    repository.save = vi.fn(async () => { throw new WorkspaceConflict(); });
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load(); controller.update(name('Draft'));
    expect(await controller.flush()).toBe(false);
    expect(controller.getSnapshot().ready).toBe(false);
    expect(disk.getItem(controller.draftKey)).toContain('Draft');
  });
  it('ignores late load responses after logout and aborts the request', async () => {
    const load = deferred<null>(); const repository = repo();
    repository.load = vi.fn(() => load.promise);
    const controller = new MemberWorkspaceController('a', '', repository, storage());
    const pending = controller.load();
    const listener = vi.fn(); controller.subscribe(listener);
    controller.dispose(); load.resolve(null); await pending;
    expect(listener).not.toHaveBeenCalled();
    expect(controller.getSnapshot().data).toBeNull();
    expect(vi.mocked(repository.load).mock.calls[0][1].aborted).toBe(true);
  });
  it('does not flush a queued edit after the account is disposed, and preserves the latest draft', async () => {
    const first = deferred<string>(); const repository = repo(); const disk = storage();
    repository.save = vi.fn(() => first.promise);
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load(); controller.update(name('First')); controller.update(name('Latest'));
    controller.dispose(); first.resolve('stamp');
    expect(await controller.flush()).toBe(false);
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(disk.getItem(controller.draftKey)).toContain('Latest');
  });
  it('never overwrites cloud data after load failure and surfaces unavailable draft storage', async () => {
    const repository = repo();
    repository.load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    repository.save = vi.fn(async () => { throw new Error('offline'); });
    const disk = storage(); disk.setItem = () => { throw new Error('quota'); };
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load(); controller.update(name('Must not save'));
    expect(repository.save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().ready).toBe(false);
    await controller.load(); controller.update(name('Memory draft')); await controller.flush();
    expect(controller.getSnapshot().error).toContain('임시저장 공간');
    expect(controller.getSnapshot().data?.profile.companyName).toBe('Memory draft');
  });
  it('preserves malformed draft bytes while displaying valid cloud data', async () => {
    const disk = storage(); const repository = repo();
    disk.setItem('construction-bid.member-draft.v1.a', '{broken');
    const controller = new MemberWorkspaceController('a', '', repository, disk);
    await controller.load();
    expect(controller.getSnapshot().error).toContain('원본을 보존');
    expect(disk.getItem(controller.draftKey)).toBe('{broken');
  });
});
