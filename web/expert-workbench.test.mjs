import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, resultLabel, filterCases, renderScore, renderScoreDetails, renderCase, renderCard, teachingSections, renderTeaching, feedbackBinding, evaluationForModule, renderModuleSources, reviewPreviewText, renderCaseMatrix, renderReasonSamples, renderSummaryStatus, excerptWithFullText, caseLabel, TASK_FLOW_NODES, renderTaskFlow, loadExpertWorkbench } from './expert-workbench.js';

const card = { id: 'card-aligner', roleId: 'refine.evidence-aligner', version: 'v1', digest: 'candidate', status: 'candidate', prompt: '父规则\n新规则', promptAppend: '新规则：<script>不执行</script>', skill: '', badCase: '输入：真实原句\n输出：{"matched":false,"rationale":"保留原文"}' };
const skill = { id: 'task-skill', version: 'skill-sha', text: '完整规范\n第二段', kind: 'task-evaluation', cardId: card.id, cardVersion: card.version };
const item = { id: 'C1', roleId: card.roleId, axis: 'content', direction: 'recall', samples: [{ id: 'original', kind: 'original', result: false, rationale: '<img src=x onerror=alert(1)>原理由' }, { id: 'new', kind: 'candidate', result: true, rationale: '新理由原值', artifactId: 'output-id' }], artifactIds: [] };

test('compact workflow excerpt folds without removing or changing full source text', () => {
  const text = '<原文>' + '完整记录'.repeat(100);
  const html = excerptWithFullText(text, 30, '展开完整规则');
  assert.ok(html.includes(escapeText(text.slice(0, 30))));
  assert.ok(html.includes(escapeText(text)));
  assert.match(html, /<details><summary>展开完整规则/);
  assert.doesNotMatch(html, /<details open/);
  assert.doesNotMatch(excerptWithFullText('短文', 30), /<details/);
});

test('saved review preview unwraps only a string review while preserving registered JSON source', () => {
  const review = '审查正文\n<script>不执行</script>', raw = JSON.stringify({ review, status: 'saved' });
  const artifact = { id: 'saved-review', content: raw };
  assert.equal(reviewPreviewText(artifact), review);
  assert.equal(artifact.content, raw);
  assert.ok(escapeText(reviewPreviewText(artifact)).includes('&lt;script&gt;'));
  assert.equal(reviewPreviewText({ id: 'other', content: raw }), raw);
  for (const content of ['纯文本', '{bad json', '{"review":null}', '{"review":42}']) assert.equal(reviewPreviewText({ id: 'saved-review', content }), content);
});

