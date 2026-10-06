import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const inventory=JSON.parse(fs.readFileSync('scripts/fixtures/sanity-final-outside-data.json','utf8'));
const sources=new Map();
const rows=inventory.rows.map(row=>{
 assert.ok(row.handling.length && row.references.length);
 const references=row.references.map(ref=>{
  if(!sources.has(ref.file)){const bytes=fs.readFileSync(ref.file);sources.set(ref.file,{lines:bytes.toString('utf8').split('\n'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
  const source=sources.get(ref.file),matches=source.lines.flatMap((line,index)=>line.includes(ref.needle)?[index+1]:[]);
  assert.ok(matches.length,JSON.stringify(ref));
  const line=ref.lineHint?matches.sort((a,b)=>Math.abs(a-ref.lineHint)-Math.abs(b-ref.lineHint))[0]:matches[0];
  return {file:ref.file,line,needle:ref.needle,snippet:source.lines[line-1].trim(),sha256:source.sha256};
 });
 return {...row,references};
});
const escape=value=>value.replaceAll('|','&#124;').replaceAll('\n',' ');
const table=['| Decision | Field/state | Handling | Verified final file:line |','|---|---|---|---|',...rows.map(row=>`| ${escape(row.decision)} | ${escape(row.fieldOrState)} | ${escape(row.handling)} | ${row.references.map(ref=>'`'+ref.file+':'+ref.line+'`').join('; ')} |`)].join('\n')+'\n';
const artifact={passed:true,checkedAt:new Date().toISOString(),rows:rows.length,sourceFiles:sources.size,verification:'Each predicate anchor is present in final source; exact cited snippet and SHA256 retained. Handling is an explicit reviewed decision inventory, not a claim that lexical matching independently proves semantics.',sources:Object.fromEntries([...sources].map(([file,value])=>[file,value.sha256])),decisions:rows};
fs.mkdirSync('test-results/sanity-fixround',{recursive:true});fs.writeFileSync('test-results/sanity-fixround/outside-data-final.json',JSON.stringify(artifact,null,2)+'\n');fs.writeFileSync('test-results/sanity-fixround/outside-data-final.md',table);console.log(JSON.stringify({passed:true,rows:rows.length,sourceFiles:sources.size}));
