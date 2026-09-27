import test from 'node:test';
import assert from 'node:assert/strict';
import {registerExpertObservationTool} from '../src/expert-observation-tool.js';
test('frozen read exposes bound identities and returns complete unchanged records',async()=>{
 let tool:any,reads=0;const original={observations:[{id:'a',delivery:'cached-existing',raw:'one'},{id:'b',delivery:'cached-existing',raw:'two'}],producerRecords:{shared:{model:'m'}}};
 registerExpertObservationTool({registerTool:(t:any)=>tool=t},['a','b'],async()=>{reads++;return original;});
 assert.ok(tool.description.includes('["a","b"]'));assert.ok(tool.description.includes('cannot generate'));
 assert.deepEqual(JSON.parse((await tool.execute('one',{})).content[0].text),original);
 assert.deepEqual(JSON.parse((await tool.execute('two',{})).content[0].text),original);
 assert.equal(reads,2);
 await assert.rejects(tool.execute('bad',{runIds:['invented']}),/empty object/);assert.equal(reads,2);
 assert.equal(tool.parameters.additionalProperties,false);
});
test('ambiguous or empty frozen identities fail closed',()=>{
 for(const ids of [[],['same','same']])assert.throws(()=>registerExpertObservationTool({registerTool(){}},ids,async()=>null),/unique/);
});
