import test from 'node:test';
import assert from 'node:assert/strict';
import {findPackageJSON} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ALIGNER_ROLE,cardDigest,createExpertCardCopyStore} from '../src/expert-card-copy-store.js';
import {expandCompactFewShotCases} from '../src/expert-card-few-shot.js';
import {createCardReplayRuntime,registerCardReplayTools} from '../src/expert-card-replay-runtime.js';

const syntheticCase=()=>({
  syntheticTaskRequirement:'Produce a complete maintenance notice for an internal audience.',mode:'style',
  sourceText:'The north pump will be inspected on Tuesday.\nAccess remains available through the east gate.',
  targetText:'The south lift will be serviced on Friday.\nUse the west entrance during servicing.',
  expectedMatched:true,
  evidenceRationale:[
    {side:'source',quotedText:'Access remains available',explanation:'The source states its access condition directly.'},
    {side:'target',quotedText:'Use the west entrance',explanation:'The target states its access instruction directly.'},
  ],
  whyBoundaryApplies:'The synthetic task asks for an internal notice; these are complete fixture texts, not a semantic quality verdict.',
  scope:'Only this synthetic infrastructure-test fixture.',
});

async function fixture(contract:'compact-v1'|'legacy'|undefined='compact-v1') {
  const root=await mkdtemp(join(tmpdir(),'compact-card-contract-'));
  const source={roleId:ALIGNER_ROLE,systemPrompt:'Original production source remains unchanged.'};
  const store=createExpertCardCopyStore(join(root,'copies'),source,async()=>{throw Error('Expert execution forbidden in fixture');},{maxUpdates:4});
  const original=await store.card({action:'create',roleId:ALIGNER_ROLE});
  const parent=await store.card({action:'update',roleId:ALIGNER_ROLE,parentVersion:'v0',systemPrompt:'PARENT IMPLEMENTATION',skill:'PARENT CARD SKILL',fewShotCases:expandCompactFewShotCases([syntheticCase()]),reason:'HISTORICAL_SELF_JUSTIFICATION_SENTINEL'});
  const receiptPath=join(root,'diagnosis.json');
  const receipt=JSON.stringify({kind:'frozen-observation-receipt',epistemicStatus:'model-observation-not-gold',observation:'This diagnosis retains uncertainty.'});
  await writeFile(receiptPath,receipt);
  await writeFile(join(root,'provider-budget.json'),JSON.stringify({inFlight:{},blocked:null,accountingUnknown:null}));
  const binding={observationReceiptSha256:cardDigest(receipt),parentVersion:'v1',parentDigest:parent.digest,startStateSha256:cardDigest(await store.snapshot())};
  const config:any={root,source,storeOptions:{maxUpdates:4,reviewedCopies:{},trialAuthorization:{id:'fixture-only',allowedNewVersions:['v2'],originVersions:{v0:original.digest,v1:parent.digest},requireReadyForTrial:true,allowConfirmation:false}},generationOnly:true,defaultCardVersion:'v1',separatedModificationDecision:binding,settledTrialEvidence:{budgetRoot:root},...(contract?{modificationToolContract:contract}:{}),evidence:{sessions:{},artifacts:{diagnosis:{path:receiptPath,sha256:cardDigest(receipt)}},defaultArtifacts:{}},stageVisibility:{artifactIds:['diagnosis'],sessionIds:[],versionIds:[],cardReadVersions:['v1'],updateParentVersions:['v1'],allowDynamicArtifacts:false,allowVersionBundles:false,allowCreate:false}};
  const runtime=createCardReplayRuntime(config,async()=>{throw Error('Expert execution forbidden in fixture');});
  const definitions:any[]=[];
  const hooks=new Map<string,Function>();
  registerCardReplayTools({registerTool:(definition:any)=>definitions.push(definition),on:(name:string,handler:Function)=>hooks.set(name,handler),setActiveTools(){}},runtime,join(root,'engineering-stop.json'));
  const invoke=async(name:string,args:any)=>{
    const definition=definitions.find(tool=>tool.name===name);
    assert(definition,`Expected tool ${name}`);
    const result=await definition.execute('fixture-call',args);
    return JSON.parse(result.content[0].text);
  };
  return {root,store,parent,original,receiptPath,binding,config,runtime,definitions,hooks,invoke};
}

