import test from 'node:test';
import assert from 'node:assert/strict';
import {findPackageJSON} from 'node:module';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ALIGNER_ROLE,cardDigest,createExpertCardCopyStore} from '../src/expert-card-copy-store.js';
import {createCardReplayRuntime,registerCardReplayTools,separatedModificationDecisionToken} from '../src/expert-card-replay-runtime.js';

test('DeepSeek SDK serializes an object root without weakening separated action validation',async()=>{
  const sdkRoot=dirname(findPackageJSON('@earendil-works/pi-ai',import.meta.resolve('@earendil-works/pi-coding-agent'))!);
  const {stream}=await import(pathToFileURL(join(sdkRoot,'dist/api/openai-completions.js')).href);
  const {validateToolArguments}=await import(pathToFileURL(join(sdkRoot,'dist/utils/validation.js')).href);
  const root=await mkdtemp(join(tmpdir(),'card-provider-schema-')),source={roleId:ALIGNER_ROLE,systemPrompt:'SOURCE'};
  const store=createExpertCardCopyStore(join(root,'copies'),source,async()=>{throw Error('Expert forbidden');});
  const parent=await store.card({action:'create',roleId:ALIGNER_ROLE});
  const receiptPath=join(root,'diagnosis.json'),receipt=JSON.stringify({kind:'frozen-observation-receipt',epistemicStatus:'model-observation-not-gold'});
  await writeFile(receiptPath,receipt);
  const binding={observationReceiptSha256:cardDigest(receipt),parentVersion:'v0',parentDigest:parent.digest,startStateSha256:cardDigest(await store.snapshot())};
  const config:any={root,source,storeOptions:{reviewedCopies:{}},generationOnly:true,defaultCardVersion:'v0',separatedModificationDecision:binding,evidence:{sessions:{},artifacts:{diagnosis:{path:receiptPath,sha256:cardDigest(receipt)}},defaultArtifacts:{}},stageVisibility:{artifactIds:['diagnosis'],sessionIds:[],versionIds:[],cardReadVersions:['v0'],updateParentVersions:['v0'],allowDynamicArtifacts:false,allowVersionBundles:false,allowCreate:false}};
  const definitions:any[]=[];
  registerCardReplayTools({registerTool:(definition:any)=>definitions.push(definition),on(){},setActiveTools(){}},createCardReplayRuntime(config,async()=>{throw Error('Expert forbidden');}),join(root,'engineering-stop.json'));
  const card=definitions.find(tool=>tool.name==='expert_card_copy'),token=separatedModificationDecisionToken(binding);
  const captured:any[]=[];
  const result=await stream({id:'deepseek-v4-flash',name:'deepseek-v4-flash',provider:'deepseek',api:'openai-completions',baseUrl:'https://api.deepseek.com',reasoning:true,input:['text'],contextWindow:1000000,maxTokens:8000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{thinkingFormat:'deepseek',supportsReasoningEffort:false,supportsDeveloperRole:false}},
    {systemPrompt:'SYSTEM',messages:[{role:'user',content:'PROMPT',timestamp:0}],tools:definitions},
    {apiKey:'local-capture-no-credential',maxTokens:8000,maxRetries:0,fetch:async(input:any,init:any)=>{
      captured.push({url:String(input),body:JSON.parse(init.body)});
      throw new Error('LOCAL_CAPTURE_STOP_BEFORE_NETWORK');
    }}).result();
  assert.equal(captured.length,1);
  assert.equal(result.stopReason,'error');
  const serialized=captured[0].body.tools.find((tool:any)=>tool.function.name===card.name).function.parameters;
  assert.equal(serialized.type,'object');
  assert.deepEqual(serialized,JSON.parse(JSON.stringify(card.parameters)));
  assert.equal(serialized.anyOf.length,3);
  const validate=(args:any,parameters=serialized)=>validateToolArguments({...card,parameters},{type:'toolCall',id:'call',name:card.name,arguments:args});
  const valid=[{action:'read',version:'v0'},{action:'update',parentVersion:'v0',skill:'Candidate',reason:'Task evidence'},{action:'no-change',decisionToken:token,reason:'Evidence does not support a change.'}];
  const invalid=[{action:'create'},{action:'read',decisionToken:token},{action:'update',skill:'Candidate',reason:'Task evidence'},{action:'update',parentVersion:'v0',skill:'Candidate'},{action:'update',parentVersion:'v0',reason:'Task evidence',decisionToken:token},{action:'no-change',decisionToken:token,reason:'x',roleId:ALIGNER_ROLE},{action:'no-change',decisionToken:token,reason:'x',parentVersion:'v0'},{action:'no-change',observationReceiptSha256:binding.observationReceiptSha256,parentVersion:'v0',parentDigest:parent.digest,reason:'x'},{action:'no-change',decisionToken:'bad',reason:'x'},{action:'no-change',decisionToken:token,reason:''}];
  for(const parameters of [card.parameters,serialized]){
    for(const args of valid)assert.deepEqual(validate(args,parameters),args);
    for(const args of invalid)assert.throws(()=>validate(args,parameters),/Validation failed/);
  }
  const read=await card.execute('read',validate(valid[0]));
  assert.equal(JSON.parse(read.content[0].text).digest,parent.digest);
  const recorded=await card.execute('decision',validate(valid[2]));
  assert.equal(JSON.parse(recorded.content[0].text).parentDigest,parent.digest);
  assert.equal(JSON.parse(await readFile(join(root,'modification-no-change-receipt.json'),'utf8')).reason,valid[2]!.reason);
});
