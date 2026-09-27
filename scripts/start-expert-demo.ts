import {parseArgs} from 'node:util';
import {startWebDashboard} from '../src/web-dashboard.js';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {values}=parseArgs({options:{registry:{type:'string'},cwd:{type:'string',default:process.cwd()},port:{type:'string',default:'4318'},'feedback-root':{type:'string'},'summary-module':{type:'string'},'summary-cache':{type:'string'}}});
const port=Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
const expertSummary=values['summary-module']?(await import(pathToFileURL(resolve(values['summary-module'])).href)).default:values['summary-cache']?{cacheRoot:values['summary-cache'],model:'deepseek-v4-flash'}:undefined;
const server=await startWebDashboard({cwd:values.cwd!,host:'127.0.0.1',port,...(values.registry?{expertDemoRegistryPath:values.registry}:{}),...(values['feedback-root']?{expertFeedbackRoot:values['feedback-root']}:{}) ,...(expertSummary?{expertSummary}:{})});
console.log(server.url);for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>void server.close());
