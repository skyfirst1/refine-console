import {Type, type Static} from 'typebox';
import {Check} from 'typebox/value';

export interface FewShotAspect {id:string;title:string;description:string;evidences:Array<{quote:string;location:string}>}
export interface FewShotCase {
  syntheticTaskRequirement:string;mode:'content'|'style';sourceAspect:FewShotAspect;targetAspect:FewShotAspect;
  expectedMatched:boolean;
  evidenceRationale:Array<{side:'source'|'target';evidenceIndex:number;quotedText:string;explanation:string}>;
  whyBoundaryApplies:string;scope:string;
}
const nonempty=()=>Type.String({minLength:1});
const aspect=()=>Type.Object({id:nonempty(),title:nonempty(),description:nonempty(),evidences:Type.Array(Type.Object({quote:nonempty(),location:nonempty()},{additionalProperties:false}),{minItems:1})},{additionalProperties:false});
export const fewShotCasesSchema=Type.Array(Type.Object({
  syntheticTaskRequirement:nonempty(),mode:Type.Union([Type.Literal('content'),Type.Literal('style')]),sourceAspect:aspect(),targetAspect:aspect(),expectedMatched:Type.Boolean(),
  evidenceRationale:Type.Array(Type.Object({side:Type.Union([Type.Literal('source'),Type.Literal('target')]),evidenceIndex:Type.Integer({minimum:0}),quotedText:nonempty(),explanation:nonempty()},{additionalProperties:false}),{minItems:2}),
  whyBoundaryApplies:nonempty(),scope:nonempty(),
},{additionalProperties:false}));

/** Model-facing authoring format: full texts and explanations, without storage IDs or indices. */
export const compactFewShotCasesSchema=Type.Array(Type.Object({
  syntheticTaskRequirement:nonempty(),mode:Type.String({enum:['content','style']}),
  sourceText:nonempty(),targetText:nonempty(),expectedMatched:Type.Boolean(),
  evidenceRationale:Type.Array(Type.Object({side:Type.String({enum:['source','target']}),quotedText:nonempty(),explanation:nonempty()},{additionalProperties:false}),{minItems:2}),
  whyBoundaryApplies:nonempty(),scope:nonempty(),
},{additionalProperties:false}));

/** Mechanical storage adapter only. No generated wording, judgment or semantic repair. */
export function expandCompactFewShotCases(value:unknown):FewShotCase[] {
  if(!Check(compactFewShotCasesSchema,value))throw Error('Invalid compact fewShotCases');
  const result=(value as Static<typeof compactFewShotCasesSchema>).map((item,index)=>{
    const aspect=(side:'source'|'target',text:string):FewShotAspect=>({id:`case-${index+1}-${side}`,title:side,description:`Full ${side} text`,evidences:[{quote:text,location:'full text'}]});
    const {sourceText,targetText,...content}=item;
    return {...content,mode:item.mode as 'content'|'style',sourceAspect:aspect('source',sourceText),targetAspect:aspect('target',targetText),evidenceRationale:item.evidenceRationale.map(reference=>({...reference,side:reference.side as 'source'|'target',evidenceIndex:0}))};
  });
  validateFewShotCases(result);
  return result;
}

/** Structural validity and exact same-side references only; no semantic quality verdict. */
export function validateFewShotCases(value:unknown):asserts value is FewShotCase[] {
  if(!Check(fewShotCasesSchema,value))throw Error('Invalid structured fewShotCases');
  const nonblank=(x:unknown):boolean=>typeof x==='string'?!!x.trim():Array.isArray(x)?x.every(nonblank):x&&typeof x==='object'?Object.values(x).every(nonblank):true;
  if(!nonblank(value))throw Error('Structured few-shot strings must be nonempty');
  for(const item of value as FewShotCase[]){
    if(!['source','target'].every(side=>item.evidenceRationale.some(r=>r.side===side)))throw Error('Each synthetic side needs an exact evidence reference');
    for(const reference of item.evidenceRationale){const evidence=(reference.side==='source'?item.sourceAspect:item.targetAspect).evidences[reference.evidenceIndex];if(!evidence||!evidence.quote.includes(reference.quotedText))throw Error('Synthetic evidence reference does not map to its own side quote');}
  }
}

/** JSON serialization preserves model text and labels; it does not rewrite their meaning. */
export function renderFewShotCases(cases:FewShotCase[]|undefined):string {
  if(cases===undefined)return'';validateFewShotCases(cases);
  return cases.length?'\n\n合成教学案例（各例任务要求仅在该例内部生效）：\n'+JSON.stringify(cases,null,2):'';
}
