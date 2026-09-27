import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runFixedRefineWorkflow } from './refine-workflow-agent.js';
import { runMultiCaseHarness } from './harness-multi-case.js';
import { bundledProviderExtensionPath } from './agent-task-runner.js';
import { PRODUCTION_RULES } from './production-rules.js';
import { pendingHumanQuestions, readControlJson, workflowCost, writeControlJson } from './human-workflow-channel.js';

const hash = (text:string) => createHash('sha256').update(text).digest('hex');
const bounded = (value:unknown, name:string, max=200000) => { if(typeof value!=='string'||!value.trim()||value.length>max) throw new HumanWorkflowError(422,`${name} 不能为空或超过 ${max} 字符`); return value; };
export class HumanWorkflowError extends Error { constructor(readonly status:number,message:string){super(message);} }
interface WorkflowState {
  id:string; kind:'refine'|'harness'; title:string; version:number; status:'ready'|'running'|'round-complete'|'failed'|'stopped'|'interrupted'; owner:string;
  round:number; createdAt:string; updatedAt:string; inputs:Record<string,string>; boundaries:Array<{id:string;text:string;source:'user'}>;
  rounds:Array<{number:number;controlDirectory:string;skillSha256?:string;result?:any;error?:string}>;
}
export interface HumanWorkflowOptions {
  root:string; cwd:string;
  refineRunner?: (options:any)=>Promise<any>;
  harnessRunner?: typeof runMultiCaseHarness;
}
export class HumanWorkflows {
  private owner = randomUUID();
  private active = new Set<string>();
  constructor(private options:HumanWorkflowOptions) { mkdirSync(options.root,{recursive:true}); }
  private directory(id:string) { if(!/^[0-9a-f-]{36}$/.test(id)) throw new HumanWorkflowError(404,'任务不存在'); return join(this.options.root,id); }
  private read(id:string):WorkflowState { const path=join(this.directory(id),'state.json'); if(!existsSync(path))throw new HumanWorkflowError(404,'任务不存在'); return readControlJson(path); }
  private save(state:WorkflowState) { state.updatedAt=new Date().toISOString(); writeControlJson(join(this.directory(state.id),'state.json'),state); }
  private check(state:WorkflowState,version:unknown) { if(version!==state.version)throw new HumanWorkflowError(409,'内容已变化，请刷新后再确认'); }
  private editable(state:WorkflowState) { if(state.status==='running')throw new HumanWorkflowError(409,'本轮运行中；Skill 请在本轮结束后修改'); }
  private channels(state:WorkflowState) {return state.rounds.map(r=>r.controlDirectory);}
  list() { return readdirSync(this.options.root).filter(n=>/^[0-9a-f-]{36}$/.test(n)&&existsSync(join(this.options.root,n,'state.json'))).map(id=>this.get(id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  get(id:string) {
    const state=this.read(id);
    if(state.status==='running'&&state.owner!==this.owner) {
      for(const round of state.rounds)writeControlJson(join(round.controlDirectory,'stop.json'),{reason:'server-restarted'});
      state.status='interrupted';state.version++;this.save(state);
    }
    const last=state.rounds.at(-1),pending=last?pendingHumanQuestions(last.controlDirectory):[];
    const skillPath=join(this.directory(id),'current-skill.md');
    const skillText=state.kind==='refine'?readFileSync(skillPath,'utf8'):null;
    const {inputs,owner,...visible}=state;
    return {...visible,status:state.status==='running'&&pending.length?'waiting-answer':state.status,cost:workflowCost(this.channels(state)),roundCost:last?workflowCost([last.controlDirectory]):null,pendingQuestions:pending,skillText,skillSha256:skillText===null?null:hash(skillText),skillScope:'本任务当前 Skill；不覆盖导入的原文件',running:this.active.has(id)};
  }
  artifact(id:string,roundNumber:number,key:string) {
    const state=this.read(id),round=state.rounds.find(r=>r.number===roundNumber);
    const artifacts=round?.result?.stageArtifacts || {};
    const candidate=artifacts[key];if(typeof candidate!=='string')throw new HumanWorkflowError(404,'阶段原件不存在');
    const root=realpathSync(join(this.directory(id),'rounds',String(roundNumber))),rel=relative(root,realpathSync(resolve(candidate)));
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new HumanWorkflowError(403,'原件不在本轮目录内');
    return {key,round:roundNumber,content:readFileSync(candidate,'utf8')};
  }
  create(input:any) {
    if(!input||!['refine','harness'].includes(input.kind))throw new HumanWorkflowError(422,'请选择 Refine 或 Harness');
    const id=randomUUID(),dir=this.directory(id),kind=input.kind as WorkflowState['kind'];
    const inputs:Record<string,string>={};
    const readInput=(name:string)=>{const path=resolve(this.options.cwd,bounded(input[name],name,4096));return {path,content:readFileSync(path)};};
    // Validate every input before creating a task; copying does not run a model.
    const files=kind==='refine'?{requirementsPath:readInput('requirementsPath'),goldPath:readInput('goldPath'),activeSkillPath:readInput('activeSkillPath')}:{configPath:readInput('configPath')};
    if(kind==='harness') {
      const config=JSON.parse(files.configPath!.content.toString('utf8'));
      if(!Array.isArray(config.cases)||!Array.isArray(config.parents)||!config.guardExtensions?.review?.length||!config.guardExtensions?.boundary?.length)throw new HumanWorkflowError(422,'Harness 配置必须含固定 cases、parents 和现有 review / boundary 费用 guards');
    }
    mkdirSync(dir);mkdirSync(join(dir,'inputs'));mkdirSync(join(dir,'rounds'));
    for(const [name,file]of Object.entries(files)){if(!file)continue;const extension=/\.[a-z0-9]+$/i.exec(file.path)?.[0]||'.txt';const target=join(dir,'inputs',name+extension);writeFileSync(target,file.content,{flag:'wx'});inputs[name]=target;}
    inputs.provider=typeof input.provider==='string'&&input.provider.trim()?input.provider.trim():'deepseek';
    inputs.model=typeof input.model==='string'&&input.model.trim()?input.model.trim():'deepseek-v4-flash';
    if(kind==='refine'){writeFileSync(join(dir,'current-skill.md'),files.activeSkillPath!.content,{flag:'wx'});writeControlJson(join(dir,'inputs','rules.json'),PRODUCTION_RULES);}
    const now=new Date().toISOString();
    const state:WorkflowState={id,kind,title:typeof input.title==='string'&&input.title.trim()?input.title.trim().slice(0,120):kind==='refine'?'文稿 Skill 优化':'Expert 判断审查',version:1,status:'ready',owner:this.owner,round:0,createdAt:now,updatedAt:now,inputs,boundaries:[],rounds:[]};
    this.save(state);return this.get(id);
  }
  editSkill(id:string,input:any) {
    const state=this.read(id);this.check(state,input.version);this.editable(state);
    if(state.kind!=='refine')throw new HumanWorkflowError(422,'此任务没有写作 Skill');
    const content=bounded(input.content,'Skill'),path=join(this.directory(id),'current-skill.md'),prior=readFileSync(path,'utf8');
    if(input.expectedSha256!==hash(prior))throw new HumanWorkflowError(409,'Skill 版本冲突');
    writeFileSync(join(this.directory(id),`skill-before-edit-${state.version}.md`),prior,{flag:'wx'});
    writeFileSync(path,content);state.version++;this.save(state);return this.get(id);
  }
  boundary(id:string,input:any) {
    const state=this.read(id);this.check(state,input.version);
    if(state.kind!=='harness')throw new HumanWorkflowError(422,'用户边界应追加到 Harness 任务');
    if(state.status==='running'&&!pendingHumanQuestions(state.rounds.at(-1)!.controlDirectory).length)throw new HumanWorkflowError(409,'运行中的边界已冻结；请等提问或本轮结束后追加');
    state.boundaries.push({id:randomUUID(),text:bounded(input.text,'边界',12000),source:'user'});
    if(state.status==='running')writeControlJson(join(state.rounds.at(-1)!.controlDirectory,'boundaries.json'),state.boundaries);
    state.version++;this.save(state);return this.get(id);
  }
  answer(id:string,input:any) {
    const state=this.read(id);this.check(state,input.version);
    if(state.status!=='running'||!this.active.has(id))throw new HumanWorkflowError(409,'本轮未运行，不能续接旧问题');
    const root=state.rounds.at(-1)!.controlDirectory;
    if(!pendingHumanQuestions(root).some(q=>q.id===input.questionId))throw new HumanWorkflowError(409,'问题已回答或不存在');
    writeControlJson(join(root,'answers',input.questionId+'.json'),{answer:bounded(input.answer,'回答',12000),source:'user',at:new Date().toISOString()});
    state.version++;this.save(state);return this.get(id);
  }
  stop(id:string,input:any) {
    const state=this.read(id);this.check(state,input.version);
    for(const round of state.rounds)writeControlJson(join(round.controlDirectory,'stop.json'),{at:new Date().toISOString(),source:'user'});
    state.status='stopped';state.version++;this.save(state);return this.get(id);
  }
  continue(id:string,input:any) {
    const state=this.read(id);this.check(state,input.version);
    if(this.active.has(id)||!['ready','round-complete'].includes(state.status))throw new HumanWorkflowError(409,'只有待开始或已完成的任务可以开始下一轮；失败与中断需先核查记录');
    if(input.confirm!==true)throw new HumanWorkflowError(422,'需要明确确认本轮将产生模型费用');
    const costs=workflowCost(this.channels(state));if(costs.unsettledRequests)throw new HumanWorkflowError(409,'存在未结算请求；请核对费用后再运行');
    const number=state.round+1,roundDirectory=join(this.directory(id),'rounds',String(number)),controlDirectory=join(roundDirectory,'control');mkdirSync(controlDirectory,{recursive:true});
    writeControlJson(join(controlDirectory,'boundaries.json'),state.boundaries);
    const skill=state.kind==='refine'?readFileSync(join(this.directory(id),'current-skill.md'),'utf8'):undefined;
    if(skill!==undefined)writeFileSync(join(roundDirectory,'SKILL.md'),skill,{flag:'wx'});
    state.round=number;state.status='running';state.owner=this.owner;state.version++;
    state.rounds.push({number,controlDirectory,...(skill!==undefined?{skillSha256:hash(skill)}:{})});this.save(state);this.active.add(id);
    void this.execute(state,roundDirectory,controlDirectory).finally(()=>this.active.delete(id));
    return this.get(id);
  }
  private async execute(initial:WorkflowState,roundDirectory:string,controlDirectory:string) {
    try {
      const extension=join(roundDirectory,'user-control-extension.ts');
      const moduleUrl=pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),'human-workflow-channel.ts')).href;
      writeFileSync(extension,`import {registerHumanRuntime} from ${JSON.stringify(moduleUrl)}; export default runtime=>registerHumanRuntime(runtime,${JSON.stringify(controlDirectory)});\n`,{flag:'wx'});
      let result:any;
      if(initial.kind==='refine') {
        result=await (this.options.refineRunner??runFixedRefineWorkflow)({cwd:this.options.cwd,provider:initial.inputs.provider!,model:initial.inputs.model!,requirementsPath:initial.inputs.requirementsPath!,goldPath:initial.inputs.goldPath!,activeSkillPath:join(roundDirectory,'SKILL.md'),rulesPath:join(this.directory(initial.id),'inputs','rules.json'),runRoot:join(roundDirectory,'runs'),timeoutMs:600000,extensionPaths:[...(initial.inputs.provider==='deepseek'?[bundledProviderExtensionPath()]:[]),extension],auxiliaryDiagnostics:'deferred-for-controlled-experiment'});
      } else {
        const original=readControlJson(initial.inputs.configPath!);
        result=await (this.options.harnessRunner??runMultiCaseHarness)({...original,outputRoot:join(roundDirectory,'harness'),humanControlDirectory:controlDirectory,providerExtensions:[...(original.providerExtensions??[]),extension],task:{...original.task,humanControlDirectory:controlDirectory}},true);
        const artifacts:Record<string,string>={};
        for(const [key,path]of [['reviewPath',join(result.root,'review.json')],...Object.keys(original.parents.reduce((acc:any,p:any)=>({...acc,[p.roleId.includes('aligner')?'aligner':'matcher']:true}),{})).map(role=>[role+'CardAppend',join(result.root,'roles',role,'card-append-receipt.json')])])if(key&&path&&existsSync(path))artifacts[key]=path;
        result={...result,stageArtifacts:artifacts};
      }
      writeControlJson(join(roundDirectory,'result.json'),result);
      const state=this.read(initial.id);state.rounds.at(-1)!.result=result;
      if(state.status==='running'&&state.owner===this.owner)state.status='round-complete';state.version++;this.save(state);
    } catch(error) {
      const state=this.read(initial.id);state.rounds.at(-1)!.error=error instanceof Error?error.message:String(error);
      if(state.status==='running'&&state.owner===this.owner)state.status='failed';state.version++;this.save(state);
    }
  }
}
