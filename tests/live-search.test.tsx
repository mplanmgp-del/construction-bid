import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveSearch } from '../src/live/LiveSearch';

const query = { type: '공사·용역' as const, from: '2026-10-09', to: '2026-10-15', keyword: '철거' };
const actions = { onSearch: () => {}, onRefresh: () => {} };

describe('notice search controls', () => {
  it('keeps the search form and conditions without a separate refresh action', () => {
    const html = renderToStaticMarkup(<LiveSearch query={query} loading={false} {...actions} />);
    expect(html).not.toContain('새로고침');
    expect(html).not.toContain('notice-search-refresh');
    expect(html).toContain('role="search"');
    for (const field of ['keyword', 'type', 'from', 'to']) expect(html).toContain(`name="${field}"`);
    expect(html).toContain('type="submit"');
    expect(html).toContain('value="철거"');
    expect(html).toContain('검색<svg');
  });

  it('continues to prevent duplicate searches while loading or waiting for the server cooldown', () => {
    for (const props of [{ loading: true }, { loading: false, refreshBlocked: true }]) {
      const html = renderToStaticMarkup(<LiveSearch query={query} {...props} {...actions} />);
      const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
      expect(submit).toContain('disabled=""');
    }
  });
});
