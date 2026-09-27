import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ExpertDemoStore} from '../src/web-expert-demo.js';
import {startWebDashboard} from '../src/web-dashboard.js';
import {reduceExpertScore} from '../src/refine-expert-pipeline.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'expert-demo-')),artifacts:any[]=[];
 const add=async(id:string,data:any)=>{const content=JSON.stringify(data),path=join(root,id+'.json');await writeFile(path,content);artifacts.push({id,title:id,path,sha256:hash(content)});return id;};
 const aspect={id:'a',title:'Local',description:'A fixture',evidences:[{quote:'line',location:'p1'}]},gold={aspects:[aspect]},document={aspects:[aspect]},m=(direction:'recall'|'precision')=>({direction,sourceAspectId:'a',targetAspectId:'a',matched:true,rationale:'fixture'}),recall=[m('recall')],precision=[m('precision')],alignments=[{sourceAspectId:'a',targetAspectId:'a',contentMatched:true,styleMatched:false,contentRationale:'x',styleRationale:'y'},{sourceAspectId:'a',targetAspectId:'a',contentMatched:false,styleMatched:true,contentRationale:'x',styleRationale:'y'}];
 const score=reduceExpertScore({descriptionSha256:'d',goldSha256:'g',documentSha256:'t',gold:gold as any,document:document as any,recallMatches:recall,precisionMatches:precision,alignments});
 const scoreBinding={scoreArtifactId:await add('score',score),goldAspectArtifactId:await add('gold',gold),documentAspectArtifactId:await add('document',document),recallMatchesArtifactId:await add('recall',recall),precisionMatchesArtifactId:await add('precision',precision),alignmentsArtifactId:await add('alignments',alignments)};
 const skill={id:'skill',version:hash('Text <b>fixture</b>'),text:'Text <b>fixture</b>',kind:'task-evaluation',cardId:'card',cardVersion:'v1'},registry={schemaVersion:'1',allowedRoots:[root],artifacts,evaluations:[{id:'original',title:'Original',scoreBinding,cases:[],cards:[{id:'card',version:'v1'}],skills:[skill]},{id:'candidate',title:'Unscored',cases:[{result:false}],cards:[],skills:[]}]},registryPath=join(root,'registry.json');await writeFile(registryPath,JSON.stringify(registry));return{root,registry,registryPath,skill};
}
test('real schema-2 score details, null candidate, immutable feedback and path protection',async()=>{
 const f=await fixture(),store=new ExpertDemoStore({registryPath:f.registryPath,feedbackRoot:join(f.root,'feedback')});const view=await store.overview();assert.equal(view.evaluations[0].score.f1,.5);assert.equal(view.evaluations[0].score.details.length,2);assert.equal(view.evaluations[0].score.details[0].contribution,.5);assert.equal(view.evaluations[1].score,null);
 const body={skillId:f.skill.id,skillVersion:f.skill.version,cardId:'card',cardVersion:'v1',thumb:'up',text:'Useful',paragraph:'fixture'};
 await store.saveFeedback(body);assert.equal((await new ExpertDemoStore({registryPath:f.registryPath,feedbackRoot:join(f.root,'feedback')}).feedback()).items.length,1);
 await assert.rejects(store.saveFeedback({...body,skillVersion:'old'}));await assert.rejects(store.saveFeedback({...body,text:' '}));await assert.rejects(store.saveFeedback({...body,paragraph:'not present'}));await assert.rejects(store.artifact('../registry.json'));
 await mkdir(join(f.root,'feedback','feedback.lock'));await assert.rejects(store.saveFeedback(body),/being saved/);
 const outside=await mkdtemp(join(tmpdir(),'outside-'));await writeFile(join(outside,'public.txt'),'outside');f.registry.artifacts.push({id:'escape',title:'escape',path:join(outside,'public.txt'),sha256:hash('outside')});await writeFile(f.registryPath,JSON.stringify(f.registry));await assert.rejects(store.artifact('escape'),/outside/);
 await symlink(outside,join(f.root,'link'),'junction');f.registry.artifacts.push({id:'link',title:'link',path:join(f.root,'link','public.txt'),sha256:hash('outside')});await writeFile(f.registryPath,JSON.stringify(f.registry));await assert.rejects(store.artifact('link'),/Symlink/);
 await writeFile(join(f.root,'score.json'),'{}');await assert.rejects(store.overview(),/changed/);
});
test('loopback API returns registered data and persists version-bound feedback',async()=>{
 const f=await fixture(),server=await startWebDashboard({cwd:f.root,port:0,expertDemoRegistryPath:f.registryPath,expertFeedbackRoot:join(f.root,'feedback')});
 try{const response=await fetch(server.url+'/api/expert-demo');assert.equal(response.status,200);assert.equal((await response.json() as any).evaluations[1].score,null);
 const refineModule=await fetch(server.url+'/refine-flow.js');assert.equal(refineModule.status,200);assert.match(refineModule.headers.get('content-type')||'',/javascript/);assert.match(await refineModule.text(),/REFINE_NODES/);assert.match(refineModule.headers.get('content-security-policy')||'',/script-src 'self'/);
 const body={skillId:f.skill.id,skillVersion:f.skill.version,cardId:'card',cardVersion:'v1',thumb:'down',text:'Needs evidence'};
 assert.equal((await fetch(server.url+'/api/expert-demo/skill-feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,201);
 assert.equal((await fetch(server.url+'/api/expert-demo/skill-feedback',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.test'},body:JSON.stringify(body)})).status,403);
 assert.equal((await (await fetch(server.url+'/api/expert-demo/skill-feedback')).json() as any).items.length,1);
 assert.equal((await fetch(server.url+'/api/expert-demo/artifacts/unknown')).status,404);
 }finally{await server.close();}
});
test('history preset connects registered modules without inventing a new run or score',async()=>{
 const f=await fixture(),r:any=f.registry;
 r.presets=[{id:'history',title:'A history group',sourceLabel:'two historical batches',evaluationId:'original',evaluationIds:['original','candidate'],moduleArtifactIds:{refine:['score'],harness:['recall'],cards:['alignments']},notice:'Not a new end-to-end run; no rewrite/acceptance stage is available.'}];r.defaultPresetId='history';await writeFile(f.registryPath,JSON.stringify(r));
 const store=new ExpertDemoStore({registryPath:f.registryPath,feedbackRoot:join(f.root,'feedback')}),view=await store.overview();assert.equal(view.defaultPresetId,'history');assert.equal(view.presets.length,1);assert.equal(view.evaluations[1].score,null);assert.equal((await store.artifact(view.presets[0]!.moduleArtifactIds.refine[0]!)).id,'score');
 assert.equal(view.artifactTitles.score,'score');r.presets[0].moduleArtifactIds.harness=['../../unregistered'];await writeFile(f.registryPath,JSON.stringify(r));await assert.rejects(store.overview(),/preset binding/);
});
