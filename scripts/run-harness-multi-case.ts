import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {runMultiCaseHarness} from '../src/harness-multi-case.js';
const {values}=parseArgs({options:{config:{type:'string'},execute:{type:'boolean',default:false}}});
if(!values.config)throw Error('Use --config <local JSON>; preparation only unless --execute is explicit.');
const config=JSON.parse(await readFile(values.config,'utf8'));
console.log(JSON.stringify(await runMultiCaseHarness(config,values.execute)));
