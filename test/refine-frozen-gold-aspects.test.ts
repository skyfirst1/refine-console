import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importFrozenGoldAspects} from '../src/refine-frozen-gold-aspects.js';
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
test('cross-run Gold import retains exact extracted bytes and rejects changed inputs without regeneration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'frozen-gold-')),gold=join(dir,'gold.md'),description=join(dir,'description.md'),source=join(dir,'source.json'),out=join(dir,'import.json');
 await writeFile(gold,'gold');await writeFile(description,'task');
 const bytes=JSON.stringify({sourceSha256:hash('gold'),descriptionSha256:hash('task'),aspects:[{id:'a'}]});await writeFile(source,bytes);
 const ref={path:source,sha256:hash(bytes),sourceRunId:'real-r1'};
 const result=await importFrozenGoldAspects(ref,gold,description,out);assert.equal(result.providerCalls,0);assert.equal(await readFile(out,'utf8'),bytes);
 await importFrozenGoldAspects(ref,gold,description,out);
 await writeFile(description,'different');await assert.rejects(importFrozenGoldAspects(ref,gold,description,out),/Gold\/Description/);
 await writeFile(description,'task');await writeFile(out,'changed');await assert.rejects(importFrozenGoldAspects(ref,gold,description,out),/local Gold/);
 await assert.rejects(importFrozenGoldAspects({...ref,sha256:'bad'},gold,description,out),/artifact digest/);
});
