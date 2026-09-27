import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Check} from 'typebox/value';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';
import {cardDigest} from '../src/expert-card-copy-store.js';
const source={roleId:'refine.evidence-aligner',systemPrompt:'base'};
async function setup(sessions:Record<string,string>={},defaultSession?:string){const root=await mkdtemp(join(tmpdir(),'evidence-availability-')),runtime=createCardReplayRuntime({root,source,defaultCardVersion:'v0',storeOptions:{},evidence:{sessions,...(defaultSession?{defaultSession}:{}),artifacts:{},defaultArtifacts:{}}},async()=>{throw Error('offline');}),tools:any[]=[],handlers:any={};registerCardReplayTools({registerTool:(t:any)=>tools.push(t),on:(n:string,h:any)=>handlers[n]=h},runtime,join(root,'stop'));return{runtime,tools,handlers,evidence:tools.find(t=>t.name==='expert_evidence'),card:tools.find(t=>t.name==='expert_card_copy')};}
test('real 204 missing-session request is unavailable, not guessed into a default',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/expert-evidence-missing-session.json',import.meta.url),'utf8'));
 assert.equal(fixture.source.requestId,204);const f=await setup();assert.deepEqual(fixture.arguments,{kind:'session'});
 assert.equal(Check(f.evidence.parameters,fixture.arguments),false);assert.equal(Check(f.evidence.parameters,{kind:'session',id:'unknown'}),false);assert(Check(f.evidence.parameters,{kind:'inventory'}));
 await assert.rejects(f.evidence.execute('original-failure',fixture.arguments),/Unknown session/);let aborted=false;assert.throws(()=>f.handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);
});
test('session id is required unless a real declared default exists; artifact/version always need id',async()=>{
 for(const defaultSession of [undefined,'actual']){const f=await setup({actual:'original source text'},defaultSession);assert.equal(Check(f.evidence.parameters,{kind:'session'}),!!defaultSession);assert(Check(f.evidence.parameters,{kind:'session',id:'actual'}));assert.deepEqual(await f.runtime.evidence({kind:'session',id:'actual'}),{id:'actual',raw:'original source text'});await assert.rejects(f.runtime.evidence({kind:'session',id:'unknown'}),/Unknown/);if(defaultSession)assert.deepEqual(await f.runtime.evidence({kind:'session'}),{id:'actual',raw:'original source text'});else await assert.rejects(f.runtime.evidence({kind:'session'}),/Unknown/);
 for(const kind of ['artifact','version'])assert.equal(Check(f.evidence.parameters,{kind}),false);
 }
 await assert.rejects(setup({},'invented'),/not registered/);
});
test('Card read default never supplies update parent; optional field inheritance is unchanged',async()=>{
 const f=await setup();await f.card.execute('create',{action:'create'});assert.equal(JSON.parse((await f.card.execute('read',{action:'read'})).content[0].text).version,'v0');
 await assert.rejects(f.runtime.card({action:'update',roleId:source.roleId,skill:'only',reason:'no parent'}),/Unknown immutable/);
 const v1=await f.runtime.card({action:'update',roleId:source.roleId,parentVersion:'v0',skill:'sentinel',reason:'explicit parent'});assert.equal(v1.systemPrompt,'base');assert.equal(v1.skill,'sentinel');
});
test('real 207 fileName combination is rejected; independent canonical and default IDs read exact content',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/expert-evidence-artifact-combination.json',import.meta.url),'utf8'));assert.equal(fixture.source.requestId,207);
 const root=await mkdtemp(join(tmpdir(),'artifact-ids-')),artifacts:Record<string,{path:string;sha256:string}>={};for(const id of ['task-evaluation-skill','description']){const path=join(root,id+'.md'),raw='offline '+id;await writeFile(path,raw);artifacts[id]={path,sha256:cardDigest(raw)};}
 const runtime=createCardReplayRuntime({root,source,storeOptions:{},evidence:{sessions:{},artifacts,defaultArtifacts:{task:'task-evaluation-skill'}}},async()=>{throw Error('offline');}),tools:any[]=[];registerCardReplayTools({registerTool:(t:any)=>tools.push(t),on:()=>{}},runtime,join(root,'stop'));const tool=tools.find(t=>t.name==='expert_evidence');assert(!Object.hasOwn(tool.parameters.properties,'fileName'));assert.equal(Check(tool.parameters,fixture.arguments),false);
 await assert.rejects(runtime.evidence(fixture.arguments),/Unknown artifact/);
 for(const id of ['task-evaluation-skill','description','task']){assert(Check(tool.parameters,{kind:'artifact',id}));const actual=JSON.parse((await tool.execute(id,{kind:'artifact',id})).content[0].text);assert.equal(actual.raw,'offline '+(id==='task'?'task-evaluation-skill':id));}
});
