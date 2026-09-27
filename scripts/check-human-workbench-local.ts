// Manual UI fixture. Both execution paths are local stubs, with no provider installed.
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWebDashboard} from '../src/web-dashboard.js';
import {askHuman,writeControlJson} from '../src/human-workflow-channel.js';
const root=mkdtempSync(join(tmpdir(),'workflow-ui-'));
for(const name of ['requirements','gold','skill'])writeFileSync(join(root,name+'.md'),`# 本地界面验证 · ${name}\n\n这不是模型产物。请核对可观察证据，不把措辞等同于判断。\n`);
writeControlJson(join(root,'harness.json'),{cases:[],parents:[],providerExtensions:[],task:{},guardExtensions:{review:['local-stub'],boundary:['local-stub']}});
const dashboard=await startWebDashboard({cwd:root,port:0,sessionDir:join(root,'sessions'),codexSessionRoot:join(root,'codex'),
 refineWorkflowRunner:async options=>{const dir=join(options.runRoot!,'local');mkdirSync(dir,{recursive:true});const candidateSkillPath=join(dir,'candidate.md');writeFileSync(candidateSkillPath,'# 本地候选 Skill\n只根据可核查差异判断。');return {status:'local-fixture',runId:'local',runDirectory:dir,manifestPath:join(dir,'manifest.json'),descriptionPath:join(dir,'description.md'),draftPath:join(dir,'draft.md'),stageArtifacts:{candidateSkillPath}};},
 harnessWorkflowRunner:async options=>{mkdirSync(options.outputRoot,{recursive:true});const answer=await askHuman(options.humanControlDirectory!,'版本号缺失是否属于本任务的覆盖要求？');writeControlJson(join(options.outputRoot,'review.json'),{review:'本地测试已收到回答：'+answer.answer});return {status:'candidates-saved',root:options.outputRoot,sessionId:'local-fixture'};}});
console.log(JSON.stringify({url:dashboard.url,fixtureDirectory:root}));
for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>void dashboard.close());
