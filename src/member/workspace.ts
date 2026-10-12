import type { BidNotice, CompanyProfile } from '../types';
import type { G2bNoticeDetail } from '../g2b-types';

export const PREPARATION_STAGES = ['검토중', '준비중', '제출완료(직접확인)', '보류'] as const;
export interface BidPreparationRecord {
  stage: typeof PREPARATION_STAGES[number];
  note: string;
  updatedAt: string;
}
export interface MemberWorkspace {
  version: 1;
  profile: CompanyProfile;
  bookmarks: string[];
  preferences: { autoRegion: boolean };
  preparations: Record<string, BidPreparationRecord>;
  noticeSnapshots: Record<string, BidNotice>;
}
export interface WorkspaceRecord { data: MemberWorkspace; updatedAt: string | null; }
export interface WorkspaceRepository {
  load(userId: string, signal: AbortSignal): Promise<WorkspaceRecord | null>;
  save(userId: string, data: MemberWorkspace, expectedUpdatedAt: string | null, signal: AbortSignal): Promise<string>;
}
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
export type SaveStatus = 'loading' | 'saved' | 'saving' | 'error' | 'recovery';
export interface WorkspaceSnapshot { data: MemberWorkspace | null; status: SaveStatus; error: string | null; ready: boolean; }
export class WorkspaceConflict extends Error {}

export function mergeNoticeDetail(notice: BidNotice, detail: G2bNoticeDetail): BidNotice {
  if (notice.number !== detail.number || notice.revision !== detail.revision) return notice;
  const allowedRegions = detail.regionComplete ? detail.allowedRegions : notice.allowedRegions;
  const licenses = detail.licenseComplete ? detail.licenses : notice.licenses;
  if (JSON.stringify(allowedRegions) === JSON.stringify(notice.allowedRegions) && JSON.stringify(licenses) === JSON.stringify(notice.licenses)) return notice;
  return { ...notice, allowedRegions, licenses };
}

export function emptyMemberWorkspace(userId: string, email = ''): MemberWorkspace {
  return {
    version: 1,
    profile: { id: userId, companyName: '', province: '', district: '', address: '', licenses: [], contactName: '', email },
    bookmarks: [], preferences: { autoRegion: true }, preparations: {}, noticeSnapshots: {},
  };
}

function validNoticeSnapshot(value: unknown): value is BidNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as BidNotice;
  const strings = ['id', 'number', 'revision', 'title', 'agency', 'category', 'province', 'district', 'contractMethod', 'status', 'postedAt', 'deadline', 'openingAt', 'registrationDeadline', 'duration', 'description'] as const;
  const stringArray = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  return strings.every(key => typeof notice[key] === 'string') && ['공사', '용역'].includes(notice.type) && typeof notice.revised === 'boolean'
    && (notice.allowedRegions === null || stringArray(notice.allowedRegions))
    && (notice.estimatedPrice === null || (typeof notice.estimatedPrice === 'number' && Number.isFinite(notice.estimatedPrice) && notice.estimatedPrice >= 0))
    && stringArray(notice.licenses) && stringArray(notice.requirements)
    && Array.isArray(notice.documents) && notice.documents.every(item => item && typeof item.name === 'string' && typeof item.size === 'string' && (item.url === undefined || typeof item.url === 'string'))
    && (notice.detailUrl === undefined || typeof notice.detailUrl === 'string');
}

export function validateWorkspace(value: unknown, userId: string): MemberWorkspace {
  if (!value || typeof value !== 'object') throw new Error('Invalid workspace');
  const data = value as MemberWorkspace;
  const profile = data.profile;
  if (data.version !== 1 || !profile || profile.id !== userId ||
    !['companyName', 'province', 'district', 'address', 'contactName', 'email'].every(key => typeof profile[key as keyof CompanyProfile] === 'string') ||
    !Array.isArray(profile.licenses) || !profile.licenses.every(item => typeof item === 'string') ||
    !Array.isArray(data.bookmarks) || !data.bookmarks.every(item => typeof item === 'string') ||
    typeof data.preferences?.autoRegion !== 'boolean' || !data.preparations || typeof data.preparations !== 'object' || Array.isArray(data.preparations) ||
    !Object.values(data.preparations).every(item => item && PREPARATION_STAGES.includes(item.stage) && typeof item.note === 'string' && typeof item.updatedAt === 'string')) {
    throw new Error('Invalid workspace');
  }
  const noticeSnapshots = data.noticeSnapshots && typeof data.noticeSnapshots === 'object' && !Array.isArray(data.noticeSnapshots)
    ? Object.fromEntries(Object.entries(data.noticeSnapshots).filter(([key, item]) => validNoticeSnapshot(item) && item.id === key))
    : {};
  return structuredClone({ ...data, noticeSnapshots });
}

/** One controller belongs to one authenticated user; dispose it on account changes. */
export class MemberWorkspaceController {
  private snapshot: WorkspaceSnapshot = { data: null, status: 'loading', error: null, ready: false };
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private disposed = false;
  private revision = 0;
  private savedRevision = 0;
  private updatedAt: string | null = null;
  private saving: Promise<boolean> | null = null;
  private loaded = false;
  private loadSequence = 0;
  private draftWarning: string | null = null;
  readonly draftKey: string;

