import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { REFINE_NODES } from '../web/refine-flow.js';

const { values } = parseArgs({ options: { registry: { type: 'string' }, history: { type: 'string' } } });
if (!values.registry || !values.history) throw Error('Required --registry and --history; imports public artifacts only.');
const registryPath = resolve(values.registry), root = dirname(registryPath), history = resolve(values.history);
const registryText = await readFile(registryPath, 'utf8'), registry = JSON.parse(registryText);
const resultText = await readFile(resolve(history, 'run-result.json'), 'utf8'), result = JSON.parse(resultText);
const digest = text => createHash('sha256').update(text).digest('hex');
const registered = registry.artifacts.find(a => a.id === 'independent-refine-result');
if (!registered || registered.sha256 !== digest(resultText)) throw Error('History differs from registered Refine run.');
const preset = registry.presets.find(p => p.moduleArtifactIds.refine.includes(registered.id));
if (!preset || !registry.allowedRoots.some(p => resolve(p) === root)) throw Error('Registry root or Refine preset missing.');
const fields = ['descriptionPath','draftPath','expertCurrentPath','reviewPath','candidateSkillPath','candidateDraftPath','expertCandidatePath','judgePath','promotionDecisionPath'];
const prepared = await Promise.all(REFINE_NODES.map(async (node, index) => {
  const input = resolve(result.stageArtifacts[fields[index]]), rel = relative(resolve(result.runDirectory), input);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw Error('Stage artifact outside recorded run.');
  const id = 'independent-refine-'+node.artifact, content = await readFile(input, 'utf8');
  return { id, title: 'Refine · '+node.title+' · 历史阶段原文', path: resolve(root,'artifacts',id+'.txt'), sha256: digest(content), input, content };
}));
await copyFile(registryPath, registryPath+'.before-refine-stages-'+Date.now()+'.json');
for (const { input, content, ...artifact } of prepared) {
  const previous = registry.artifacts.find(a => a.id === artifact.id);
  if (previous && (previous.sha256 !== artifact.sha256 || resolve(previous.path) !== artifact.path)) throw Error('Conflicting registered stage: '+artifact.id);
  try { await writeFile(artifact.path, content, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || digest(await readFile(artifact.path, 'utf8')) !== artifact.sha256) throw error; }
  if (!previous) registry.artifacts.push(artifact);
  if (!preset.moduleArtifactIds.refine.includes(artifact.id)) preset.moduleArtifactIds.refine.push(artifact.id);
}
await writeFile(registryPath, JSON.stringify(registry,null,2)+'\n');
console.log(JSON.stringify({ imported: prepared.map(({id, input, sha256}) => ({id, source:input, sha256})), modelCalls:0 }));
