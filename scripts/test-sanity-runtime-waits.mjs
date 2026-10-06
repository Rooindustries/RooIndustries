import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {once} from 'node:events';
import {installNetworkGuard} from './lib/test-target-safety.mjs';
const {createSupabaseAdminFetch}=await import('../src/server/supabase/adminClient.js');
const requests=[];const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/headers')return;res.writeHead(req.url==='/error-body'?503:200,{'content-type':'application/json'});res.write('{"held":');});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`,restore=installNetworkGuard([origin]),result={startedAt:new Date().toISOString(),deadlineMs:30000,localResponses:'Real local HTTP responses hold headers or JSON bodies indefinitely; no persistence or hosted service.'};
try{const bounded=createSupabaseAdminFetch();result.cases=await Promise.all(['/headers','/body','/error-body'].map(async pathname=>{const started=Date.now();let failure;try{await(await bounded(origin+pathname)).json();}catch(error){failure=error;}const elapsedMs=Date.now()-started;assert.ok(failure,pathname);assert.ok(elapsedMs>=29000&&elapsedMs<35000,`${pathname}: ${elapsedMs}`);return {pathname,elapsedMs,errorName:failure.name};}));assert.deepEqual(requests.sort(),['/body','/error-body','/headers']);result.passed=true;}catch(error){result.passed=false;result.error=error.message;throw error;}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));restore();result.finishedAt=new Date().toISOString();fs.mkdirSync('test-results/sanity-runtime',{recursive:true});fs.writeFileSync('test-results/sanity-runtime/waits.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
