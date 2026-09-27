import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';
import {ALIGNER_ROLE as roleId,cardDigest} from '../src/expert-card-copy-store.js';

test('independent observation exposes complete allowlisted evidence, never implementation or state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'observation-')),file=join(root,'pair.json');
 const pair={sourceAspect:{evidences:Array.from({length:7},(_,i)=>({quote:`source ${i}`,location:`s${i}`}))},targetAspect:{evidences:Array.from({length:4},(_,i)=>({quote:`target ${i}`,location:`t${i}`}))}};
 const raw=JSON.stringify(pair);await writeFile(file,raw);
 const config={root,source:{roleId,systemPrompt:'SECRET_CARD'},storeOptions:{},observationOnly:true,readOnly:true,evidence:{sessions:{},artifacts:{pair:{path:file,sha256:cardDigest(raw)}},defaultArtifacts:{}}};
 const runtime=createCardReplayRuntime(config,async()=>{throw Error('never execute');});
 assert.deepEqual(JSON.parse((await runtime.evidence({kind:'artifact',id:'pair'})).raw!),pair);
 assert.deepEqual(await runtime.evidence({kind:'inventory'}),{artifacts:['pair'],defaultArtifacts:{}});
 for(const kind of ['version','session'] as const)await assert.rejects(runtime.evidence({kind,id:'v0'}),/forbids/);
 assert.throws(()=>runtime.card({action:'read',roleId,version:'v0'}),/forbids/);
 await assert.rejects(runtime.evidence({kind:'artifact',id:'v0'}),/Unknown/);
 await assert.rejects(readFile(join(root,'copies/state.json')),/ENOENT/);
 const registered:any[]=[],handlers:Record<string,any>={};let active:string[]=[];
 registerCardReplayTools({registerTool:(t:any)=>registered.push(t),on:(n:string,f:any)=>handlers[n]=f,setActiveTools:(v:string[])=>active=v},runtime,join(root,'stop.json'));
 handlers.session_start();assert.deepEqual(active,['expert_evidence']);assert.deepEqual(registered.map(t=>t.name),['expert_evidence']);
 assert(!JSON.stringify(registered[0].parameters).includes('version'));
 await assert.rejects(registered[0].execute('bad',{kind:'artifact',id:'v0/version-bundle.json'}),/Unknown/);
 let aborted=false;assert.throws(()=>handlers.before_provider_request({}, {abort(){aborted=true;}}),/Engineering stop/);assert(aborted);
 assert.throws(()=>createCardReplayRuntime({...config,evidence:{...config.evidence,sessions:{old:'SECRET'}}},async()=>{}),/no session/);
});

test('version artifact default is a complete live bundle and incorporates subsequent settled samples',async()=>{
 const root=await mkdtemp(join(tmpdir(),'version-bundle-'));
 const runtime=createCardReplayRuntime({root,source:{roleId,systemPrompt:'CARD'},storeOptions:{sampleCount:2,receipt:async id=>({status:'settled',requestId:id,costUsd:0,totalTokens:1,parsed:true})},evidence:{sessions:{},artifacts:{},defaultArtifacts:{}}},async(_copy,id)=>({raw:`all evidence retained ${id}`}));
 await runtime.card({action:'create',roleId});
 assert.equal(JSON.parse((await runtime.evidence({kind:'artifact',id:'v0'})).raw!).samples.length,0);
 await runtime.store.sample({roleId,version:'v0'});
 const bundle=await runtime.evidence({kind:'artifact',id:'v0',fileName:'version-bundle.json'});
 assert.equal(bundle.id,'v0/version-bundle.json');assert.equal(JSON.parse(bundle.raw!).samples.length,2);
 assert.equal((await runtime.evidence({kind:'inventory'}) as any).defaultArtifacts?.v0,'v0/version-bundle.json');
 await assert.rejects(runtime.evidence({kind:'artifact',id:'v99'}),/Unknown/);
});
