import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HumanWorkflows} from '../src/human-workflows.js';
import {askHuman,pendingHumanQuestions,writeControlJson,registerHumanRuntime,workflowCost,humanWaitPending} from '../src/human-workflow-channel.js';
import {parseAgentTaskEvents} from '../src/agent-task-runner.js';
import {runPiTask,parsePiTaskEvents} from '../src/pi-task-runner.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
function fixture(){const root=mkdtempSync(join(tmpdir(),'human-workflow-'));for(const name of ['requirements','gold','skill'])writeFileSync(join(root,name+'.md'),'original '+name);return {root,cwd:root,input:{kind:'refine',requirementsPath:join(root,'requirements.md'),goldPath:join(root,'gold.md'),activeSkillPath:join(root,'skill.md')}};}
test('prepare/edit never calls a model; confirmation runs exactly one frozen round',async()=>{
 const f=fixture();let calls=0,finish:(value:any)=>void=()=>{},captured:any;
 const service=new HumanWorkflows({...f,refineRunner:async options=>{calls++;captured=options;return new Promise(resolve=>{finish=resolve;});}});
 let task=service.create(f.input);assert.equal(calls,0);
 task=service.editSkill(task.id,{version:task.version,expectedSha256:task.skillSha256,content:'new skill'});
 assert.equal(readFileSync(f.input.activeSkillPath,'utf8'),'original skill');assert.equal(calls,0);
 assert.throws(()=>service.editSkill(task.id,{version:1,content:'stale'}),/已变化/);
 assert.throws(()=>service.continue(task.id,{version:task.version}),/确认/);
 const version=task.version;task=service.continue(task.id,{version,confirm:true});assert.equal(calls,1);
 assert.throws(()=>service.continue(task.id,{version,confirm:true}),/已变化/);
 assert.throws(()=>service.editSkill(task.id,{version:task.version,expectedSha256:task.skillSha256,content:'while running'}),/运行中/);
 assert.equal(readFileSync(captured.activeSkillPath,'utf8'),'new skill');
 finish({status:'rejected',stageArtifacts:{}});await tick();task=service.get(task.id);assert.equal(task.status,'round-complete');assert.equal(calls,1);
 task=service.continue(task.id,{version:task.version,confirm:true});assert.equal(calls,2);finish({status:'rejected',stageArtifacts:{}});await tick();
 assert.equal(service.get(task.id).rounds.length,2);
});
test('Harness waits for actual answer, receives added boundary, never treats user text as Evidence',async()=>{
 const f=fixture(),configPath=join(f.root,'harness.json');writeControlJson(configPath,{cases:[],parents:[],providerExtensions:[],task:{},guardExtensions:{review:['guard'],boundary:['guard']}});
 let answer:any,control='';const service=new HumanWorkflows({...f,harnessRunner:async options=>{control=options.humanControlDirectory!;answer=await askHuman(control,'版本号缺失是否影响此任务？',{},5);return {status:'candidates-saved',root:options.outputRoot,sessionId:'local'};}});
 let task=service.create({kind:'harness',configPath});task=service.continue(task.id,{version:task.version,confirm:true});await tick();task=service.get(task.id);
 assert.equal(task.status,'waiting-answer');assert.equal(humanWaitPending(control),true);
 task=service.boundary(task.id,{version:task.version,text:'版本号仅作为覆盖率约束'});
 const id=task.pendingQuestions[0].id;task=service.answer(task.id,{version:task.version,questionId:id,answer:'本例不要求版本号'});
 assert.throws(()=>service.answer(task.id,{version:task.version,questionId:id,answer:'重复'}),/已回答/);
 await tick();assert.equal(service.get(task.id).status,'round-complete');assert.equal(answer.answer,'本例不要求版本号');assert.equal(answer.boundaries.length,1);assert.match(answer.note,/不自动成为原文 Evidence/);
});
test('cost ledger distinguishes unreported cost and blocks another round; stop aborts wait',async()=>{
 const f=fixture(),control=join(f.root,'control');mkdirSync(control);
 const handlers:Record<string,Function>={};registerHumanRuntime({on:(name:string,fn:Function)=>{handlers[name]=fn;}},control);
 await handlers.before_provider_request!({},{});assert.equal(workflowCost([control]).unsettledRequests,1);
 handlers.message_end!({message:{role:'assistant',usage:{cost:{total:0.01},totalTokens:3}}});assert.equal(workflowCost([control]).settledUsd,0.01);
 await handlers.before_provider_request!({},{});handlers.message_end!({message:{role:'assistant',usage:{}}});assert.equal(workflowCost([control]).unsettledRequests,1);
 const waiting=askHuman(control,'待回答',{},5);assert.equal(pendingHumanQuestions(control).length,1);writeControlJson(join(control,'stop.json'),{});await assert.rejects(waiting,/USER_STOPPED/);
 let aborted=false;await assert.rejects(()=>handlers.before_provider_request!({},{abort:()=>{aborted=true;}}),/USER_STOPPED/);assert(aborted);
 const service=new HumanWorkflows({...f,refineRunner:async opts=>{const dir=join(opts.runRoot,'..','control','usage');mkdirSync(dir,{recursive:true});writeControlJson(join(dir,'missing.json'),{status:'unknown',costUsd:null});return {status:'rejected'};}});
 let task=service.create(f.input);task=service.continue(task.id,{version:task.version,confirm:true});await tick();task=service.get(task.id);assert.throws(()=>service.continue(task.id,{version:task.version,confirm:true}),/未结算/);
});
test('restart fails closed; historical runner imports remain aliases',async()=>{
 const f=fixture();let finish:(value:any)=>void=()=>{};const first=new HumanWorkflows({...f,refineRunner:async()=>new Promise(resolve=>{finish=resolve;})});
 let task=first.create(f.input);task=first.continue(task.id,{version:task.version,confirm:true});
 const second=new HumanWorkflows(f);task=second.get(task.id);assert.equal(task.status,'interrupted');assert.throws(()=>second.continue(task.id,{version:task.version,confirm:true}),/中断/);
 finish({status:'rejected'});await tick();assert.equal(second.get(task.id).status,'interrupted');assert.equal(typeof runPiTask,'function');assert.equal(parsePiTaskEvents,parseAgentTaskEvents);
});