test('compact reads expose complete implementation and cases but no historical justification or bindings',async()=>{
  const f=await fixture();
  const before=await f.store.snapshot();
  const read=await f.invoke('expert_card_read',{});
  assert.deepEqual(read,{systemPrompt:f.parent.systemPrompt,skill:f.parent.skill,fewShotCases:f.parent.fewShotCases});
  assert(!JSON.stringify(read).includes('HISTORICAL_SELF_JUSTIFICATION_SENTINEL'));
  const inventory=await f.invoke('expert_evidence',{kind:'inventory'});
  assert.deepEqual(inventory.artifacts,['diagnosis']);
  assert.deepEqual(inventory.cardAccess,{tool:'expert_card_read'});
  assert.deepEqual(inventory.completion,{tools:['expert_card_update','expert_card_no_change'],pauseAfterSuccess:true});
  assert.doesNotMatch(JSON.stringify(inventory),/decisionToken|parentDigest|observationReceiptSha256|HISTORICAL_SELF_JUSTIFICATION_SENTINEL/);
  assert.deepEqual(await f.store.snapshot(),before);
});

test('compact no-change saves the legacy bound receipt and durably stops further tools/provider work',async()=>{
  const f=await fixture();
  const before=await f.store.snapshot();
  const reason='The evidence is insufficient to justify a specific change; the parent is not certified.';
  assert.deepEqual(await f.invoke('expert_card_no_change',{reason}),{status:'no-change-decision-recorded'});
  const saved=JSON.parse(await readFile(join(f.root,'modification-no-change-receipt.json'),'utf8'));
  const {at,...body}=saved;
  assert.equal(typeof at,'string');
  assert.deepEqual(body,{kind:'separated-modification-no-change',observationReceiptSha256:f.binding.observationReceiptSha256,parentVersion:'v1',parentDigest:f.parent.digest,reason});
  assert.deepEqual(await f.store.snapshot(),before);
  await assert.rejects(f.invoke('expert_card_read',{}),/Planned no-change decision pause/);
  let aborted=false;
  assert.throws(()=>f.hooks.get('before_provider_request')!({}, {abort(){aborted=true;}}),/Planned no-change decision pause/);
  assert.equal(aborted,true);
});

test('compact update binds parent, role and readiness while preserving full case text and pause receipts',async()=>{
  const f=await fixture();
  const example=syntheticCase();
  example.sourceText+='\nSource-only final sentence.';
  example.targetText+='\nTarget-only final sentence.';
  const before=await f.store.snapshot();
  assert.deepEqual(await f.invoke('expert_card_update',{cardSkill:'REVISED CARD SKILL',fewShotCases:[example],reason:'Fixture change with complete texts.'}),{status:'candidate-saved-awaiting-review'});
  const state=await f.store.snapshot();
  const saved=state.versions.v2!;
  assert.equal(saved.parent,'v1');
  assert.equal(saved.roleId,ALIGNER_ROLE);
  assert.equal(saved.systemPrompt,f.parent.systemPrompt);
  assert.equal(saved.skill,'REVISED CARD SKILL');
  assert.deepEqual(state.versions.v0,before.versions.v0);
  assert.deepEqual(state.versions.v1,before.versions.v1);
  assert.deepEqual(state.runs,{});
  assert.equal(state.trialSubmissions!.v2!.readyForTrial,true);
  const expanded=saved.fewShotCases![0]!;
  assert.equal(expanded.sourceAspect.evidences.length,1);
  assert.equal(expanded.targetAspect.evidences.length,1);
  assert.equal(expanded.sourceAspect.evidences[0]!.quote,example.sourceText);
  assert.equal(expanded.targetAspect.evidences[0]!.quote,example.targetText);
  assert.deepEqual(expanded.evidenceRationale,example.evidenceRationale.map(item=>({...item,evidenceIndex:0})));
  assert.equal(expanded.syntheticTaskRequirement,example.syntheticTaskRequirement);
  assert.equal(expanded.whyBoundaryApplies,example.whyBoundaryApplies);
  assert.equal(expanded.scope,example.scope);
  assert.equal(expanded.expectedMatched,example.expectedMatched);
  const pause=JSON.parse(await readFile(join(f.root,'candidate-review-pause.json'),'utf8'));
  assert.equal(pause.kind,'planned-candidate-review-pause');
  assert.equal(pause.version,'v2');
  assert.equal(pause.copyDigest,saved.digest);
  assert.equal(pause.fewShotCasesSha256,cardDigest(saved.fewShotCases));
  await assert.rejects(f.invoke('expert_card_no_change',{reason:'Cannot overwrite the successful update.'}),/Planned candidate review pause/);
});