  constructor(readonly userId: string, private email: string, private repository: WorkspaceRepository, private storage?: DraftStorage) {
    this.draftKey = `construction-bid.member-draft.v1.${userId}`;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit(patch: Partial<WorkspaceSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private saveDraft() {
    if (!this.storage) { this.draftWarning = '브라우저 임시저장이 불가능합니다. 저장이 완료될 때까지 이 화면을 유지해 주세요.'; return; }
    try {
      this.storage.setItem(this.draftKey, JSON.stringify({ data: this.snapshot.data, baseUpdatedAt: this.updatedAt }));
      this.draftWarning = null;
    } catch { this.draftWarning = '임시저장 공간이 부족합니다. 저장이 완료될 때까지 이 화면을 유지해 주세요.'; }
  }
  async load(): Promise<void> {
    if (this.disposed || this.saving) return;
    const sequence = ++this.loadSequence;
    this.loaded = false;
    this.emit({ status: 'loading', error: null, ready: false });
    try {
      const record = await this.repository.load(this.userId, this.abort.signal);
      if (this.disposed || sequence !== this.loadSequence) return;
      const cloudData = record ? validateWorkspace(record.data, this.userId) : emptyMemberWorkspace(this.userId, this.email);
      const rawDraft = this.storage?.getItem(this.draftKey);
      let data = cloudData;
      let recovered = false;
      let recoveryError: string | null = null;
      if (rawDraft) {
        try {
          const draft = JSON.parse(rawDraft);
          data = validateWorkspace(draft.data, this.userId);
          recovered = true;
          // Never replace newer server content with an old browser draft automatically.
          recoveryError = draft.baseUpdatedAt === (record?.updatedAt ?? null)
            ? '이 기기에 저장되지 않은 변경이 있습니다. 내용을 확인하고 저장을 다시 시도해 주세요.'
            : '다른 기기에서 변경된 정보와 이 기기의 미저장 내용이 있습니다. 임시저장을 내려받은 뒤 서버 정보를 다시 불러오세요.';
          if (draft.baseUpdatedAt !== (record?.updatedAt ?? null)) this.loaded = false;
        } catch { recoveryError = '임시저장 내용을 읽지 못했습니다. 원본을 보존했습니다. 서버 정보를 표시합니다.'; }
      }
      this.updatedAt = record?.updatedAt ?? null;
      this.loaded = !recovered || !recoveryError?.startsWith('다른 기기');
      this.revision = recovered ? 1 : 0;
      this.savedRevision = 0;
      this.emit({ data, ready: this.loaded, status: recovered ? 'recovery' : 'saved', error: recoveryError });
    } catch {
      if (this.disposed || sequence !== this.loadSequence) return;
      this.loaded = false;
      this.emit({ status: 'error', ready: false, error: '회원 정보를 불러오지 못했습니다. 연결 상태와 회원 저장소 설정을 확인한 뒤 다시 시도해 주세요.' });
    }
  }
  update(updater: (current: MemberWorkspace) => MemberWorkspace): void {
    if (!this.loaded || this.disposed || !this.snapshot.data) return;
    const data = validateWorkspace(updater(structuredClone(this.snapshot.data)), this.userId);
    this.revision++;
    this.emit({ data, error: null });
    this.saveDraft();
    void this.flush();
  }
  flush(): Promise<boolean> {
    if (this.saving) return this.saving;
    if (!this.loaded || this.disposed) return Promise.resolve(false);
    this.saving = this.runSave().finally(() => { this.saving = null; });
    return this.saving;
  }
  private async runSave(): Promise<boolean> {
    while (!this.disposed && this.savedRevision < this.revision && this.snapshot.data) {
      const currentRevision = this.revision;
      const data = structuredClone(this.snapshot.data);
      this.emit({ status: 'saving', error: this.draftWarning });
      try {
        const stamp = await this.repository.save(this.userId, data, this.updatedAt, this.abort.signal);
        if (this.disposed) return false;
        this.updatedAt = stamp;
        this.savedRevision = currentRevision;
        if (this.savedRevision === this.revision) {
          try { this.storage?.removeItem(this.draftKey); } catch { /* Duplicate draft can be recovered; server data is safe. */ }
        } else this.saveDraft();
      } catch (error) {
        if (this.disposed) return false;
        const conflict = error instanceof WorkspaceConflict;
        if (conflict) this.loaded = false;
        this.emit({ status: 'error', ready: !conflict, error: conflict
          ? '다른 기기에서 정보가 변경되었습니다. 임시저장을 내려받은 뒤 서버 정보를 다시 불러오세요.'
          : `서버에 저장하지 못했습니다. 현재 변경은 유지됩니다. 다시 저장을 눌러 주세요.${this.draftWarning ? ` ${this.draftWarning}` : ''}` });
        return false;
      }
    }
    if (!this.disposed) this.emit({ status: 'saved', error: null });
    return !this.disposed;
  }
  /** Called only after the user downloads a backup and chooses to reload cloud data. */
  async reloadCloudAfterBackup(): Promise<void> {
    if (this.saving || this.disposed) return;
    try { this.storage?.removeItem(this.draftKey); } catch { return; }
    await this.load();
  }
  hasUnsavedChanges = () => this.revision > this.savedRevision;
  dispose() { this.disposed = true; this.abort.abort(); this.listeners.clear(); }
}
