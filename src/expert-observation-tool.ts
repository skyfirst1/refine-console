import {Type} from 'typebox';

/** Read an already-bound observation set; this tool has no generation capability. */
export function registerExpertObservationTool(runtime:any, ids:readonly string[], read:()=>Promise<unknown>) {
 if (!ids.length || new Set(ids).size!==ids.length) throw Error('Observation identities must be nonempty and unique');
 runtime.registerTool({
  name:'expert_replay', label:'Read frozen Expert observations',
  description:`Read all available frozen historical Expert observations and their producer provenance. Available record identities: ${JSON.stringify(ids)}. No arguments or new run IDs are needed. This tool cannot generate new outputs. Returned observations are cached-existing, not fresh runs.`,
  parameters:Type.Object({}, {additionalProperties:false}),
  async execute(_id:string,args:Record<string,unknown>) {
   if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length) throw Error('Frozen observation read accepts an empty object only');
   return {content:[{type:'text',text:JSON.stringify(await read())}],details:{}};
  }
 });
}