test('compact tools reject extra binding fields and missing reasons on direct execution, before mutation',async()=>{
  const operations=[
    {name:'expert_card_read',base:{}},
    {name:'expert_card_update',base:{cardSkill:'changed',reason:'fixture'}},
    {name:'expert_card_no_change',base:{reason:'fixture'}},
  ];
  for(const operation of operations){
    for(const [field,value] of Object.entries({parentVersion:'v0',version:'v0',roleId:ALIGNER_ROLE,decisionToken:'a'.repeat(64),readyForTrial:true})){
      const f=await fixture();
      const before=await f.store.snapshot();
      await assert.rejects(f.invoke(operation.name,{...operation.base,[field]:value}),/Invalid .* fields/);
      assert.deepEqual(await f.store.snapshot(),before);
      await assert.rejects(readFile(join(f.root,'modification-no-change-receipt.json')));
      await assert.rejects(readFile(join(f.root,'candidate-review-pause.json')));
    }
  }
  for(const name of ['expert_card_update','expert_card_no_change']){
    for(const reason of [undefined,'','   ']){
      const f=await fixture();
      const before=await f.store.snapshot();
      await assert.rejects(f.invoke(name,{...(name==='expert_card_update'?{cardSkill:'changed'}:{}),...(reason!==undefined?{reason}:{})}));
      assert.deepEqual(await f.store.snapshot(),before);
    }
  }
});

test('compact case validation rejects wrong-side quotes and absent bilateral support, not just JSON shape',async()=>{
  for(const defect of ['wrong-side','missing-side','extra-index'] as const){
    const f=await fixture();
    const example:any=syntheticCase();
    if(defect==='wrong-side')example.evidenceRationale[0].quotedText='Use the west entrance';
    if(defect==='missing-side')example.evidenceRationale[1]={...example.evidenceRationale[0]};
    if(defect==='extra-index')example.evidenceRationale[0].evidenceIndex=0;
    const before=await f.store.snapshot();
    await assert.rejects(f.invoke('expert_card_update',{fewShotCases:[example],reason:'fixture'}),/own side quote|Each synthetic side|Invalid .* fields/);
    assert.deepEqual(await f.store.snapshot(),before);
  }
});

test('compact reads and decisions all reject stale receipt, state or parent bindings',async()=>{
  for(const name of ['expert_card_read','expert_card_update','expert_card_no_change']){
    for(const defect of ['receipt','state','parent'] as const){
      const f=await fixture();
      if(defect==='receipt')await writeFile(f.receiptPath,'CHANGED RECEIPT');
      else{
        const state=await f.store.snapshot();
        if(defect==='state')state.draftSupersessions={};
        else{
          const {digest,...body}=state.versions.v1!;
          state.versions.v1={...body,skill:'Tampered parent with a valid digest',digest:cardDigest({...body,skill:'Tampered parent with a valid digest'})};
          // Isolate parent binding verification from the separate whole-state guard.
          f.binding.startStateSha256=cardDigest(state);
        }
        await writeFile(join(f.root,'copies','state.json'),JSON.stringify(state));
      }
      const args=name==='expert_card_read'?{}:name==='expert_card_update'?{cardSkill:'changed',reason:'fixture'}:{reason:'fixture'};
      const before=await f.store.snapshot();
      await assert.rejects(f.invoke(name,args),/Artifact changed|state changed|parent Card changed/);
      assert.deepEqual(await f.store.snapshot(),before);
      await assert.rejects(readFile(join(f.root,'modification-no-change-receipt.json')));
      await assert.rejects(readFile(join(f.root,'candidate-review-pause.json')));
    }
  }
});

test('compact update requires an effective edit; clearing cases and Card skill remains explicit',async()=>{
  for(const fields of [{},{cardSkill:'PARENT CARD SKILL'},{systemPrompt:'PARENT IMPLEMENTATION'}]){
    const f=await fixture();
    await assert.rejects(f.invoke('expert_card_update',{...fields,reason:'fixture'}),/requires changed content/);
  }
  const f=await fixture();
  await f.invoke('expert_card_update',{cardSkill:'',fewShotCases:[],reason:'Explicit fixture clearing.'});
  const candidate=(await f.store.snapshot()).versions.v2!;
  assert.equal(candidate.skill,'');
  assert.deepEqual(candidate.fewShotCases,[]);
});

test('compact contract is opt-in and cannot be registered without a separated decision binding',async()=>{
  const legacy=await fixture('legacy');
  assert(legacy.definitions.some(tool=>tool.name==='expert_card_copy'));
  assert(!legacy.definitions.some(tool=>tool.name==='expert_card_read'));
  const config={...legacy.config};
  delete config.modificationToolContract;
  const names:string[]=[];
  registerCardReplayTools({registerTool:(tool:any)=>names.push(tool.name),on(){},setActiveTools(){}},createCardReplayRuntime(config,async()=>{}),join(legacy.root,'legacy-stop.json'));
  assert(names.includes('expert_card_copy'));
  const unboundState={...config,modificationToolContract:'compact-v1',separatedModificationDecision:{...config.separatedModificationDecision}};
  delete unboundState.separatedModificationDecision.startStateSha256;
  assert.throws(()=>createCardReplayRuntime(unboundState,async()=>{}),/state|binding|prepared/i);
  delete config.separatedModificationDecision;
  config.modificationToolContract='compact-v1';
  assert.throws(()=>createCardReplayRuntime(config,async()=>{}),/Compact tools require a bound separated modification stage/);
});

