import { describe, expect, it, vi } from 'vitest';
import { normalizeQuickLinkUrl, readQuickLinks, validateQuickLinkDrafts } from '../src/quick-links';
import { emptyMemberWorkspace, MemberWorkspaceController, validateWorkspace, type MemberWorkspace, type WorkspaceRepository } from '../src/member/workspace';

describe('personal URL shortcuts', () => {
  it('adds HTTPS to a domain while retaining explicit HTTP and URL parameters', () => {
    expect(normalizeQuickLinkUrl(' www.g2b.go.kr/link/?bid=123#detail ')).toBe('https://www.g2b.go.kr/link/?bid=123#detail');
    expect(normalizeQuickLinkUrl('http://example.com/path')).toBe('http://example.com/path');
    expect(normalizeQuickLinkUrl('example.com:8443/path')).toBe('https://example.com:8443/path');
    expect(normalizeQuickLinkUrl('https://예시.한국')).toMatch(/^https:\/\/xn--/);
    expect(normalizeQuickLinkUrl('')).toBe('');
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret', '//example.com', '/relative/path', 'https://', 'https://user:pass@example.com', 'https://exam ple.com', 'https://example.com\\other', 'java\nscript:alert(1)'])('rejects an unsafe or malformed URL: %s', value => {
    expect(normalizeQuickLinkUrl(value)).toBeNull();
  });

  it('validates each slot before saving and does not silently remove a mistyped URL', () => {
    const result = validateQuickLinkDrafts([{ label: '나라장터', url: 'g2b.go.kr' }, { label: '두 번째', url: 'https://' }]);
    expect(result.errors[1]).toContain('URL');
    expect(result.links).toEqual([{ label: '나라장터', url: 'https://g2b.go.kr/' }]);
    expect(validateQuickLinkDrafts([{ label: '', url: 'example.com' }]).links[0].label).toBe('example.com');
    expect(validateQuickLinkDrafts([{ label: '', url: '' }]).links).toEqual([]);
  });

  it('limits shortcuts to four and removes malformed stored links without changing legacy profiles', () => {
    const legacy = emptyMemberWorkspace('a');
    expect(validateWorkspace(legacy, 'a')).toEqual(legacy);
    const unsafe = { ...legacy, profile: { ...legacy.profile, companyName: '기존 업체', quickLinks: [{ label: 'bad', url: 'javascript:alert(1)' }, { label: '나라장터', url: 'g2b.go.kr' }] } };
    expect(validateWorkspace(unsafe, 'a').profile).toMatchObject({ companyName: '기존 업체', quickLinks: [{ label: '나라장터', url: 'https://g2b.go.kr/' }] });
    expect(readQuickLinks(Array.from({ length: 6 }, (_, i) => ({ label: `${i}`, url: `https://example.com/${i}` })))).toHaveLength(4);
  });

  it('saves shortcuts through the member cloud repository and preserves other data and account isolation', async () => {
    const records = new Map<string, MemberWorkspace>();
    const existing = emptyMemberWorkspace('a', 'a@example.com');
    existing.profile.companyName = '기존 업체';
    existing.profile.licenses = ['철거'];
    existing.bookmarks = ['saved-notice'];
    records.set('a', existing);
    const repository: WorkspaceRepository = {
      load: vi.fn(async id => records.has(id) ? { data: records.get(id)!, updatedAt: 'before' } : null),
      save: vi.fn(async (id, data) => { records.set(id, structuredClone(data)); return 'after'; }),
    };
    const controller = new MemberWorkspaceController('a', '', repository);
    await controller.load();
    controller.update(current => ({ ...current, profile: { ...current.profile, quickLinks: [{ label: '나라장터', url: 'g2b.go.kr' }] } }));
    expect(await controller.flush()).toBe(true);
    const restored = new MemberWorkspaceController('a', '', repository);
    await restored.load();
    expect(restored.getSnapshot().data?.profile).toMatchObject({ companyName: '기존 업체', licenses: ['철거'], email: 'a@example.com', quickLinks: [{ label: '나라장터', url: 'https://g2b.go.kr/' }] });
    expect(restored.getSnapshot().data?.bookmarks).toEqual(['saved-notice']);
    const other = new MemberWorkspaceController('b', '', repository);
    await other.load();
    expect(other.getSnapshot().data?.profile.quickLinks).toBeUndefined();
    expect(() => validateWorkspace(records.get('a'), 'b')).toThrow();
    controller.dispose(); restored.dispose(); other.dispose();
  });
});
