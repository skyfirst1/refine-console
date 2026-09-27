import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export interface FrozenGoldAspectSet { path: string; sha256: string; sourceRunId: string }
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Import an existing real extraction without pretending a model call occurred in this run. */
export async function importFrozenGoldAspects(ref:FrozenGoldAspectSet,goldPath:string,descriptionPath:string,outputPath:string){
 if(!ref.sourceRunId.trim())throw Error('Frozen Gold AspectSet requires actual producer run identity');
 const bytes=await readFile(ref.path);if(digest(bytes)!==ref.sha256)throw Error('Frozen Gold AspectSet artifact digest changed');
 const artifact=JSON.parse(bytes.toString('utf8'));
 if(artifact.sourceSha256!==digest(await readFile(goldPath))||artifact.descriptionSha256!==digest(await readFile(descriptionPath)))throw Error('Frozen Gold AspectSet does not match Gold/Description');
 if(!Array.isArray(artifact.aspects)||!artifact.aspects.length)throw Error('Frozen Gold AspectSet contains no aspects');
 try{if(digest(await readFile(outputPath))!==ref.sha256)throw Error('Existing local Gold AspectSet changed');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await writeFile(outputPath,bytes,{flag:'wx'});}
 return {mode:'imported-frozen-gold-aspects' as const,sourceRunId:ref.sourceRunId,sourcePath:ref.path,sha256:ref.sha256,providerCalls:0};
}
