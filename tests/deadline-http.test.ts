import { beforeEach, expect, it, vi } from 'vitest';
import { handleG2bRequest } from '../server/http';
import { createG2bClient } from '../server/g2b';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../server/active-catalog-store', () => ({ readDeadlineCatalog: read }));
const query = (patch: Record<string,string> = {}) => new URLSearchParams({ mode:'deadline', type:'공사', from:'2026-04-15', to:'2027-04-15', ...patch });
beforeEach(() => read.mockReset());

it('reads only the requested indexed submission-deadline range, without a provider scan', async () => {
  const fetcher = vi.fn();
  read.mockResolvedValue({ items:[], totalCount:0, hasMore:false, indexCoverage:{ complete:false, pending:700, checked:46 } });
  const response = await handleG2bRequest('/api/notices', query(), createG2bClient({ serviceKey:'test', fetcher }));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ indexCoverage:{ complete:false, pending:700, checked:46 } });
  expect(read).toHaveBeenCalledWith({ type:'공사', from:'2026-04-15', to:'2027-04-15', page:1, pageSize:100, keyword:'' });
  expect(fetcher).not.toHaveBeenCalled();
});

const invalidQueries:Record<string,string>[] = [{ from:'2026-02-30' }, { to:'2030-01-01' }, { pageSize:'999' }, { type:'물품' }, { keyword:'a'.repeat(101) }];
it.each(invalidQueries)('rejects invalid index query before reading storage: %o', async patch => {
  expect((await handleG2bRequest('/api/notices', query(patch), createG2bClient({}))).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it('accepts the 367 inclusive days possible in a calendar six-month window', async () => {
  read.mockResolvedValue({ items:[] });
  expect((await handleG2bRequest('/api/notices', query({ from:'2023-09-01', to:'2024-09-01' }), createG2bClient({}))).status).toBe(200);
});
