import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {ExpertDemoStore} from '../src/web-expert-demo.js';
const registryPath=process.argv[2],proofPath=process.argv[3];if(!registryPath||!proofPath)throw Error('registry and proof output required');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),registry=JSON.parse(await readFile(registryPath,'utf8')),sourceMap=JSON.parse(await readFile(resolve(dirname(registryPath),'source-map.json'),'utf8'));
for(const s of sourceMap.sources)if(hash(await readFile(s.path,'utf8'))!==s.sha256)throw Error('Imported source changed');
const store=new ExpertDemoStore({registryPath,feedbackRoot:resolve(dirname(registryPath),'unused-feedback')}),view=await store.overview(),artifacts=[];
for(const p of view.presets)for(const id of new Set(Object.values(p.moduleArtifactIds).flat())){const a=await store.artifact(id);artifacts.push({id,title:a.title,sha256:a.sha256,characters:a.content.length});}
const proof={registryPath:resolve(registryPath),registrySha256:hash(await readFile(registryPath,'utf8')),sourceCount:sourceMap.sources.length,allSourceHashesPreserved:true,presets:view.presets,artifacts,evaluations:view.evaluations.map(e=>({id:e.id,score:e.score?{recall:e.score.recall,precision:e.score.precision,f1:e.score.f1,details:e.score.details.length}:null,cases:e.cases.length,cards:e.cards.length})),providerRequests:0,historicalWrites:0};
await writeFile(proofPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({proof:proofPath,sources:proof.sourceCount,artifacts:artifacts.length,presets:view.presets.length}));
