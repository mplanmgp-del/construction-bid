import { expect, it, vi } from 'vitest';
import { createActiveCatalogStore } from '../server/active-catalog-store';
import { parseVerifiedNoticeSearch } from '../server/verified-notice-search';
const query=()=>parseVerifiedNoticeSearch(new URLSearchParams({from:'1995-10-01',to:'2100-12-31',type:'공사·용역'}));
it('uses the private RPC token and shared SQL search without requesting source APIs',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({items:[],nextCursor:null}));
  const store=createActiveCatalogStore({url:'https://example.supabase.co',key:'public',token:'x'.repeat(43),fetcher});
  await store.searchPage(query()); expect(fetcher).toHaveBeenCalledOnce();
  const [url,options]=fetcher.mock.calls[0]; expect(String(url)).toBe('https://example.supabase.co/rest/v1/rpc/bid_active_catalog_worker');
  expect(JSON.parse(options!.body as string)).toMatchObject({p_action:'search_page',p_token:'x'.repeat(43),p_payload:{type:'공사·용역',limit:50}});
});
it('maps a changed generation to a restartable 409 and hides arbitrary database errors',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({code:'P0001',message:'SEARCH_CHANGED'},{status:400}));
  const store=createActiveCatalogStore({url:'https://example.supabase.co',key:'public',token:'x'.repeat(43),fetcher});
  await expect(store.searchPage(query())).rejects.toMatchObject({status:409,code:'SEARCH_CHANGED'});
  fetcher.mockResolvedValueOnce(Response.json({code:'22023',message:'internal SQL text'},{status:400}));
  await expect(store.searchPage(query())).rejects.toMatchObject({status:400,code:'INVALID_SEARCH_QUERY'});
});
it('publishes the claimed complete histories without exposing the worker token in client data',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({ok:true}));
  const store=createActiveCatalogStore({url:'https://example.supabase.co',key:'public',token:'x'.repeat(43),fetcher});
  expect(await store.publishSearchVerified('lease',{scopeVersion:'scope',groups:[]})).toEqual({ok:true});
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({p_action:'search_publish',p_payload:{leaseId:'lease',scopeVersion:'scope',groups:[]}});
});

it('uses distinct result and status RPC actions with no aggregate request in the result path',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({items:[],nextCursor:null}));
  const store=createActiveCatalogStore({url:'https://example.supabase.co',key:'public',token:'x'.repeat(43),fetcher});
  await store.searchResults(query());
  expect(fetcher).toHaveBeenCalledOnce();expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({p_action:'search_results'});
  await store.searchStatus({...query(),asOf:'2026-10-16T00:01:02Z',snapshotVersion:'904'});
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toMatchObject({p_action:'search_status',p_payload:{asOf:'2026-10-16T00:01:02Z',snapshotVersion:'904'}});
});
it.each(['searchResults','searchStatus'] as const)('keeps %s validation and snapshot failures safely mapped',async action=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({code:'22023',message:'private SQL'},{status:400}));
  const store=createActiveCatalogStore({url:'https://example.supabase.co',key:'public',token:'x'.repeat(43),fetcher});
  const input={...query(),asOf:'2026-10-16T00:01:02Z',snapshotVersion:'904'};
  await expect(store[action](input)).rejects.toMatchObject({status:400,code:'INVALID_SEARCH_QUERY'});
  fetcher.mockResolvedValueOnce(Response.json({code:'P0001',message:'SEARCH_CHANGED'},{status:400}));
  await expect(store[action](input)).rejects.toMatchObject({status:409,code:'SEARCH_CHANGED'});
});
