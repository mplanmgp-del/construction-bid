import { beforeEach,expect,it,vi } from 'vitest';
import { handleAlertRequest } from '../server/alert-http';
import type { AlertStore } from '../server/alert-store';
const mocks=vi.hoisted(()=>({collect:vi.fn(),alarms:vi.fn(),deadline:vi.fn()}));
vi.mock('../server/active-catalog-worker',()=>({runActiveCatalogWorker:mocks.collect}));
vi.mock('../server/alert-worker',()=>({runAlertWorker:mocks.alarms}));
vi.mock('../server/active-catalog-store',()=>({createActiveCatalogStore:()=>({setDeadline:mocks.deadline})}));
const store={setDeadline:vi.fn()} as unknown as AlertStore;
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('ALERT_WORKER_TOKEN','x'.repeat(43));mocks.collect.mockResolvedValue({ok:true,sources:1});mocks.alarms.mockResolvedValue({ok:true,notifications:1});});
it('keeps the public collector on its own authenticated execution budget',async()=>{
  const result=await handleAlertRequest('POST',new URLSearchParams('action=catalog-worker'),{},`Bearer ${'x'.repeat(43)}`,store);
  expect(result).toMatchObject({ok:true,sources:1});expect(mocks.collect).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({budgetMs:43_000,maxRequests:40}));expect(mocks.alarms).not.toHaveBeenCalled();
});
it('preserves the alarm worker budget even if public source collection would time out',async()=>{
  mocks.collect.mockRejectedValue(new Error('slow source'));
  const start=Date.now();await handleAlertRequest('POST',new URLSearchParams('action=worker'),{},`Bearer ${'x'.repeat(43)}`,store);
  expect(mocks.collect).not.toHaveBeenCalled();expect(mocks.alarms.mock.calls[0][1].deadline).toBeGreaterThanOrEqual(start+43_000);
});
it.each(['worker','catalog-worker'])('checks token and POST before invoking %s',async action=>{
  await expect(handleAlertRequest('GET',new URLSearchParams({action}),{},`Bearer ${'x'.repeat(43)}`,store)).rejects.toMatchObject({status:405});
  await expect(handleAlertRequest('POST',new URLSearchParams({action}),{},'Bearer user',store)).rejects.toMatchObject({status:401});
  expect(mocks.collect).not.toHaveBeenCalled();expect(mocks.alarms).not.toHaveBeenCalled();
});
