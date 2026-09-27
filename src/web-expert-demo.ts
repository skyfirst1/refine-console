import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,lstat,realpath,open,rmdir} from 'node:fs/promises';
import {resolve,relative,sep,basename,isAbsolute} from 'node:path';
import {reduceExpertScore} from './refine-expert-pipeline.js';
import type {SummaryInput} from './expert-reason-summary.js';

export interface DemoArtifact {id:string;title:string;path:string;sha256:string}
export interface DemoPreset {id:string;title:string;sourceLabel:string;evaluationId:string;evaluationIds:string[];moduleArtifactIds:{refine:string[];harness:string[];cards:string[]};notice:string}
export interface DemoRegistry {schemaVersion:'1';allowedRoots:string[];artifacts:DemoArtifact[];evaluations:any[];presets?:DemoPreset[];defaultPresetId?:string;defaultCaseId?:string}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const record=(x:any)=>x&&typeof x==='object'&&!Array.isArray(x);
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));};
const identifier=(s:unknown)=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(s);
export class DemoError extends Error {constructor(public status:number,message:string){super(message);}}

/** Explicit local registry: HTTP callers can select IDs, never filesystem paths. */
export class ExpertDemoStore {
 private registry:DemoRegistry={schemaVersion:'1',allowedRoots:[],artifacts:[],evaluations:[]};
 private sessions:Array<{entry:any;artifacts:DemoArtifact[];root:string}>=[];
 constructor(private options:{registryPath?:string|undefined;feedbackRoot:string}){}
 async load(){
  const r=this.options.registryPath?JSON.parse(await readFile(this.options.registryPath,'utf8')):{schemaVersion:'1',allowedRoots:[],artifacts:[],evaluations:[]};
  if(r.schemaVersion!=='1'||!Array.isArray(r.allowedRoots)||!Array.isArray(r.artifacts)||!Array.isArray(r.evaluations))throw new DemoError(422,'Invalid demo registry');
  if(new Set(r.artifacts.map((a:any)=>a.id)).size!==r.artifacts.length||r.artifacts.some((a:any)=>!identifier(a.id)||!/^[a-f0-9]{64}$/.test(a.sha256)))throw new DemoError(422,'Invalid artifact identity');
  const presetIds=new Set<string>();
  if(r.presets!==undefined&&!Array.isArray(r.presets))throw new DemoError(422,'Invalid history presets');
  for(const p of r.presets??[]){
   if(!identifier(p.id)||presetIds.has(p.id)||typeof p.title!=='string'||typeof p.sourceLabel!=='string'||typeof p.notice!=='string'||!Array.isArray(p.evaluationIds)||!p.evaluationIds.includes(p.evaluationId)||p.evaluationIds.some((id:string)=>!r.evaluations.some((e:any)=>e.id===id))||!record(p.moduleArtifactIds)||Object.keys(p.moduleArtifactIds).some(k=>!['refine','harness','cards'].includes(k))||['refine','harness','cards'].some(k=>!Array.isArray(p.moduleArtifactIds[k])||p.moduleArtifactIds[k].some((id:string)=>!r.artifacts.some((a:any)=>a.id===id))))throw new DemoError(422,'Invalid history preset binding');
   presetIds.add(p.id);
  }
  if(r.defaultPresetId!==undefined&&!presetIds.has(r.defaultPresetId))throw new DemoError(422,'Unknown default preset');
  this.registry=r;
  for(const s of this.sessions){this.registry.allowedRoots.push(s.root);this.registry.artifacts.push(...s.artifacts);this.registry.evaluations.push(s.entry);}
 }
 private async raw(id:string){
  const a=this.registry.artifacts.find(a=>a.id===id);if(!a||!identifier(id))throw new DemoError(404,'Artifact not registered');
  const path=resolve(a.path),roots=this.registry.allowedRoots.map(r=>resolve(r));
  const root=roots.find(r=>within(r,path));if(!root||/(^|[._-])(key|secret|credential|token|password|ledger)([._-]|$)/i.test(basename(path))||basename(path).startsWith('.env'))throw new DemoError(403,'Artifact is outside the read scope');
  const canonicalRoot=await realpath(root),canonical=await realpath(path);
  if(!within(canonicalRoot,canonical)||canonical.toLowerCase()!==path.toLowerCase())throw new DemoError(403,'Symlink artifacts are not available');
  let current=path;while(true){if((await lstat(current)).isSymbolicLink())throw new DemoError(403,'Symlink artifacts are not available');if(current===root)break;const next=resolve(current,'..');if(next===current)throw new DemoError(403,'Invalid artifact root');current=next;}
  const stat=await lstat(path);if(!stat.isFile()||stat.size>8*1024*1024)throw new DemoError(413,'Artifact unavailable or too large');
  const content=await readFile(path,'utf8');if(digest(content)!==a.sha256)throw new DemoError(409,'Registered artifact changed');return{...a,content};
 }
 async artifact(id:string){await this.load();const {path:_,...a}=await this.raw(id);return a;}
 async cases(){
  await this.load();const cases=[];const ids=new Set<string>();
  for(const evaluation of this.registry.evaluations)for(const c of evaluation.cases??[]){
   if(!identifier(c.id)||ids.has(c.id))throw new DemoError(422,'Case IDs must be unique across evaluations');ids.add(c.id);
   const samples=[];for(const s of c.samples){const a=await this.raw(s.artifactId);samples.push({...s,sourceHash:a.sha256});}
   const sequence=samples.map(s=>({sampleId:s.id,result:s.result})),stable=(v:any):string=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v),distinctResults=new Set(sequence.map(s=>stable(s.result))).size;
   const workflow=c.workflow??{review:{binding:'unavailable'},boundary:{binding:'unavailable'},cards:{binding:'role',cardIds:[]},replay:{binding:'case',artifactIds:samples.filter(s=>s.kind==='candidate').map(s=>s.artifactId)}};
   if(workflow.review?.binding==='case'){const a=await this.raw(workflow.review.artifactId),review=JSON.parse(a.content).review,{start,end}=workflow.review.range??{};if(typeof review!=='string'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>review.length)throw new DemoError(422,'Invalid review slice');workflow.review={...workflow.review,text:review.slice(start,end)};}
   for(const id of [workflow.review?.artifactId,workflow.boundary?.questionArtifactId,workflow.boundary?.answerArtifactId].filter(Boolean))if(!this.registry.artifacts.some(a=>a.id===id))throw new DemoError(422,'Unregistered case workflow artifact');
   cases.push({caseId:c.id,evaluationId:evaluation.id,roleId:c.roleId,axis:c.axis,direction:c.direction,samples,workflow,resultChanges:{kind:distinctResults>1?'changed':'unchanged',distinctResults,sequence}});
  }
  return{defaultCaseId:this.registry.defaultCaseId??cases[0]?.caseId??null,cases};
 }
 async summaryInput(caseId:string):Promise<SummaryInput>{
  const c=(await this.cases()).cases.find(c=>c.caseId===caseId);if(!c)throw new DemoError(404,'Case not registered');
  const samples=[];for(const s of c.samples){const a=await this.raw(s.artifactId);let raw=a.content.trim();const name=c.roleId==='refine.evidence-aligner'?'EVIDENCE_ALIGNMENT':'ASPECT_MATCH',start='<<<'+name+'_START>>>',end='<<<'+name+'_END>>>';
   if(raw.includes(start)||raw.includes(end)){if(raw.split(start).length!==2||raw.split(end).length!==2||raw.indexOf(end)<raw.indexOf(start))throw new DemoError(422,'Ambiguous source output markers');raw=raw.slice(raw.indexOf(start)+start.length,raw.indexOf(end)).trim();}
   raw=raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let p:any;try{p=JSON.parse(raw);}catch{throw new DemoError(422,'Source output cannot be safely projected');}
   if(p.rationale!==s.rationale)throw new DemoError(409,'Rationale projection differs from source');const result=Object.hasOwn(p,'result')?p.result:c.roleId==='refine.evidence-aligner'?p.matched:{direction:p.direction,sourceAspectId:p.sourceAspectId,targetAspectId:p.targetAspectId,matched:p.matched};
   const same=(a:any,b:any)=>JSON.stringify(a&&typeof a==='object'?Object.fromEntries(Object.keys(a).sort().map(k=>[k,a[k]])):a)===JSON.stringify(b&&typeof b==='object'?Object.fromEntries(Object.keys(b).sort().map(k=>[k,b[k]])):b);
   if(!same(result,s.result))throw new DemoError(409,'Result projection differs from source');samples.push({sampleId:s.id,kind:s.kind,result:s.result,rationale:s.rationale,sourceHash:a.sha256});
  }
  return{caseId:c.caseId,scope:{roleId:c.roleId,axis:c.axis,direction:c.direction},samples};
 }
 async overview(){
  await this.load();const evaluations=[];
  for(const entry of this.registry.evaluations){
   const {scoreBinding,...visible}=entry;let score=null;
   if(scoreBinding){
    const value=JSON.parse((await this.raw(scoreBinding.scoreArtifactId)).content),s=value.report??value,goldRaw=await this.raw(scoreBinding.goldAspectArtifactId),docRaw=await this.raw(scoreBinding.documentAspectArtifactId),gold=JSON.parse(goldRaw.content),doc=JSON.parse(docRaw.content);
    if(s.schemaVersion!=='2.0'||s.computedBy?.id!=='expert-score-reducer'||s.computedBy?.method!=='content-style-average'||!Array.isArray(gold.aspects)||!Array.isArray(doc.aspects)||!record(s.sourceInputs))throw new DemoError(422,'Not a complete schema-2 Expert score');
    for(const k of ['recall','precision','f1','overallScore'])if(typeof s[k]!=='number'||!Number.isFinite(s[k])||s[k]<0||s[k]>1)throw new DemoError(422,'Invalid score');
    const f=s.recall+s.precision===0?0:2*s.recall*s.precision/(s.recall+s.precision);
    if(Math.abs(f-s.f1)>1e-12||s.overallScore!==s.f1||![goldRaw.sha256,digest(JSON.stringify(gold))].includes(s.sourceInputs.goldAspectSetSha256)||![docRaw.sha256,digest(JSON.stringify(doc))].includes(s.sourceInputs.documentAspectSetSha256))throw new DemoError(422,'Score provenance mismatch');
    const details:any[]=[];
    if(scoreBinding.recallMatchesArtifactId&&scoreBinding.precisionMatchesArtifactId&&scoreBinding.alignmentsArtifactId){
     const refs=[['recallMatches',scoreBinding.recallMatchesArtifactId],['precisionMatches',scoreBinding.precisionMatchesArtifactId],['evidenceAlignments',scoreBinding.alignmentsArtifactId]],data:Record<string,any>={};
     for(const [key,id]of refs){const raw=await this.raw(id!);data[key!]=JSON.parse(raw.content);if(![raw.sha256,digest(JSON.stringify(data[key!]))].includes(s.sourceInputs[key!+'Sha256']))throw new DemoError(422,'Score detail provenance mismatch');}
     const recalculated=reduceExpertScore({descriptionSha256:s.sourceInputs.descriptionSha256,goldSha256:s.sourceInputs.goldSha256,documentSha256:s.sourceInputs.documentSha256,gold,document:doc,recallMatches:data.recallMatches,precisionMatches:data.precisionMatches,alignments:data.evidenceAlignments});
     if(['recall','precision','f1'].some(k=>Math.abs((recalculated as any)[k]-s[k])>1e-12))throw new DemoError(422,'Score details disagree with original report');
     let index=0;for(const m of [...data.recallMatches,...data.precisionMatches]){const a=m.matched?data.evidenceAlignments[index++]:null;details.push({direction:m.direction,sourceAspectId:m.sourceAspectId,targetAspectId:m.targetAspectId,matched:m.matched,contentMatched:a?.contentMatched??null,styleMatched:a?.styleMatched??null,contribution:a?(Number(a.contentMatched)+Number(a.styleMatched))/2:0});}
    }
    score={schemaVersion:'2.0',recall:s.recall,precision:s.precision,f1:s.f1,overallScore:s.overallScore,denominators:{goldAspects:gold.aspects.length,documentAspects:doc.aspects.length},sourceArtifactId:scoreBinding.scoreArtifactId,sourceInputs:s.sourceInputs,details};
   }
   evaluations.push({...visible,score});
  }
  return{schemaVersion:'1',evaluations,presets:this.registry.presets??[],defaultPresetId:this.registry.defaultPresetId??null,artifactTitles:Object.fromEntries(this.registry.artifacts.map(a=>[a.id,a.title])),notice:'只读诊断展示。候选未通过语义验收，不替换默认专家；局部判断不是评分。反馈仅保存，不自动学习。'};
 }
 private async feedbackFile(){
  const root=resolve(this.options.feedbackRoot);await mkdir(root,{recursive:true});if((await realpath(root)).toLowerCase()!==root.toLowerCase()||(await lstat(root)).isSymbolicLink())throw new DemoError(403,'Invalid feedback directory');return root+'/skill-feedback.jsonl';
 }
 async feedback(){const file=await this.feedbackFile();try{if((await lstat(file)).isSymbolicLink())throw new DemoError(403,'Invalid feedback file');return{items:(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s))};}catch(e:any){if(e.code==='ENOENT')return{items:[]};throw e;}}
 async saveFeedback(body:any){
  await this.load();const keys=['skillId','skillVersion','cardId','cardVersion','thumb','text','paragraph'];
  if(!record(body)||Object.keys(body).some(k=>!keys.includes(k))||!['up','down'].includes(body.thumb)||typeof body.text!=='string'||!body.text.trim()||body.text.length>4000||(body.paragraph!==undefined&&(typeof body.paragraph!=='string'||body.paragraph.length>1000)))throw new DemoError(422,'Invalid feedback');
  const skills=this.registry.evaluations.flatMap(e=>e.skills??[]),cards=this.registry.evaluations.flatMap(e=>e.cards??[]);
  const skill=skills.find(s=>s.id===body.skillId&&s.version===body.skillVersion&&s.cardId===body.cardId&&s.cardVersion===body.cardVersion);
  if(!skill||!skill.text?.trim()||digest(skill.text)!==skill.version||!cards.some(c=>c.id===body.cardId&&c.version===body.cardVersion)||(body.paragraph&&!skill.text.includes(body.paragraph)))throw new DemoError(409,'Feedback target/version does not match displayed text');
  const file=await this.feedbackFile(),lock=resolve(this.options.feedbackRoot,'feedback.lock');try{await mkdir(lock);}catch(e:any){if(e.code==='EEXIST')throw new DemoError(409,'Feedback is being saved; retry later');throw e;}
  try{try{if((await lstat(file)).isSymbolicLink())throw new DemoError(403,'Invalid feedback file');}catch(e:any){if(e.code!=='ENOENT')throw e;}const item={schemaVersion:'1',id:randomUUID(),createdAt:new Date().toISOString(),...body,learningStatus:'saved-only'},f=await open(file,'a');try{await f.writeFile(JSON.stringify(item)+'\n');await f.sync();}finally{await f.close();}return{item};}finally{await rmdir(lock);}
 }
 /** A completed session may register its real score artifacts; no score is synthesized. */
 async registerSessionEvaluation(entry:any,artifacts:DemoArtifact[],root:string){this.sessions=this.sessions.filter(s=>s.entry.id!==entry.id);this.sessions.push({entry,artifacts,root:resolve(root)});await this.load();}
 async registerRefineResult(sessionId:string,result:{runId:string;runDirectory:string;stageArtifacts:Record<string,string>}){
  const a=result.stageArtifacts,root=resolve(result.runDirectory);
  for(const [kind,scorePath,documentPath] of [['current',a.draftExpertReportPath,a.currentDocumentAspectSetPath],['candidate',a.candidateExpertReportPath,a.candidateDocumentAspectSetPath]]){
   if(!scorePath||!documentPath||!a.goldAspectSetPath)continue;
   const id='session-'+digest(sessionId+result.runId+kind).slice(0,24),artifacts:DemoArtifact[]=[];
   for(const [suffix,path]of [['score',scorePath],['gold',a.goldAspectSetPath],['document',documentPath]]){if(!path||!within(root,resolve(path)))throw new DemoError(403,'Session artifact outside run');const content=await readFile(path,'utf8');artifacts.push({id:id+'-'+suffix,title:kind+' '+suffix,path:resolve(path),sha256:digest(content)});}
   const score=JSON.parse(await readFile(scorePath,'utf8'));if(score.schemaVersion!=='2.0')continue;
   await this.registerSessionEvaluation({id,title:'会话评估 · '+kind,sessionId,runId:result.runId,scoreBinding:{scoreArtifactId:id+'-score',goldAspectArtifactId:id+'-gold',documentAspectArtifactId:id+'-document'},cases:[],cards:[],skills:[],artifactIds:artifacts.map(a=>a.id)},artifacts,root);
  }
 }
}
