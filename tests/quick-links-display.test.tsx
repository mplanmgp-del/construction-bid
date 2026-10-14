import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloatingQuickLinks } from '../src/components/FloatingQuickLinks';
import { ProfileView } from '../src/components/ProfileView';
import { emptyMemberWorkspace } from '../src/member/workspace';

describe('personal shortcut display', () => {
  it('shows no floating controls for a legacy account with no saved URLs', () => {
    expect(renderToStaticMarkup(createElement(FloatingQuickLinks, { profile: emptyMemberWorkspace('a').profile }))).toBe('');
  });

  it('renders only safe saved links in new tabs and keeps mobile controls collapsed initially', () => {
    const profile = { ...emptyMemberWorkspace('a').profile, quickLinks: [{ label: '<script>link</script>', url: 'example.com' }, { label: 'bad', url: 'javascript:alert(1)' }, { label: 'empty', url: '' }] };
    const html = renderToStaticMarkup(createElement(FloatingQuickLinks, { profile }));
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('&lt;script&gt;link&lt;/script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
  });

  it('provides four empty editable slots without inventing links for an existing profile', () => {
    const html = renderToStaticMarkup(createElement(ProfileView, { profile: emptyMemberWorkspace('a').profile, onSave: () => undefined, persistence: 'cloud' }));
    for (let slot = 1; slot <= 4; slot++) {
      expect(html).toContain(`바로가기 ${slot} 이름`);
      expect(html).toContain(`aria-label="바로가기 ${slot} URL"`);
    }
    expect(html).not.toContain('저장하지 않은 변경사항');
    expect(html).toContain('회원의 업체 정보를 클라우드에 저장');
  });
});
