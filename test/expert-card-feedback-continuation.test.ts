import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ALIGNER_ROLE} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,mergeResumeMessages} from '../src/expert-card-replay-runtime.js';

test('new authorization is explicit and bound; the original paid prefix and task user remain unchanged',()=>{
  const original=[{role:'system',content:'S'},{role:'user',content:'U'},{role:'assistant',tool_calls:[{id:'t'}]},{role:'tool',tool_call_id:'t',content:'settled results'}];
  const scope='New user authorization: feedback only',prefix=[...original,{role:'user',content:scope}];
  const result=mergeResumeMessages(prefix,original.slice(0,2),'S','U',scope);
  assert.deepEqual(result.slice(0,4),original);assert.equal(result.filter(x=>x.role==='user'&&x.content==='U').length,1);
  assert.throws(()=>mergeResumeMessages(prefix,original.slice(0,2),'S','U'),/exactly/);
  assert.throws(()=>mergeResumeMessages(prefix,original.slice(0,2),'S','U','different'),/Unbound/);
  assert.throws(()=>mergeResumeMessages([...prefix,prefix.at(-1)],original.slice(0,2),'S','U',scope),/exactly/);
  const restored=[...prefix,{role:'assistant',tool_calls:[{id:'read'}]},{role:'tool',tool_call_id:'read',content:'registered evidence'}];
  assert.deepEqual(mergeResumeMessages(restored,original.slice(0,2),'S','U',scope),restored);
});

test('feedback lock preserves schemas and reads while rejecting create, update, sample and confirm before execution',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'feedback-lock-')),source={roleId:ALIGNER_ROLE,systemPrompt:'original'};
  let executions=0;
  const base={root,source,evidence:{sessions:{known:'evidence'},artifacts:{},defaultArtifacts:{}},storeOptions:{}};
  const writable=createCardReplayRuntime(base,async()=>{executions++;});await writable.card({action:'create',roleId:ALIGNER_ROLE});
  const collect=(runtime:any,path:string)=>{const tools:any[]=[];const handlers:Record<string,any>={};registerCardReplayTools({registerTool:(t:any)=>tools.push(t),on:(n:string,f:any)=>handlers[n]=f},runtime,path);return {tools,handlers};};
  const original=collect(writable,resolve(root,'unused-stop'));
  for(const [name,args] of [['expert_card_copy',{action:'create',roleId:ALIGNER_ROLE}],['expert_card_copy',{action:'update',roleId:ALIGNER_ROLE,parentVersion:'v0',skill:'new',reason:'new'}],['expert_trial',{action:'sample',roleId:ALIGNER_ROLE,version:'v0'}],['expert_trial',{action:'confirm',roleId:ALIGNER_ROLE,version:'v0',selectionId:'new'}]] as const) {
    const runtime=createCardReplayRuntime({...base,feedbackOnly:true},async()=>{executions++;});
    const registered=collect(runtime,resolve(root,'stop-'+name+'-'+args.action));
    assert.deepEqual(registered.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})),original.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})));
    assert.equal((await runtime.card({action:'read',roleId:ALIGNER_ROLE,version:'v0'})).version,'v0');assert.deepEqual(await runtime.evidence({kind:'session',id:'known'}),{id:'known',raw:'evidence'});
    await assert.rejects(registered.tools.find(t=>t.name===name).execute('id',args),/forbid/);
    let aborted=false;assert.throws(()=>registered.handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);
  }
  assert.equal(executions,0);assert.equal(Object.keys((await writable.store.snapshot()).versions).length,1);
});
