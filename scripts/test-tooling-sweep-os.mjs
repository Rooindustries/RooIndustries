import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'roo-request-os-proof-'));
const runId=`request-os-${crypto.randomBytes(6).toString('hex')}`;
const profile=`/tmp/roo-tooling-${runId}`;
const otherProfile=path.join(scratch,'playwright_chromium-unrelated');
fs.mkdirSync(profile);fs.mkdirSync(otherProfile);
const manifest=path.join(scratch,'ownership.json');
const artifact=path.resolve(process.env.TOOLING_OS_ARTIFACT||'test-results/request-tooling-os.json');
const evidence={checkedAt:new Date().toISOString(),productionRequests:0,syntheticProcessesOnly:true,scenarios:[],scratch,profile,limits:['Synthetic Node processes have browser-shaped argv. No actual browser process/profile was placed in ownership.','Actual proc/ps/fs/SIGTERM behavior proved; forced real PID reuse and browser child/process lifecycle excluded.']};
const children=[];
const identity=pid=>{try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const startTime=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19];const args=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');return{startTime,profile:args.find(a=>a.startsWith('--user-data-dir='))?.slice(16)};}catch{return null;}};
const start=async profile=>{const proc=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)",'--',`--user-data-dir=${profile}`],{argv0:'chromium-roo-harmless-child',env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});await once(proc.stdout,'data');const live=identity(proc.pid);assert.equal(live.profile,profile);const record={proc,pid:proc.pid,...live};children.push(record);return record;};
const alive=record=>record.proc.exitCode===null&&record.proc.signalCode===null&&identity(record.pid)?.startTime===record.startTime;
const runCleanup=async ownership=>{if(ownership)fs.writeFileSync(manifest,JSON.stringify(ownership));const proc=spawn(process.execPath,[path.join(root,'scripts/phase1-browser-hygiene.js')],{cwd:scratch,env:{PATH:process.env.PATH,HOME:scratch,APPLY_CLEANUP:'1',...(ownership?{BROWSER_CLEANUP_OWNERSHIP:manifest,BROWSER_RUN_ID:runId}:{})},stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);const [code]=await once(proc,'exit');assert.equal(code,0,output);return output.trim();};
const run=async(name,fn)=>{try{evidence.scenarios.push({name,passed:true,proof:await fn()});}catch(error){evidence.scenarios.push({name,passed:false,error:error.message,stack:error.stack});}};
try{
 const owned=await start(profile),other=await start(otherProfile);
 const ownership={version:1,runId,profile,processes:[{pid:owned.pid,startTime:owned.startTime}]};
 await run('no-manifest-kills-none',async()=>{const output=await runCleanup(null);assert.match(output,/killed=0/);assert.ok(alive(owned));assert.ok(alive(other));return{output,ownedAlive:true,otherAlive:true};});
 await run('wrong-manifest-kills-none',async()=>{const output=await runCleanup({...ownership,runId:'another-current-run'});assert.match(output,/killed=0/);assert.ok(alive(owned));assert.ok(alive(other));return{output,ownedAlive:true,otherAlive:true};});
 await run('mismatched-pid-start-kills-none',async()=>{const output=await runCleanup({...ownership,processes:[{pid:owned.pid,startTime:String(BigInt(owned.startTime)+1n)}]});assert.match(output,/killed=0/);assert.ok(alive(owned));assert.ok(alive(other));return{output,ownedAlive:true,otherAlive:true};});
 await run('exact-owned-child-only',async()=>{const output=await runCleanup(ownership);assert.match(output,/killed=1/);if(alive(owned))await once(owned.proc,'exit');assert.equal(alive(owned),false);assert.ok(alive(other));assert.equal(owned.proc.signalCode,'SIGTERM');return{output,killedPid:owned.pid,verifiedStartTime:owned.startTime,unrelatedSyntheticPid:other.pid,unrelatedSyntheticAlive:true};});
}catch(error){evidence.setupError={message:error.message,stack:error.stack};}
finally{
 for(const child of children){if(alive(child)&&identity(child.pid)?.profile===child.profile){const exited=once(child.proc,'exit');child.proc.kill('SIGTERM');await exited;}}
 evidence.allOwnedChildrenStopped=children.every(c=>!alive(c));evidence.passed=!evidence.setupError&&evidence.scenarios.length===4&&evidence.scenarios.every(s=>s.passed)&&evidence.allOwnedChildrenStopped;fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({artifact,passed:evidence.scenarios.filter(s=>s.passed).length,total:evidence.scenarios.length,setupError:evidence.setupError?.message}));if(!evidence.passed)process.exitCode=1;
}