test('SDK serialization keeps compact object schemas strict and reports the total definition reduction',async t=>{
  const sdkRoot=dirname(findPackageJSON('@earendil-works/pi-ai',import.meta.resolve('@earendil-works/pi-coding-agent'))!);
  const {stream}=await import(pathToFileURL(join(sdkRoot,'dist/api/openai-completions.js')).href);
  const {validateToolArguments}=await import(pathToFileURL(join(sdkRoot,'dist/utils/validation.js')).href);
  const compact=await fixture(),legacy=await fixture('legacy');
  const captured:any[]=[];
  for(const definitions of [compact.definitions,legacy.definitions]){
    const result=await stream({id:'deepseek-v4-flash',name:'deepseek-v4-flash',provider:'deepseek',api:'openai-completions',baseUrl:'https://api.deepseek.com',reasoning:true,input:['text'],contextWindow:1000000,maxTokens:8000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{thinkingFormat:'deepseek',supportsReasoningEffort:false,supportsDeveloperRole:false}},
      {systemPrompt:'SYSTEM',messages:[{role:'user',content:'PROMPT',timestamp:0}],tools:definitions},
      {apiKey:'local-capture-no-credential',maxTokens:8000,maxRetries:0,fetch:async(input:any,init:any)=>{
        captured.push({url:String(input),body:JSON.parse(init.body)});
        throw Error('LOCAL_CAPTURE_STOP_BEFORE_NETWORK');
      }}).result();
    assert.equal(result.stopReason,'error');
  }
  assert.equal(captured.length,2);
  const sent=captured[0].body.tools;
  assert.deepEqual(sent.map((tool:any)=>tool.function.name).sort(),['expert_card_read','expert_card_update','expert_card_no_change','expert_evidence'].sort());
  for(const definition of compact.definitions){
    const serialized=sent.find((tool:any)=>tool.function.name===definition.name).function.parameters;
    assert.equal(serialized.type,'object');
    assert.deepEqual(serialized,JSON.parse(JSON.stringify(definition.parameters)));
    const valid=definition.name==='expert_card_read'?{}:definition.name==='expert_card_update'?{fewShotCases:[syntheticCase()],reason:'fixture'}:definition.name==='expert_card_no_change'?{reason:'fixture'}:{kind:'inventory'};
    const validate=(args:any)=>validateToolArguments({...definition,parameters:serialized},{type:'toolCall',id:'fixture',name:definition.name,arguments:args});
    assert.deepEqual(validate(valid),valid);
    assert.throws(()=>validate({...valid,roleId:ALIGNER_ROLE}),/Validation failed/);
  }
  const measurable=(definitions:any[])=>JSON.stringify(definitions.map(({name,description,parameters})=>({type:'function',function:{name,description,parameters}}))).length;
  const compactChars=measurable(compact.definitions),legacyChars=measurable(legacy.definitions);
  const schemaChars=(definitions:any[])=>definitions.reduce((total,tool)=>total+JSON.stringify(tool.parameters).length,0);
  const descriptionChars=(definitions:any[])=>definitions.reduce((total,tool)=>total+tool.description.length,0);
  const metrics={unit:'characters-not-tokens',legacyTools:legacy.definitions.length,compactTools:compact.definitions.length,legacyChars,compactChars,reductionChars:legacyChars-compactChars,reductionPercent:Number(((legacyChars-compactChars)/legacyChars*100).toFixed(2)),legacySchemaChars:schemaChars(legacy.definitions),compactSchemaChars:schemaChars(compact.definitions),legacyDescriptionChars:descriptionChars(legacy.definitions),compactDescriptionChars:descriptionChars(compact.definitions),legacySdkSerializedToolsChars:JSON.stringify(captured[1].body.tools).length,compactSdkSerializedToolsChars:JSON.stringify(sent).length};
  t.diagnostic(JSON.stringify(metrics));
  assert(compactChars<legacyChars,'The aggregate schema must shrink despite using separate tools.');
  if(process.env.CARD_COMPACT_CAPTURE){
    const output=process.env.CARD_COMPACT_CAPTURE;
    await mkdir(output,{recursive:true});
    await writeFile(join(output,'compact-sdk-request.json'),JSON.stringify(captured[0],null,2));
    await writeFile(join(output,'legacy-sdk-request.json'),JSON.stringify(captured[1],null,2));
    await writeFile(join(output,'schema-size-comparison.json'),JSON.stringify({...metrics,providerRequestsSent:0,capture:'Actual SDK serialization with local injected fetch; exception raised before network.'},null,2));
  }
});
