import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {alertApiHandler} from '../server/alert-http';
describe('deployed Node request compatibility',()=>{
  it('loads the full API graph with the native Node ESM resolver',()=>{
    const result=spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','-e','await import("./api/alerts.ts")'],{cwd:process.cwd(),encoding:'utf8',timeout:20_000});
    expect(result.status,result.stderr).toBe(0);
  });
  it('honors a body already parsed by Vercel before entering the handler',async()=>{
    const req={method:'POST',url:'/api/alerts',headers:{},body:{action:'worker'}} as unknown as IncomingMessage;
    let body='';const res={statusCode:200,setHeader(){},end(value:string){body=value;}} as unknown as ServerResponse;
    await alertApiHandler(req,res);
    expect(res.statusCode).toBe(401);expect(JSON.parse(body).error.code).toBe('WORKER_UNAUTHORIZED');
  });
});
