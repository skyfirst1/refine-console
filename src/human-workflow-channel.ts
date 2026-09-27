import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeControlJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, path);
}
export function readControlJson(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
export function userBoundaries(directory: string): Array<{ id: string; text: string; source: 'user' }> {
  return existsSync(join(directory,'boundaries.json')) ? readControlJson(join(directory,'boundaries.json')) : [];
}
export function pendingHumanQuestions(directory: string) {
  const root = join(directory, 'questions');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => name.endsWith('.json')).map(name => readControlJson(join(root,name)))
    .filter(item => !existsSync(join(directory,'answers',item.id+'.json')));
}
export function humanWaitPending(directory: string) {
  return !existsSync(join(directory,'stop.json')) && pendingHumanQuestions(directory).length > 0;
}
export async function waitForHumanAnswers(directory:string,pollMs=100) {
  while(humanWaitPending(directory))await new Promise(resolve=>setTimeout(resolve,pollMs));
  if(existsSync(join(directory,'stop.json')))throw Error('USER_STOPPED_WORKFLOW');
}
export async function askHuman(directory: string, question: string, context: {caseId?: string} = {}, pollMs = 500) {
  if (!question.trim() || question.length > 12000) throw Error('用户问题不能为空或超过 12000 字符');
  for (const name of ['questions','answers']) mkdirSync(join(directory,name),{recursive:true});
  const id = randomUUID();
  writeControlJson(join(directory,'questions',id+'.json'),{id,question,...context,source:'review-harness',createdAt:new Date().toISOString()});
  for (;;) {
    if (existsSync(join(directory,'stop.json'))) throw Error('USER_STOPPED_WORKFLOW');
    const answerPath = join(directory,'answers',id+'.json');
    if (existsSync(answerPath)) return {questionId:id, ...readControlJson(answerPath), boundaries:userBoundaries(directory), note:'用户回答是任务边界或补充说明，不自动成为原文 Evidence。'};
    await new Promise(resolve => setTimeout(resolve,pollMs));
  }
}

/** Receipt-only runtime adapter: it never stores message content or private reasoning. */
export function registerHumanRuntime(runtime: any, directory: string) {
  mkdirSync(join(directory,'usage'),{recursive:true});
  let requestId: string | undefined;
  runtime.on('before_provider_request', async (_event: any, context: any) => {
    try { await waitForHumanAnswers(directory); } catch(error) {context.abort();throw error;}
    requestId = randomUUID();
    writeControlJson(join(directory,'usage',requestId+'.json'),{id:requestId,status:'pending',at:new Date().toISOString()});
  });
  runtime.on('message_end', (event: any) => {
    if (!requestId || event.message?.role !== 'assistant') return;
    const usage = event.message.usage, cost = usage?.cost?.total;
    writeControlJson(join(directory,'usage',requestId+'.json'),{id:requestId,status:typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? 'settled' : 'unknown',costUsd:typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,totalTokens:usage?.totalTokens ?? null,at:new Date().toISOString()});
    requestId = undefined;
  });
}

export function workflowCost(directories: string[]) {
  const rows = directories.flatMap(directory => {
    const root = join(directory,'usage');
    return existsSync(root) ? readdirSync(root).filter(n=>n.endsWith('.json')).map(n=>readControlJson(join(root,n))) : [];
  });
  return { settledUsd:rows.reduce((sum,row)=>sum+(row.status==='settled'?row.costUsd:0),0), requests:rows.length, unsettledRequests:rows.filter(r=>r.status!=='settled').length, basis:'provider-reported' as const };
}
