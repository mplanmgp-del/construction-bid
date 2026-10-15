import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVerifiedNoticeSearch, parseVerifiedNoticeSearchStatus } from '../server/verified-notice-search';
import { handleG2bRequest } from '../server/http';
import { createG2bClient } from '../server/g2b';

const { read, results, status } = vi.hoisted(() => ({ read: vi.fn(), results: vi.fn(), status: vi.fn() }));
vi.mock('../server/active-catalog-store', () => ({ readDeadlineCatalog: vi.fn(), readVerifiedNoticeSearch: read, readVerifiedNoticeSearchResults: results, readVerifiedNoticeSearchStatus: status }));
const params = (patch: Record<string,string>={}) => new URLSearchParams({ mode:'search',type:'공사·용역',from:'1995-10-01',to:'2100-12-31',keyword:'철거',...patch });
beforeEach(() => { read.mockReset(); results.mockReset(); status.mockReset(); });
describe('verified shared-index search boundary', () => {
  it('accepts wide ranges and combined types without any provider requests', async () => {
    const fetcher=vi.fn(); read.mockResolvedValue({ items:[],totalCount:0,hasMore:false,nextCursor:null,snapshotVersion:'2',asOf:'2026-10-15T09:00:00Z' });
    const result=await handleG2bRequest('/api/notices',params(),createG2bClient({serviceKey:'test',fetcher}));
    expect(result.status).toBe(200); expect(fetcher).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(expect.objectContaining({type:'공사·용역',from:'1995-10-01',to:'2100-12-31',limit:50,keyword:'철거'}));
  });
  it('passes filters and only the two company geography fields', () => {
    const value=parseVerifiedNoticeSearch(params({filters:JSON.stringify({license:'구조물해체·비계공사업',regions:[{province:'서울',district:'강남구'}],statuses:['예정'],sort:'amountDesc',minAmount:'1,000'}),companyRegion:JSON.stringify({province:'서울',district:'강남구',email:'do-not-send@example.com',address:'private',userId:'other'})}));
    expect(value.filters).toMatchObject({license:'구조물해체·비계공사업',sort:'amountDesc',minAmount:'1,000',statuses:['예정']});
    expect(value.profile).toEqual({province:'서울특별시',district:'강남구'}); expect(JSON.stringify(value)).not.toContain('do-not-send');
  });
  it.each<Record<string,string>>([{from:'1995-09-30'},{to:'2101-01-01'},{from:'2026-02-30'},{from:'2027-01-01',to:'2026-01-01'},{type:'물품'},{limit:'51'},{limit:'0'},{cursor:'a'.repeat(4097)},{filters:'[]'},{filters:'{'},{filters:JSON.stringify({sort:'random'})},{filters:JSON.stringify({license:123})},{filters:JSON.stringify({minAmount:'-1'})},{filters:JSON.stringify({regions:[{province:'bad'}]})}])('rejects invalid input before storage: %o', async patch => {
    const response=await handleG2bRequest('/api/notices',params(patch),createG2bClient({})); expect(response.status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it('rejects invalid active status and preserves an explicitly empty status selection', () => {
    expect(()=>parseVerifiedNoticeSearch(params({filters:JSON.stringify({statuses:['not-a-status']})}))).toThrow();
    expect(parseVerifiedNoticeSearch(params({filters:JSON.stringify({statuses:[]})})).filters.statuses).toEqual([]);
  });
});

describe('independent fast search and collection-status transport', () => {
  const anchor = {asOf:'2026-10-16T00:01:02.123456+00:00',snapshotVersion:'904'};
  it('returns fast result facts without starting or awaiting aggregate metadata', async () => {
    const facts={items:[],totalCount:0,hasMore:false,nextCursor:null,...anchor};
    results.mockResolvedValue(facts); status.mockImplementation(()=>new Promise(()=>{}));
    const fetcher=vi.fn();
    const response=await handleG2bRequest('/api/notices',params({mode:'search-results'}),createG2bClient({serviceKey:'test',fetcher}));
    expect(response).toEqual({status:200,body:facts});
    expect(results).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('passes the exact result anchor and filters to the separate status request', async () => {
    status.mockResolvedValue({...anchor,pendingCount:7}); const fetcher=vi.fn();
    const input=params({mode:'search-status',...anchor,filters:JSON.stringify({regions:[{province:'서울'}]})});
    const response=await handleG2bRequest('/api/notices',input,createG2bClient({serviceKey:'test',fetcher}));
    expect(response.status).toBe(200); expect(status).toHaveBeenCalledWith(expect.objectContaining({...anchor,filters:expect.objectContaining({regions:[{province:'서울특별시'}]})}));
    expect(results).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(parseVerifiedNoticeSearchStatus(input)).toMatchObject(anchor);
  });
  it.each<Record<string,string>>([{asOf:''},{asOf:'yesterday'},{asOf:'123'},{snapshotVersion:''},{snapshotVersion:'bad'},{snapshotVersion:'9'.repeat(21)},{cursor:'old-cursor'}])('rejects invalid status anchors before a database request: %o',async patch=>{
    const response=await handleG2bRequest('/api/notices',params({mode:'search-status',...anchor,...patch}),createG2bClient({}));
    expect(response.status).toBe(400);expect(status).not.toHaveBeenCalled();expect(results).not.toHaveBeenCalled();
  });
});