test('model text and source identity are escaped, not executable HTML', () => {
  assert.equal(escapeText(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  const html = renderCase(item);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;原理由'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('新理由原值'));
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('data-artifact="output-id"'));
});

test('unscored candidates never derive accuracy or F1 from matched labels', () => {
  const html = renderScore({ title: '候选六例', score: null, cases: [item] });
  assert.match(html, /未评分/); assert.doesNotMatch(html, /100%|0\.0000|1\.0000/);
  assert.match(resultLabel({ matched: false, targetAspectId: null }), /目标 无/);
  assert.equal(resultLabel(null), '未提供判断');
});

test('schema 2 score preserves actual metrics, denominators and registered source', () => {
  const html = renderScore({ title: '原评价', score: { schemaVersion: '2.0', recall: .5, precision: .75, f1: .6, overallScore: 60, denominators: { goldAspects: 12, documentAspects: 10 }, sourceArtifactId: 'score-record' } });
  for (const text of ['0.5000', '0.7500', '0.6000', 'Gold 要点 12', '文档要点 10', 'score-record', '不是新候选']) assert.ok(html.includes(text));
});

test('all four filters compose without mutating cases', () => {
  const other = { ...item, id: 'C2', roleId: 'refine.aspect-matcher', direction: 'precision', axis: null };
  assert.deepEqual(filterCases([item, other], { roleId: other.roleId, direction: 'precision', axis: 'not-applicable', caseId: 'C2' }), [other]);
  assert.deepEqual(filterCases([item], { axis: 'style' }), []);
  assert.equal(item.samples.length, 2);
});

test('Card keeps increments and badcase raw, separates empty own Skill from task norm', () => {
  const html = renderCard(card, [card], [], [skill]);
  for (const text of ['语义未验收', '不推广', '自身未提供 Skill', '任务评价规范（单独来源）', 'skill-sha', '仅保存反馈', '原文', '&lt;script&gt;不执行&lt;/script&gt;']) assert.ok(html.includes(text), text);
  assert.ok(html.includes(escapeText(card.badCase)));
  assert.ok(!html.includes('<script>'));
});

test('Skill feedback binds actual text version and Card identity, never message feedback', () => {
  assert.deepEqual(feedbackBinding(card, { thumb: 'down', text: ' 需要澄清 ', paragraph: ' 第二段 ' }, skill), { skillId: skill.id, skillVersion: skill.version, cardId: card.id, cardVersion: card.version, thumb: 'down', text: '需要澄清', paragraph: '第二段' });
  assert.throws(() => feedbackBinding(card, { thumb: 'up', text: '理由' }, { ...skill, cardVersion: 'v0' }), /绑定/);
  assert.throws(() => feedbackBinding(card, { thumb: 'up', text: '' }, skill), /理由/);
  assert.throws(() => feedbackBinding(card, { thumb: 'other', text: '理由' }, skill), /方向/);
  assert.throws(() => feedbackBinding(card, { thumb: 'up', text: '字'.repeat(4001) }, skill), /4000/);
  assert.throws(() => feedbackBinding(card, { thumb: 'up', text: '理由', paragraph: '字'.repeat(1001) }, skill), /1000/);
  assert.throws(() => feedbackBinding(card, { thumb: 'up', text: '理由', paragraph: '不在正文' }, skill), /逐字/);
});

test('teaching display splits only original headings and paired output markers without changing values', () => {
  const raw = '[示范 1｜axis=content, direction=recall]\n输入：<真实句>\n<<<EVIDENCE_ALIGNMENT_START>>>\n{"matched":false}\n<<<EVIDENCE_ALIGNMENT_END>>>\n不应模仿：原对照\n\n[示范 2｜局部]\n输入：另一句';
  const sections = teachingSections(raw);
  assert.equal(sections.length, 2);
  assert.equal(sections.map(s => s.title + s.input + s.output + s.after).join(''), raw);
  const html = renderTeaching(raw);
  assert.match(html, /任务输入与原有说明/); assert.match(html, /示范输出（原文）/);
  assert.ok(html.includes(escapeText(raw))); assert.ok(!html.includes('<真实句>'));
  assert.match(renderTeaching('无标题原文'), /未发现可分块/);
  assert.doesNotMatch(renderCard({ ...card, status: 'original' }, [card], [], []), /候选整体表现/);
});

test('score breakdown shows supplied rows without filling missing values', () => {
  const html = renderScoreDetails([{ direction: 'recall', sourceAspectId: 's1', targetAspectId: null, matched: false, contentMatched: null, styleMatched: true, contribution: 0.5 }]);
  for (const value of ['s1', '未提供', '0.5', '否', '是']) assert.ok(html.includes(value));
  assert.match(renderScoreDetails(undefined), /未提供计分明细/);
});

test('one registered preset routes original scores and candidate modules without mixing batches', () => {
  const original = { id: 'original-eval', title: '原完整评价', score: { f1: .6 }, cards: [], cases: [] };
  const candidate = { id: 'candidate-eval', title: '候选局部回放', score: null, cards: [card], cases: [item] };
  const preset = { id: 'demo', title: '真实历史', evaluationId: original.id, evaluationIds: [original.id, candidate.id], sourceLabel: '不同历史批次', moduleArtifactIds: { harness: ['review-id'] }, notice: '不代表一次新的端到端运行' };
  const data = { evaluations: [candidate, original] };
  assert.equal(evaluationForModule(data, preset, 'overview'), original);
  assert.equal(evaluationForModule(data, preset, 'refine'), original);
  for (const section of ['harness', 'cards', 'cases']) assert.equal(evaluationForModule(data, preset, section), candidate);
  const html = renderModuleSources(preset, 'harness', candidate, { 'review-id': '六例审查记录 <原文>' });
  assert.match(html, /六例审查记录 &lt;原文&gt;/); assert.match(html, /data-artifact="review-id"/);
  assert.match(html, /data-preview-artifact="review-id"/); assert.match(html, /候选局部回放/);
  assert.ok(!html.includes('>review-id<'));
});

test('case matrix and summaries preserve actual judgments and distinguish model attribution from evidence', () => {
  const entry = { ...item, caseId: 'C2', samples: [{ id: 'o', kind: 'original', result: false, rationale: '原理由' }, { id: 'b1', kind: 'baseline', result: true, rationale: '旧理由' }, { id: 'b2', kind: 'baseline', result: false, rationale: '旧理由二' }, { id: 'c1', kind: 'candidate', result: false, rationale: '新理由一' }, { id: 'c2', kind: 'candidate', result: true, rationale: '新理由二' }], summary: { status: 'ready', model: 'DeepSeek', output: { title: '<生成标题>', samples: [{ sampleId: 'c1', text: '模型对理由的转述' }], change: '模型解释变化' } } };
  const matrix = renderCaseMatrix([entry], 'C2');
  assert.equal((matrix.match(/expert-matrix-result/g) || []).length, 5);
  assert.match(matrix, /aria-pressed="true"/); assert.ok(matrix.indexOf('expert-matrix-result">false') < matrix.indexOf('expert-matrix-result">true'));
  const html = renderReasonSamples(entry, 'after');
  assert.match(html, /未核验事实/); assert.match(html, /新理由一/); assert.match(html, /新理由二/);
  assert.match(renderSummaryStatus(entry), /&lt;生成标题&gt;/);
  assert.doesNotMatch(renderSummaryStatus({ ...entry, summary: { status: 'disabled' } }), /data-generate-summary/);
  assert.match(renderSummaryStatus({ ...entry, summary: { status: 'failed', message: '实际失败' } }), /实际失败/);
});

test('task graph uses real score and role candidates, isolates independent history, and labels doubts semantically', () => {
  const evaluations = [{ id: 'original', score: { f1: .681818, denominators: { goldAspects: 12, documentAspects: 12 } }, cards: [], cases: [] }, { id: 'candidate', score: null, cards: [{ status: 'original' }, { status: 'original' }, { status: 'candidate' }, { status: 'candidate' }], cases: [{}] }];
  const cases = Array.from({ length: 6 }, (_, i) => ({ caseId: `C${i+1}`, samples: [{kind:'candidate'}, {kind:'candidate'}], workflow: { boundary: { binding: 'case' } } }));
  const html = renderTaskFlow({evaluations}, {evaluationId:'original',evaluationIds:['original','candidate']}, cases);
  assert.equal(TASK_FLOW_NODES.length, 7); assert.equal((html.match(/data-flow-node=/g)||[]).length, 7);
  for(const text of ['工业三维调研','F1 0.6818','2 份候选','12 次独立回放','6 个诊断疑点']) assert.ok(html.includes(text),text);
  assert.doesNotMatch(html, /24 次|确认错误|data-generate-summary| style=|<marker/);
  assert.match(html, /expert-flow-arrow arrow-boundary/);
  assert.equal(caseLabel('C1'),'统一格式'); assert.equal(caseLabel('C5'),'软件介绍风格');
  const matrix=renderCaseMatrix([{...item,caseId:'C2'}],'C2');
  assert.match(matrix,/接入修改边界/); assert.doesNotMatch(matrix,/>C2<\/strong>/);
});

test('controller loads API, switches to Card, prevents duplicate submit and refreshes saved feedback', async () => {
  const listeners = {}, status = { textContent: '' }, fieldset = { disabled: false };
  const host = { innerHTML: '', addEventListener: (type, fn) => listeners[type] = fn, setAttribute() {}, querySelector: selector => selector === '#expert-feedback-status' ? status : null };
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch, oldFormData = globalThis.FormData;
  let posts = 0, gets = 0, bootstraps = 0, summaryPosts = 0, release, releaseSummary;
  const matcherCard = { ...card, id: 'card-matcher', roleId: 'refine.aspect-matcher' };
  const workflowCases = Array.from({ length: 6 }, (_, i) => ({ caseId: `C${i + 1}`, evaluationId: 'evaluation', roleId: i === 5 ? matcherCard.roleId : card.roleId, axis: i === 5 ? null : 'content', direction: 'recall', samples: item.samples, workflow: { review: { binding: 'case', artifactId: `review-C${i + 1}`, text: `审查疑点 C${i + 1}` }, boundary: { binding: 'case', questionArtifactId: `q-C${i + 1}`, answerArtifactId: `a-C${i + 1}` }, cards: { binding: 'role', cardIds: [i === 5 ? matcherCard.id : card.id] }, replay: { binding: 'case', artifactIds: [] } }, summary: { enabled: i === 1, cacheKey: `cache-C${i + 1}`, status: i === 1 ? 'idle' : 'disabled' } }));
  const saved = { ...feedbackBinding(card, { thumb: 'down', text: '测试反馈' }, skill), id: 'saved1' };
  try {
    globalThis.document = { querySelector: () => host };
    globalThis.FormData = class { get(key) { return { thumb: 'down', text: '测试反馈', paragraph: '' }[key]; } };
    globalThis.fetch = async (url, init = {}) => {
      if (url === '/api/expert-demo') { bootstraps++; return { ok: true, json: async () => ({
        schemaVersion: '1',
        evaluations: [{ id: 'original', title: '原完整评价', score: { schemaVersion: '2.0', recall: .75, precision: .625, f1: .681818 }, cases: [], cards: [{ ...card, id: 'parent', version: 'v0', status: 'original' }], skills: [] }, { id: 'evaluation', title: '候选', score: null, cases: Array.from({ length: 6 }, (_, i) => ({ ...item, id: `C${i + 1}` })), cards: [{ ...card, id: 'parent', version: 'v0', status: 'original' }, card, matcherCard], skills: [skill] }],
        presets: [{ id: 'demo', title: '真实预设', sourceLabel: '原评价与后续候选', notice: '来源范围原文仅此一处', evaluationId: 'original', evaluationIds: ['original', 'evaluation'], moduleArtifactIds: { harness: ['review-id'] } }], defaultPresetId: 'demo', artifactTitles: { 'review-id': '审查原文标题' }, notice: '仅保存反馈'
      }) }; }
      if (url === '/api/expert-demo/cases') return { ok: true, json: async () => ({ defaultCaseId: 'C2', cases: workflowCases }) };
      if (url.startsWith('/api/expert-demo/artifacts/')) return { ok: true, json: async () => ({ id: url.split('/').pop(), title: '来源', content: JSON.stringify({ question: '真实边界问题', answer: '真实边界回复' }) }) };
      if (url === '/api/expert-demo/cases/C2/summary') { summaryPosts++; assert.equal(init.method, 'POST'); await new Promise(resolve => releaseSummary = resolve); return { ok: true, json: async () => ({ status: 'ready', model: 'DeepSeek', output: { title: '真实返回摘要', samples: [], change: '模型解释' } }) }; }
      assert.equal(url, '/api/expert-demo/skill-feedback');
      if (init.method === 'POST') { posts++; assert.deepEqual(JSON.parse(init.body), { skillId: skill.id, skillVersion: skill.version, cardId: card.id, cardVersion: card.version, thumb: 'down', text: '测试反馈' }); await new Promise(resolve => release = resolve); return { ok: true, json: async () => ({ item: saved }) }; }
      gets++; return { ok: true, json: async () => ({ items: posts ? [saved] : [] }) };
    };
    await loadExpertWorkbench();
    assert.match(host.innerHTML, /id="expert-preset-select"/); assert.doesNotMatch(host.innerHTML, /id="expert-evaluation-select"/);
    assert.match(host.innerHTML, /Refine 完整流程/); assert.match(host.innerHTML, /data-flow-family="experts"/); assert.doesNotMatch(host.innerHTML, /id="expert-flow-panel"/);
    for (const stage of ['description-reconstruction', 'candidate-skill-compilation', 'promotion-decision']) {
      listeners.click({ target: { closest: () => ({ dataset: { flowNode: `refine:${stage}` }, hasAttribute: () => false }) } });
      assert.match(host.innerHTML, /id="expert-flow-panel"/); assert.match(host.innerHTML, /此阶段正文尚未登记/);
      assert.equal(summaryPosts, 0, 'Refine stage navigation never starts paid summaries');
    }
    listeners.click({ target: { closest: () => ({ dataset: { flowFamily: 'experts' }, hasAttribute: () => false }) } });
    assert.match(host.innerHTML, /expert-flow-canvas/);
    assert.equal(summaryPosts, 0, 'task overview never generates summary');
    for (const flowNode of ['materials', 'score', 'review', 'boundary', 'cards']) {
      listeners.click({ target: { closest: () => ({ dataset: { flowNode }, hasAttribute: () => false }) } });
      assert.equal(summaryPosts, 0, `${flowNode} panel does not generate summary`);
    }
    listeners.click({ target: { closest: () => ({ dataset: { flowNode: 'experts' }, hasAttribute: () => false }) } });
    assert.equal((host.innerHTML.match(/data-select-case=/g) || []).length, 12); assert.match(host.innerHTML, /接入修改边界 ·/);
    assert.match(host.innerHTML, /<details class="expert-full-matrix"><summary>/); assert.match(host.innerHTML, /当前案例五次实际判断/);
    assert.equal(summaryPosts, 1, 'enabled uncached Expert detail keeps automatic summary');
    listeners.click({ target: { closest: () => ({ dataset: { generateSummary: 'C2' }, hasAttribute: () => false }) } });
    listeners.click({ target: { closest: () => ({ dataset: { generateSummary: 'C2' }, hasAttribute: () => false }) } });
    assert.equal(summaryPosts, 1); releaseSummary(); await new Promise(resolve => setTimeout(resolve, 0)); assert.match(host.innerHTML, /真实返回摘要/);
    listeners.click({ target: { closest: () => ({ dataset: { selectCase: 'C6' }, hasAttribute: () => false }) } });
    assert.equal(summaryPosts, 1, 'disabled case never generates');
    listeners.click({ target: { closest: () => ({ dataset: { section: 'cards' }, hasAttribute: () => false }) } });
    assert.match(host.innerHTML, /匹配专家|概念匹配/); assert.match(host.innerHTML, /同后缀识别 关联角色/);
    listeners.click({ target: { closest: () => ({ dataset: { selectCase: 'C2' }, hasAttribute: () => false }) } });
    listeners.click({ target: { closest: () => ({ dataset: { section: 'harness' }, hasAttribute: () => false }) } });
    assert.match(host.innerHTML, /审查疑点 C2/); assert.equal(host.innerHTML.split('来源范围原文仅此一处').length - 1, 1);
    listeners.click({ target: { closest: () => ({ dataset: { section: 'cards' }, hasAttribute: () => false }) } });
    assert.match(host.innerHTML, /保存版本反馈/);
    assert.match(host.innerHTML, /语义未验收/);
    const form = { id: 'expert-feedback-form', isConnected: true, querySelector: selector => selector === 'fieldset' ? fieldset : status };
    listeners.submit({ target: form, preventDefault() {} });
    listeners.submit({ target: form, preventDefault() {} });
    assert.equal(posts, 1); assert.equal(fieldset.disabled, true);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(gets, 2); assert.match(host.innerHTML, /测试反馈/); assert.match(status.textContent, /未自动学习/); assert.equal(fieldset.disabled, false);
    await loadExpertWorkbench({ force: true });
    assert.equal(bootstraps, 2); assert.equal(gets, 3); assert.match(host.innerHTML, /保存版本反馈/);
    assert.equal(summaryPosts, 1, 'cached/refresh or repeated render does not regenerate');
  } finally { globalThis.document = oldDocument; globalThis.fetch = oldFetch; globalThis.FormData = oldFormData; }
});
