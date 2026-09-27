import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {ExpertDemoStore} from '../src/web-expert-demo.js';
const {values}=parseArgs({options:{batch:{type:'string'},replays:{type:'string'},evaluation:{type:'string'},out:{type:'string'},'refine-history':{type:'string'}}});
if(!values.batch||!values.replays||!values.evaluation||!values.out)throw Error('Required --batch --replays --evaluation --out; imports existing public results only, no execution.');
const batch=resolve(values.batch),replays=resolve(values.replays),out=resolve(values.out),artifacts:any[]=[],sources:any[]=[];
mkdirSync(out);mkdirSync(out+'/artifacts');const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),read=(p:string)=>{const text=readFileSync(p,'utf8');sources.push({path:p,sha256:hash(text)});return JSON.parse(text);};
const add=(id:string,title:string,content:string,source?:string)=>{const path=out+'/artifacts/'+id+'.txt';writeFileSync(path,content,{flag:'wx'});artifacts.push({id,title,path,sha256:hash(content)});if(source)sources.push({id,path:source,sha256:hash(readFileSync(source,'utf8'))});return id;};
const manifest=read(batch+'/prepared/manifest.json'),cases=read(batch+'/prepared/cases.json'),materials=read(batch+'/prepared/boundary-materials.json');
for(const f of manifest.files){const sha256=hash(readFileSync(f.path,'utf8'));if(sha256!==f.sha256)throw Error('Frozen batch source changed');sources.push({path:f.path,sha256});}
const cards:any[]=[],skills:any[]=[];
for(const role of ['aligner','matcher']){
 const dir=batch+'/roles/'+role,state=read(dir+'/copies/state.json'),inc=read(dir+'/card-increments.json'),binding=read(dir+'/parent-binding.json'),receipt=read(dir+'/card-append-receipt.json');
 if(state.versions.v1.digest!==receipt.copyDigest||state.versions.v0.digest!==binding.parentCopyDigest)throw Error('Candidate identity mismatch');
 for(const [version,status]of [['v0','original'],['v1','candidate']]){const c=state.versions[version!],{digest,...body}=c;if(hash(JSON.stringify(body))!==digest||c.roleId!==binding.roleId)throw Error('Invalid immutable Card');const id=role+'-'+version;cards.push({id,roleId:c.roleId,version,digest,status,prompt:c.systemPrompt,skill:c.skill??'',badCase:version==='v1'?inc.badCaseAppend:'',promptAppend:version==='v1'?inc.promptAppend:'',parentDigest:version==='v1'?binding.parentCopyDigest:null,businessCardDigest:binding.businessCardDigest,artifactIds:[]});if(c.skill?.trim())skills.push({id:id+'-skill',version:hash(c.skill),text:c.skill,kind:'card-skill',cardId:id,cardVersion:version});for(const m of materials.filter((m:any)=>m.scope==='task-skill'))skills.push({id:id+'-task-skill',version:hash(m.text),text:m.text,kind:'task-evaluation',cardId:id,cardVersion:version});}
 add(role+'-increments',role+' 原始教学增量',JSON.stringify(inc,null,2),dir+'/card-increments.json');cards.find(c=>c.id===role+'-v1').artifactIds.push(role+'-increments');
 add(role+'-append-receipt',role+' 候选继承回执',readFileSync(dir+'/card-append-receipt.json','utf8'),dir+'/card-append-receipt.json');cards.find(c=>c.id===role+'-v1').artifactIds.push(role+'-append-receipt');
 sources.push({id:role+'-state',path:dir+'/copies/state.json',sha256:hash(readFileSync(dir+'/copies/state.json','utf8'))});
}
const visibleCases=cases.map((c:any)=>{
 const binding=manifest.bindings.find((b:any)=>b.nodeId===c.nodeId);if(!binding)throw Error('Missing case binding');
 const samples=c.samples.map((s:any,i:number)=>({...s,id:s.sampleId,kind:i===0?'original':'baseline',artifactId:add(c.caseId+'-sample-'+i,'原观察 '+s.sampleId,JSON.stringify(s,null,2))}));
 for(const replay of [1,2]){const dir=replays+'/runs/'+c.nodeId+'-r'+replay,b=read(dir+'/binding.json'),p=read(dir+'/parsed-result.json');if(b.nodeId!==c.nodeId||b.candidate.roleId!==c.roleId||b.candidate.candidateDigest!==cards.find(k=>k.roleId===c.roleId&&k.status==='candidate').digest)throw Error('Replay/Card mismatch');const {rationale,evidence_citation,...result}=p;samples.push({id:b.runId,kind:'candidate',result:c.roleId==='refine.evidence-aligner'?p.matched:result,rationale,artifactId:add(c.caseId+'-candidate-'+replay,'候选输出 '+b.runId,readFileSync(dir+'/public-output.md','utf8'),dir+'/public-output.md')});}
 const evidenceId=add(c.caseId+'-input','局部输入 '+c.caseId,JSON.stringify({scope:c.scope,evidence:c.catalog},null,2));return{id:c.caseId,nodeId:c.nodeId,roleId:c.roleId,axis:c.axis,direction:c.direction,samples,artifactIds:[evidenceId]};
});
const evaluation=read(values.evaluation),scoreId=add('original-score','原完整评估',readFileSync(values.evaluation,'utf8'),values.evaluation),goldId=add('gold-aspects','原评估 Gold Aspects',JSON.stringify(evaluation.gold)),docId=add('document-aspects','原评估 Document Aspects',JSON.stringify(evaluation.document));
const recallId=add('recall-matches','原 Recall 匹配',JSON.stringify(evaluation.matches.filter((m:any)=>m.direction==='recall'))),precisionId=add('precision-matches','原 Precision 匹配',JSON.stringify(evaluation.matches.filter((m:any)=>m.direction==='precision'))),alignmentId=add('evidence-alignments','原 Content/Style 判断',JSON.stringify(evaluation.alignments));
const traceId=add('candidate-replay-trace','候选回放完整公开记录',readFileSync(replays+'/trace.md','utf8'),replays+'/trace.md'),reviewTrace=add('review-trace','审查与教材生成记录',readFileSync(batch+'/trace.md','utf8'),batch+'/trace.md');
const reviewId=add('saved-review','真实 Harness 审查正文',readFileSync(batch+'/live-v2/review.json','utf8'),batch+'/live-v2/review.json'),reviewOutcomeId=add('review-outcome','真实审查会话与费用终态',readFileSync(batch+'/outcome-v2.json','utf8'),batch+'/outcome-v2.json'),replayOutcomeId=add('replay-outcome','候选回放终态',readFileSync(replays+'/outcome.json','utf8'),replays+'/outcome.json');
const boundaryIds:string[]=[];
for(const dir of readdirSync(batch+'/live-v2',{withFileTypes:true}).filter(d=>d.isDirectory()&&/^boundary-[-a-zA-Z0-9_]+$/.test(d.name)).sort((a,b)=>a.name.localeCompare(b.name))){for(const type of ['question','answer']){const path=batch+'/live-v2/'+dir.name+'/'+type+'.json';boundaryIds.push(add(dir.name+'-'+type,'案例 '+dir.name.slice('boundary-'.length)+' · '+(type==='question'?'边界提问与原文选摘':'边界回复'),readFileSync(path,'utf8'),path));}}
const cardIds=cards.map(c=>{const id='card-'+c.id;add(id,(c.roleId==='refine.evidence-aligner'?'对齐专家':'匹配专家')+' · '+(c.status==='original'?'原始':'候选')+' Card',JSON.stringify(c,null,2));c.artifactIds.push(id);return id;});
const reviewText=read(batch+'/live-v2/review.json').review;
for(const c of visibleCases){
 const marker='## '+c.id,header=typeof reviewText==='string'?reviewText.indexOf(marker+'（'):-1,next=header>=0?reviewText.indexOf('\n## ',header+marker.length):-1;
 const qid='boundary-'+c.id+'-question',aid='boundary-'+c.id+'-answer',bound=artifacts.some(a=>a.id===qid)&&artifacts.some(a=>a.id===aid);
 if(bound){const q=read(batch+'/live-v2/boundary-'+c.id+'/question.json');if(q.caseId!==c.id||q.direction!==c.direction||q.axis!==c.axis)throw Error('Case/boundary binding mismatch');}
 (c as any).workflow={review:header>=0?{binding:'case',artifactId:reviewId,range:{start:header,end:next<0?reviewText.length:next}}:{binding:'batch',artifactId:reviewId},boundary:bound?{binding:'case',questionArtifactId:qid,answerArtifactId:aid}:{binding:'unavailable'},cards:{binding:'role',cardIds:cards.filter(k=>k.roleId===c.roleId).map(k=>k.id)},replay:{binding:'case',artifactIds:c.samples.filter((s:any)=>s.kind==='candidate').map((s:any)=>s.artifactId)}};
}
const preset={id:'historical-expert-review',title:'历史评估 → 审查 → 候选回放',sourceLabel:evaluation.id+' / '+batch.split(/[\\/]/).at(-1)+' / '+replays.split(/[\\/]/).at(-1),evaluationId:'source-'+evaluation.id,evaluationIds:['source-'+evaluation.id,'candidate-local-diagnostic'],moduleArtifactIds:{refine:[scoreId,goldId,docId,recallId,precisionId,alignmentId],harness:[reviewId,reviewTrace,reviewOutcomeId,...boundaryIds],cards:[...cardIds,'aligner-increments','aligner-append-receipt','matcher-increments','matcher-append-receipt',traceId,replayOutcomeId]},notice:'这是关联的多个历史批次，不是一次新执行的端到端流程。Refine 区只有原完整评价结果；未导入改稿、接受或完整 Refine 循环，不能据此推断它们已完成。Harness 使用原评价抽取的六例及既有回放缓存；后续两个角色的候选仅做六例局部回放，未整体评分、未通过语义验收，未替换默认专家。'};
if(values['refine-history']){
 const history=resolve(values['refine-history']);
 for(const [name,id,label]of [['REPORT.md','independent-refine-report','报告'],['run-result.json','independent-refine-result','运行结果'],['run-summary.json','independent-refine-summary','运行摘要']]){
  const source=resolve(history,name!);if(name==='run-summary.json'&&!existsSync(source))continue;
  preset.moduleArtifactIds.refine.push(add(id!,'独立历史 Refine · '+label+'（不属于六例批次）',readFileSync(source,'utf8'),source));
 }
 preset.notice=preset.notice.replace('Refine 区只有原完整评价结果；未导入改稿、接受或完整 Refine 循环，不能据此推断它们已完成。','六例关联链只有原完整评价结果，未导入对应改稿或接受环节；另列的独立历史 Refine 报告与运行结果不属于六例批次，不补接为同一流程，也不作为候选评分。');
}
const registry={schemaVersion:'1',allowedRoots:[out],artifacts,evaluations:[{id:'source-'+evaluation.id,title:'原完整评估 · '+evaluation.id,scoreBinding:{scoreArtifactId:scoreId,goldAspectArtifactId:goldId,documentAspectArtifactId:docId,recallMatchesArtifactId:recallId,precisionMatchesArtifactId:precisionId,alignmentsArtifactId:alignmentId},cases:[],cards:cards.filter(c=>c.status==='original'),skills:skills.filter(s=>s.cardVersion==='v0'),artifactIds:[scoreId]},{id:'candidate-local-diagnostic',title:'候选局部诊断（未评分）',cases:visibleCases,cards,skills,artifactIds:[traceId,reviewTrace]}]};
const path=out+'/registry.json';writeFileSync(path,JSON.stringify({...registry,presets:[preset],defaultPresetId:preset.id},null,2)+'\n',{flag:'wx'});writeFileSync(out+'/source-map.json',JSON.stringify({sources:[...new Map(sources.map(s=>[resolve(s.path),s])).values()],batchManifest:manifest.bindings.map((b:any)=>({caseId:b.caseId,nodeId:b.nodeId,inputRefs:b.inputRefs,cached:b.cached,outputRefs:b.outputRefs}))},null,2)+'\n',{flag:'wx'});
const view=await new ExpertDemoStore({registryPath:path,feedbackRoot:out+'/feedback'}).overview();console.log(JSON.stringify({registry:path,evaluations:view.evaluations.map(e=>({id:e.id,score:e.score?{recall:e.score.recall,precision:e.score.precision,f1:e.score.f1,denominators:e.score.denominators}:null,cases:e.cases.length,cards:e.cards.length}))}));
