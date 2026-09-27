import { REFINE_NODES, renderRefineFlow, renderRefineDetail } from './refine-flow.js';
const state = { data: null, caseData: null, caseError: "", selectedCaseId: null, artifacts: {}, summaryBusy: new Set(), summaryAttempts: new Set(), presetId: null, evaluationId: null, section: "overview", flowFamily: "refine", flowNode: null, filters: { roleId: "", axis: "", direction: "", caseId: "" }, cardId: null, skillId: null, feedback: [], feedbackBusy: false, loading: false, host: null };
export const escapeText = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const caseLabel = id => ({ C1: "统一格式", C2: "接入修改边界", C3: "范围与结论", C4: "日期粒度", C5: "软件介绍风格", C6: "同后缀识别" })[id] || id;
export const TASK_FLOW_NODES = [
  { id: "materials", title: "任务材料", panel: "materials", row: 1, column: 1 },
  { id: "score", title: "原完整评价", panel: "score", row: 1, column: 2 },
  { id: "experts", title: "Expert 判断", panel: "cases", row: 1, column: 3 },
  { id: "review", title: "Harness 审查", panel: "harness", row: 2, column: 3 },
  { id: "boundary", title: "边界确认", panel: "boundary", row: 2, column: 2 },
  { id: "cards", title: "Card 教学", panel: "cards", row: 3, column: 3 },
  { id: "replays", title: "候选回放", panel: "replay", row: 3, column: 2 },
];
const roleName = (value) => ({ "refine.evidence-aligner": "证据对齐 · Aligner", "refine.aspect-matcher": "概念匹配 · Matcher", "refine.aspect-extractor": "要点提取 · Extractor" })[value] || value || "未指定角色";
const axisName = (value) => ({ content: "内容", style: "表达风格", "not-applicable": "不适用" })[value] || "不适用";
const directionName = (value) => ({ recall: "召回方向", precision: "精确方向" })[value] || "未指定";
const sampleName = (sample, index) => ({ original: "原调用", baseline: "旧版回放", candidate: "候选回放" })[sample.kind] + (sample.kind === "original" ? "" : ` ${index}`);
const rawBlock = (text, cls = "") => `<pre class="expert-prose ${cls}">${escapeText(text || "暂无正文")}</pre>`;
export const excerptWithFullText = (text, limit = 300, label = "展开完整原文") => {
  const value = String(text || "");
  return `${rawBlock(value.slice(0, limit))}${value.length > limit ? `<details><summary>${escapeText(label)}</summary>${rawBlock(value)}</details>` : ""}`;
};
const sourceButton = (id, label = "查看来源原件") => id ? `<button type="button" class="secondary-button expert-source-button" data-artifact="${escapeText(id)}">${escapeText(label)}</button>` : "";
const options = (values, selected) => values.map(([value, label]) => `<option value="${escapeText(value)}" ${value === selected ? "selected" : ""}>${escapeText(label)}</option>`).join("");

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

export function resultLabel(result) {
  const value = typeof result === "boolean" ? result : result?.matched;
  const target = result && typeof result === "object" ? result.targetAspectId : undefined;
  if (typeof value !== "boolean") return "未提供判断";
  return `${value ? "匹配 · true" : "不匹配 · false"}${target !== undefined ? ` · 目标 ${target ?? "无"}` : ""}`;
}

export function filterCases(cases, filters) {
  return cases.filter(item => (!filters.roleId || item.roleId === filters.roleId) && (!filters.axis || (item.axis || "not-applicable") === filters.axis) && (!filters.direction || item.direction === filters.direction) && (!filters.caseId || item.id === filters.caseId));
}

export function renderScore(evaluation) {
  const score = evaluation.score;
  if (!score || score.schemaVersion !== "2.0") return `<section class="panel expert-panel"><span class="eyebrow">评价概览</span><h2>未评分</h2><p>此记录没有完整的 schema 2.0 评价结果。局部 matched 判断不等于正确率，也不会换算成候选得分。</p></section>`;
  const number = value => typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "—";
  return `<section class="panel expert-panel"><span class="eyebrow">原完整评价 · schema 2.0</span><h2>${escapeText(evaluation.title)}</h2><p>以下是本评价原件中的得分，不是新候选的成绩，也不是 Expert 判断正确率。</p><div class="expert-metrics">${[["召回 Recall", score.recall], ["精确 Precision", score.precision], ["综合 F1", score.f1]].map(([label, value]) => `<div class="expert-metric"><span>${label}</span><strong>${number(value)}</strong></div>`).join("")}</div><div class="expert-score-foot"><span>分母 · Gold 要点 ${escapeText(score.denominators?.goldAspects ?? "未提供")} / 文档要点 ${escapeText(score.denominators?.documentAspects ?? "未提供")}</span>${sourceButton(score.sourceArtifactId, "查看完整评分来源")}</div><p class="expert-small">原件 overallScore：${escapeText(score.overallScore ?? "未提供")}；数值按原件展示，不由本页重新计算。</p>${renderScoreDetails(score.details)}</section>`;
}

export function renderScoreDetails(rows) {
  const value = input => input === true ? "是" : input === false ? "否" : input ?? "未提供";
  return `<details class="expert-fold"><summary>内容 / 风格计分组成</summary><p class="expert-small">贡献取自评分原件的规则（内容匹配 + 风格匹配）/ 2；不替换总体得分，不代表判断正确率。</p>${Array.isArray(rows) && rows.length ? `<div class="expert-table-scroll"><table class="expert-score-table"><thead><tr><th>方向</th><th>源要点</th><th>目标要点</th><th>概念匹配</th><th>内容</th><th>风格</th><th>贡献</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeText(directionName(row.direction))}</td><td>${escapeText(row.sourceAspectId ?? "未提供")}</td><td>${escapeText(row.targetAspectId ?? "未提供")}</td><td>${escapeText(value(row.matched))}</td><td>${escapeText(value(row.contentMatched))}</td><td>${escapeText(value(row.styleMatched))}</td><td>${escapeText(value(row.contribution))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="expert-empty">未提供计分明细。</p>'}</details>`;
}

export function renderCase(item) {
  const indices = { original: 0, baseline: 0, candidate: 0 };
  return `<article class="panel expert-case"><header><div><h3>${escapeText(caseLabel(item.id))}</h3><p>${escapeText(roleName(item.roleId))} · ${escapeText(directionName(item.direction))} · ${escapeText(axisName(item.axis))}</p></div><span class="badge neutral">判断追踪，不投票定答案</span></header><div class="expert-samples">${(item.samples || []).map(sample => {
    const index = ++indices[sample.kind];
    return `<section class="expert-sample ${sample.kind === "candidate" ? "candidate" : ""}"><span class="expert-small">${escapeText(sampleName(sample, index))}</span><strong class="expert-result">${escapeText(resultLabel(sample.result))}</strong><span class="expert-sample-id">${escapeText(sample.id)}</span><details><summary>展开完整判断理由</summary>${rawBlock(sample.rationale)}</details>${sourceButton(sample.artifactId, "原始输出")}</section>`;
  }).join("")}</div><details class="expert-fold"><summary>案例来源</summary><div class="expert-source-links">${(item.artifactIds || []).map(id => sourceButton(id, id)).join("") || "暂无注册来源"}</div></details></article>`;
}

export function renderCaseMatrix(cases, selectedId) {
  const label = result => { const matched = typeof result === "boolean" ? result : result?.matched; return typeof matched === "boolean" ? (matched ? "true" : "false") + (typeof result === "object" && result?.targetAspectId ? ` · ${result.targetAspectId}` : "") : "—"; };
  return `<section class="expert-case-matrix"><div class="expert-matrix-heading"><h2>六例判断前后对照</h2><span class="expert-small">原始判断，不是正确率 · 选择一行查看完整过程</span></div><div class="expert-table-scroll"><table><thead><tr><th>案例 / 评价范围</th><th>原调用</th><th>旧回放 1</th><th>旧回放 2</th><th>新候选 1</th><th>新候选 2</th></tr></thead><tbody>${cases.map(item => {
    const samples = [...item.samples.filter(s => s.kind === "original"), ...item.samples.filter(s => s.kind === "baseline"), ...item.samples.filter(s => s.kind === "candidate")];
    return `<tr class="${item.caseId === selectedId ? "selected" : ""}"><th><button type="button" data-select-case="${escapeText(item.caseId)}" aria-pressed="${item.caseId === selectedId}"><strong>${escapeText(caseLabel(item.caseId))}</strong><span>${escapeText(roleName(item.roleId))} · ${escapeText(directionName(item.direction))} · ${escapeText(axisName(item.axis))}</span></button></th>${Array.from({ length: 5 }, (_, i) => `<td><span class="expert-matrix-result">${escapeText(label(samples[i]?.result))}</span></td>`).join("")}</tr>`;
  }).join("")}</tbody></table></div></section>`;
}

export function renderCasePicker(cases, selectedId) {
  return `<nav class="expert-case-picker" aria-label="选择案例"><span>案例</span>${cases.map(item => `<button type="button" data-select-case="${escapeText(item.caseId)}" aria-pressed="${item.caseId === selectedId}" class="${item.caseId === selectedId ? "selected" : ""}">${escapeText(caseLabel(item.caseId))}</button>`).join("")}</nav>`;
}

function renderSelectedResults(item) {
  const counts = { original: 0, baseline: 0, candidate: 0 };
  return `<div class="expert-selected-results" aria-label="当前案例五次实际判断">${item.samples.map(sample => `<div><span>${escapeText(sampleName(sample, ++counts[sample.kind]))}</span><strong>${escapeText(resultLabel(sample.result))}</strong></div>`).join("")}</div>`;
}

export function renderReasonSamples(item, kind) {
  const samples = item.samples.filter(s => kind === "before" ? s.kind !== "candidate" : s.kind === "candidate");
  const summary = item.summary, ready = summary?.status === "ready";
  let baselineIndex = 0, candidateIndex = 0;
  return `<div class="expert-reason-grid">${samples.map(sample => {
    const index = sample.kind === "baseline" ? ++baselineIndex : ++candidateIndex;
    const short = ready ? summary.output?.samples?.find(s => s.sampleId === sample.id)?.text : null;
    return `<article class="expert-reason-card"><div class="expert-card-heading"><h3>${escapeText(sampleName(sample, index))}</h3><strong>${escapeText(resultLabel(sample.result))}</strong></div>${short ? `<span class="expert-small">DeepSeek 对本次理由的归因摘要 · 未核验事实</span>${rawBlock(short)}` : `<span class="expert-small">判断理由原文节选 · 非摘要</span>${rawBlock(sample.rationale.slice(0, 180))}` }<details><summary>完整理由与来源</summary>${rawBlock(sample.rationale)}<p class="expert-small">样本 ${escapeText(sample.id)}</p>${sourceButton(sample.artifactId, "查看原始输出")}</details></article>`;
  }).join("")}</div>`;
}

export function renderSummaryStatus(item, busy = false) {
  const summary = item.summary || { status: "disabled" };
  const labels = { disabled: "摘要未启用", idle: "摘要未生成", pending: "摘要生成中", ready: "DeepSeek 理由摘要", failed: "摘要生成失败", blocked: "摘要暂不可生成" };
  return `<section class="expert-summary-status"><div><strong>${labels[summary.status] || "摘要状态未知"}</strong><span class="expert-small">仅转述各次理由，不验证原文事实或判断对错。</span></div>${summary.output && summary.status === "ready" ? `${summary.output.title ? `<h3>${escapeText(summary.output.title)}</h3>` : ""}${rawBlock(summary.output.change)}<span class="expert-small">DeepSeek 摘要 · 已缓存</span><details><summary>摘要来源</summary><p class="expert-small">模型 ${escapeText(summary.model)} · 提示版本 ${escapeText(summary.promptVersion)}</p></details>` : `<p>${escapeText(summary.message || "完整判断理由仍可直接阅读。")}</p>`}${summary.status === "idle" && summary.enabled === true ? `<button type="button" class="secondary-button" data-generate-summary="${escapeText(item.caseId)}" ${busy ? "disabled" : ""}>${busy ? "请求中…" : "生成本例理由摘要"}</button>` : ""}</section>`;
}

function workflowCases() { const preset = currentPreset(); return (state.caseData?.cases || []).filter(c => !preset || (preset.evaluationIds || [preset.evaluationId]).includes(c.evaluationId)); }
function selectedCase() { return workflowCases().find(c => c.caseId === state.selectedCaseId); }

function artifactText(id, field) {
  const item = state.artifacts[id];
  if (!id) return '<p class="expert-empty">未绑定该来源。</p>';
  if (!item || item.pending) return '<p class="expert-small">正在读取本例原文…</p>';
  if (item.error) return `<p role="alert">${escapeText(item.error)}</p>${sourceButton(id, "重试查看原件")}`;
  let text = item.content;
  try { const parsed = JSON.parse(text); if (field && typeof parsed?.[field] === "string") text = parsed[field]; } catch { /* Plain text stays unchanged. */ }
  return `${excerptWithFullText(text, 320, "展开完整正文")}${sourceButton(id, "查看完整原件")}`;
}

function renderCaseInquiry(item) {
  const review = item.workflow?.review, boundary = item.workflow?.boundary;
  return `<section class="expert-workflow-step"><div class="expert-step-heading"><span>02</span><div><h2>审查疑点与边界问答</h2><p>历史模型解释，不自动视为已核实事实。</p></div></div><div class="expert-inquiry-grid"><article><h3>审查记录</h3><span class="expert-small">${review?.binding === "case" ? "本例对应原文" : review?.binding === "batch" ? "全批审查记录 · 未精确绑定本例" : "未提供本例审查绑定"}</span>${review?.text ? `${excerptWithFullText(review.text, 300, "展开完整审查记录")}${sourceButton(review.artifactId, "审查完整原件")}` : artifactText(review?.artifactId, "review")}</article><article><h3>向边界方提出的问题</h3>${artifactText(boundary?.questionArtifactId, "question")}<details><summary>当时提交的案例与引句</summary>${artifactText(boundary?.questionArtifactId)}</details><h3>边界回复</h3>${artifactText(boundary?.answerArtifactId, "answer")}</article></div></section>`;
}

function renderCaseTeaching(item) {
  const evaluation = state.data.evaluations.find(e => e.id === item.evaluationId);
  const ids = item.workflow?.cards?.cardIds || [];
  const cards = (evaluation?.cards || []).filter(c => c.roleId === item.roleId && c.status === "candidate" && ids.includes(c.id));
  return `<section class="expert-workflow-step"><div class="expert-step-heading"><span>03</span><div><h2>相关角色的教学增量</h2><p>角色级共享教材，不是本例专属修复。未通过语义验收，不推广。</p></div></div>${cards.length ? cards.map(card => `<article class="expert-linked-card"><h3>${escapeText(roleName(card.roleId))} · ${escapeText(card.version)}</h3><h4>新增判断规则</h4>${excerptWithFullText(card.promptAppend, 320, "展开完整新增规则")}<details><summary>角色级教学实例全文</summary>${renderTeaching(card.badCase)}</details><button type="button" class="secondary-button" data-case-card="${escapeText(card.id)}">查看完整 Card、Skill 与反馈</button></article>`).join("") : '<p class="expert-empty">未绑定本例角色的候选增量；不从文本猜测对应关系。</p>'}</section>`;
}

function renderCaseWorkflow(item, section) {
  if (!item) return '<p class="expert-empty">没有可展示的案例工作流。</p>';
  const heading = `<div class="expert-selected-heading"><h2>${escapeText(caseLabel(item.caseId))} · ${escapeText(roleName(item.roleId))}</h2><span>${escapeText(directionName(item.direction))} · ${escapeText(axisName(item.axis))} · 局部判断，未评分</span></div>${renderSelectedResults(item)}`;
  if (section === "harness") return heading + renderCaseInquiry(item);
  if (section === "cases") return heading + renderSummaryStatus(item, state.summaryBusy.has(item.caseId)) + renderReasonSamples(item, "before") + renderReasonSamples(item, "after");
  return heading + renderSummaryStatus(item, state.summaryBusy.has(item.caseId)) + `<section class="expert-workflow-step"><div class="expert-step-heading"><span>01</span><div><h2>原判断与旧版两次回放</h2><p>固定原调用材料，保留各次实际理由。</p></div></div>${renderReasonSamples(item, "before")}</section>` + renderCaseInquiry(item) + renderCaseTeaching(item) + `<section class="expert-workflow-step"><div class="expert-step-heading"><span>04</span><div><h2>候选的两次新回放</h2><p>与上方原始结果对照；翻转或一致不等于改善。</p></div></div>${renderReasonSamples(item, "after")}</section>`;
}

async function loadCaseArtifacts(item) {
  const ids = [...new Set([item?.workflow?.review?.artifactId, item?.workflow?.boundary?.questionArtifactId, item?.workflow?.boundary?.answerArtifactId].filter(Boolean))];
  const pending = ids.filter(id => !state.artifacts[id]);
  if (!pending.length) return;
  pending.forEach(id => { state.artifacts[id] = { pending: true }; });
  await Promise.all(pending.map(async id => { try { state.artifacts[id] = await request(`/api/expert-demo/artifacts/${encodeURIComponent(id)}`); } catch (error) { state.artifacts[id] = { error: error.message }; } }));
  if (selectedCase()?.caseId === item.caseId) render();
}

async function generateSummary(caseId) {
  const item = workflowCases().find(c => c.caseId === caseId);
  const key = `${caseId}:${item?.summary?.cacheKey || ""}`;
  if (!item || item.summary?.enabled !== true || item.summary.status !== "idle" || state.summaryBusy.has(caseId) || state.summaryAttempts.has(key)) return;
  state.summaryAttempts.add(key);
  state.summaryBusy.add(caseId); render();
  try { item.summary = await request(`/api/expert-demo/cases/${encodeURIComponent(caseId)}/summary`, { method: "POST", body: "{}" }); }
  catch (error) { item.summary = { ...item.summary, status: "failed", message: error.message }; }
  finally { state.summaryBusy.delete(caseId); render(); }
}

export function feedbackBinding(card, input, skill) {
  if (!skill?.id || !skill?.version || !card?.id || !card?.version || skill.cardId !== card.id || skill.cardVersion !== card.version) throw new Error("缺少当前 Card 绑定的 Skill 正文版本，无法提交反馈。");
  if (!["up", "down"].includes(input.thumb)) throw new Error("请选择反馈方向。");
  const text = String(input.text || "").trim(), paragraph = String(input.paragraph || "").trim();
  if (!text) throw new Error("请写下反馈理由。");
  if (text.length > 4000) throw new Error("反馈理由最多 4000 字符，请缩短后提交。");
  if (paragraph.length > 1000) throw new Error("相关段落最多 1000 字符，请缩短后提交。");
  if (paragraph && !skill.text.includes(paragraph)) throw new Error("相关段落须逐字摘自当前 Skill 正文。");
  return { skillId: skill.id, skillVersion: skill.version, cardId: card.id, cardVersion: card.version, thumb: input.thumb, text, ...(paragraph ? { paragraph } : {}) };
}

export function teachingSections(raw) {
  const text = String(raw || "");
  const headings = [...text.matchAll(/^\[示范[^\r\n]*\][^\r\n]*/gm)];
  if (!headings.length) return [];
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.index ?? text.length;
    const body = text.slice(heading.index + heading[0].length, end);
    const output = /<<<([A-Z_]+)_START>>>[\s\S]*?<<<\1_END>>>/.exec(body);
    return { title: heading[0], input: output ? body.slice(0, output.index) : body, output: output?.[0] || "", after: output ? body.slice(output.index + output[0].length) : "" };
  });
}

export function renderTeaching(raw) {
  const sections = teachingSections(raw);
  return `${sections.length ? '<p class="expert-small">以下只按原文标题与输出标记分块；轴、方向及判断均为原文，不代表已验收。</p>' + sections.map(section => `<article class="expert-teaching-case"><h3>${escapeText(section.title)}</h3><details open><summary>任务输入与原有说明</summary>${rawBlock(section.input)}</details>${section.output ? `<details><summary>示范输出（原文）</summary>${rawBlock(section.output)}</details>` : '<p class="expert-small">未发现成对输出标记，请核对完整原文。</p>'}${section.after ? `<details><summary>错误对照与范围说明（原文）</summary>${rawBlock(section.after)}</details>` : ""}</article>`).join("") : '<p class="expert-small">未发现可分块的示范标题，保留完整原文展示。</p>'}<details class="expert-fold"><summary>展开完整教学实例原文</summary>${rawBlock(raw)}</details>`;
}

export function renderCard(card, cards, feedback, skills = []) {
  const parent = cards.find(c => c.digest === card.parentDigest);
  const available = skills.filter(s => s.cardId === card.id && s.cardVersion === card.version);
  const selected = available.find(s => s.id === state.skillId) || available[0];
  const skill = selected?.text || "";
  const entries = feedback.filter(f => f.skillId === selected?.id && f.skillVersion === selected?.version && f.cardId === card.id && f.cardVersion === card.version);
  const bound = Boolean(selected?.id && selected?.version && card.version);
  return `<article class="panel expert-panel"><div class="expert-card-heading"><div><span class="eyebrow">${escapeText(roleName(card.roleId))}</span><h2>${card.status === "candidate" ? "候选教学 Card" : "原始 Card"}</h2></div><span class="badge ${card.status === "candidate" ? "warning" : "neutral"}">${card.status === "candidate" ? "语义未验收 · 不推广" : "原始版本 · 非标准答案"}</span></div><p class="expert-small">版本 ${escapeText(card.version)}${card.status === "candidate" ? " · 候选整体表现：未评估" : ""}</p><details class="expert-fold"><summary>身份与完整提示词</summary><dl class="expert-metadata"><dt>Card ID</dt><dd>${escapeText(card.id)}</dd><dt>摘要</dt><dd>${escapeText(card.digest)}</dd><dt>父摘要</dt><dd>${escapeText(card.parentDigest || "无")}</dd></dl>${rawBlock(card.prompt)}${parent ? `<details><summary>展开原父提示词</summary>${rawBlock(parent.prompt)}</details>` : ""}</details></article>
  <section class="panel expert-panel expert-highlight"><span class="eyebrow">01 · 本次重点</span><h2>新增判断规则</h2><p>原样展示模型生成的增量；保存成功不代表规则正确。</p>${rawBlock(card.promptAppend || (card.status === "original" ? "原始版本，没有候选增量。" : "未提供单独增量。"))}</section>
  <section class="panel expert-panel"><span class="eyebrow">02 · Skill</span><h2>规范正文与反馈</h2>${!card.skill ? '<p class="expert-notice">此 Card 自身未提供 Skill 正文。下方若有任务评价规范，它是单独来源，不等于 Card 内嵌 Skill。</p>' : ""}${available.length ? `<label class="expert-skill-picker">反馈对象<select id="expert-skill-select">${options(available.map(s => [s.id, s.kind === "task-evaluation" ? "任务评价规范（单独来源）" : "Card 内嵌 Skill"]), selected?.id)}</select></label>` : ""}<p class="expert-small">Skill ${escapeText(selected?.id || "未绑定")} · 正文版本 ${escapeText(selected?.version || "未绑定")}</p>${skill ? `${rawBlock(skill.slice(0, 700), "expert-preview")}<details class="expert-fold"><summary>展开完整 Skill（${skill.length} 字符）</summary>${rawBlock(skill)}</details>` : '<p class="expert-empty">没有已绑定的规范正文，反馈暂不可用。</p>'}
  <form id="expert-feedback-form" class="expert-feedback-form"><fieldset ${!bound || state.feedbackBusy ? "disabled" : ""}><legend>对当前 Skill 版本反馈</legend><div class="expert-feedback-choice"><label><input type="radio" name="thumb" value="up" required> 有帮助</label><label><input type="radio" name="thumb" value="down" required> 需要调整</label></div><label>反馈理由（最多 4000 字符）<textarea name="text" rows="3" required maxlength="4000" placeholder="哪些判断标准清楚，哪些需要澄清？"></textarea></label><label>相关段落（可选，最多 1000 字符，须为当前正文原句）<textarea name="paragraph" rows="2" maxlength="1000" placeholder="逐字粘贴当前 Skill 原文，便于定位"></textarea></label><button type="submit" class="primary-button">${state.feedbackBusy ? "保存中…" : "保存版本反馈"}</button></fieldset><p>仅保存反馈，不自动学习、不修改 Skill 或 Card。</p><p id="expert-feedback-status" role="status"></p></form>
  <h3>此版本已保存的反馈 <span class="expert-small">${entries.length} 条</span></h3><div class="expert-feedback-list">${entries.length ? entries.map(f => `<article><strong>${f.thumb === "up" ? "有帮助" : "需要调整"}</strong><span class="expert-small"> · ${escapeText(f.createdAt || "已保存")}</span>${rawBlock(f.text)}${f.paragraph ? `<details><summary>相关段落</summary>${rawBlock(f.paragraph)}</details>` : ""}<small>绑定 Card ${escapeText(f.cardVersion)} / Skill ${escapeText(f.skillVersion)}</small></article>`).join("") : '<p class="expert-empty">当前版本还没有反馈。</p>'}</div></section>
  <section class="panel expert-panel"><span class="eyebrow">03 · Bad cases</span><h2>任务输入 → 示范作答</h2><p>教学原文包含模型的输入摘录、示范输出与对照；可能有遗漏或错误，本页不替它修正。</p>${renderTeaching(card.badCase)}<div class="expert-source-links">${(card.artifactIds || []).map(id => sourceButton(id, "查看教学来源")).join("")}</div></section>`;
}

export function evaluationForModule(data, preset, section) {
  const evaluations = (data.evaluations || []).filter(e => (preset.evaluationIds || [preset.evaluationId]).includes(e.id));
  if (["cases", "cards", "harness"].includes(section)) return evaluations.find(e => e.cards?.some(c => c.status === "candidate")) || evaluations.find(e => e.cases?.length) || evaluations[0];
  return evaluations.find(e => e.id === preset.evaluationId) || evaluations[0];
}

function currentPreset() { return state.data?.presets?.find(p => p.id === state.presetId); }
function currentPanel() { return state.section === "overview" ? TASK_FLOW_NODES.find(n => n.id === state.flowNode)?.panel || (state.flowNode?.startsWith("refine") ? "refine" : "overview") : state.section; }
function currentEvaluation() { const preset = currentPreset(); return preset ? evaluationForModule(state.data, preset, ["boundary", "replay"].includes(currentPanel()) ? "cases" : currentPanel()) : state.data?.evaluations.find(e => e.id === state.evaluationId); }

export function renderTaskFlow(data, preset, cases, selectedNode = null) {
  const original = preset ? evaluationForModule(data, preset, "score") : data.evaluations.find(e => e.score);
  const candidate = preset ? evaluationForModule(data, preset, "cards") : data.evaluations.find(e => e.cases?.length);
  const score = original?.score;
  const metrics = {
    materials: score ? `Gold ${score.denominators?.goldAspects ?? "—"} · 文档 ${score.denominators?.documentAspects ?? "—"} 要点` : "已登记任务来源",
    score: score ? `F1 ${Number(score.f1).toFixed(4)} · 原评分` : "未提供完整评分",
    experts: `${cases.length} 个诊断疑点`, review: `${cases.length} 个案例 · 历史审查`,
    boundary: `${cases.filter(c => c.workflow?.boundary?.binding === "case").length} 份对应回复`,
    cards: `${candidate?.cards?.filter(c => c.status === "candidate").length || 0} 份候选 · 未验收`,
    replays: `${cases.reduce((n, c) => n + c.samples.filter(s => s.kind === "candidate").length, 0)} 次独立回放 · 未整体评分`,
  };
return `<section class="expert-task-flow"><header><div><span class="eyebrow">工业三维调研</span><h2>Expert / Harness 判断优化</h2></div><p>点击节点查看真实内容</p></header><div class="expert-flow-canvas"><svg class="expert-flow-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M28 14 L36 14 M64 14 L72 14 M86 28 L86 36 M86 64 L86 72 M72 86 L64 86"/><path d="M72 50 L64 50"/></svg><span class="expert-flow-arrow arrow-materials" aria-hidden="true">→</span><span class="expert-flow-arrow arrow-score" aria-hidden="true">→</span><span class="expert-flow-arrow arrow-experts" aria-hidden="true">↓</span><span class="expert-flow-arrow arrow-review" aria-hidden="true">↓</span><span class="expert-flow-arrow arrow-cards" aria-hidden="true">←</span><span class="expert-flow-arrow arrow-boundary" aria-hidden="true">↔</span>${TASK_FLOW_NODES.map(node => `<button type="button" class="expert-flow-node ${selectedNode === node.id ? "selected" : ""}" data-flow-node="${node.id}" aria-pressed="${selectedNode === node.id}" aria-controls="expert-flow-panel"><span>${node.title}</span><strong>${escapeText(metrics[node.id])}</strong><small>查看内容 ↗</small></button>`).join("")}<p class="expert-flow-legend">关联历史批次<br>不是一次新的端到端闭环<br>疑点与候选均非确认结论</p></div></section>`;
}

export function renderModuleSources(preset, module, evaluation, titles = {}) {
  const labels = { refine: "Refine · 原完整评价", harness: "Harness · 审查与边界", cards: "Card · 教学与候选回放" };
  const ids = preset?.moduleArtifactIds?.[module] || [];
  const previewId = ids.includes("saved-review") ? "saved-review" : ids[0];
  return `<section class="panel expert-panel"><span class="eyebrow">历史材料 · 只读</span><h2>${module === "refine" && evaluation?.title?.startsWith("独立历史") ? "Refine · 独立历史" : labels[module]}</h2><p class="expert-small">${escapeText(evaluation?.title || "已注册来源")}</p>${module === "harness" ? '<p>先看审查记录，再按案例核对边界问答；完整过程保留在原始记录中。以下均为历史模型产物，不是已确认结论。</p>' : ""}<details class="expert-fold"><summary>查看全部来源（${ids.length} 份）</summary><div class="expert-module-sources">${ids.length ? ids.map((id, index) => `<div><span class="expert-small">${String(index + 1).padStart(2, "0")}</span>${sourceButton(id, titles[id] || `查看${module === "harness" ? "审查或边界" : "模块"}原件 ${index + 1}`)}</div>`).join("") : '<p class="expert-empty">此预设尚未注册该模块的来源原件。</p>'}</div></details>${module === "harness" && ids.length ? `<div id="expert-module-preview" class="expert-fold" data-preview-artifact="${escapeText(previewId)}" aria-live="polite"><p>正在载入审查记录预览…</p></div>` : ""}</section>`;
}

export function reviewPreviewText(artifact) {
  const content = String(artifact.content ?? "");
  if (artifact.id === "saved-review") {
    try { const parsed = JSON.parse(content); if (typeof parsed?.review === "string") return parsed.review; } catch { /* Plain-text sources retain their original display. */ }
  }
  return content;
}

async function loadModulePreview() {
  const target = state.host.querySelector("#expert-module-preview"), id = target?.dataset?.previewArtifact;
  if (!id) return;
  try {
    const artifact = await request(`/api/expert-demo/artifacts/${encodeURIComponent(id)}`);
    if (!target.isConnected) return;
    const content = reviewPreviewText(artifact);
    target.innerHTML = `<h3>${escapeText(artifact.title)}</h3><p class="expert-small">原文开头预览，非另行生成的摘要。</p>${rawBlock(content.slice(0, 700))}<details><summary>展开完整审查正文</summary>${rawBlock(content)}</details>`;
  } catch (error) { if (target.isConnected) target.textContent = `预览暂不可用：${error.message}。可通过上方来源按钮重试。`; }
}
function currentCard() { return currentEvaluation()?.cards.find(c => c.id === state.cardId); }
function currentSkill() { const card = currentCard(); const skills = (currentEvaluation()?.skills || []).filter(s => s.cardId === card?.id && s.cardVersion === card?.version); return skills.find(s => s.id === state.skillId) || skills[0]; }

function render() {
  const data = state.data, evaluation = currentEvaluation(), preset = currentPreset(), view = currentPanel();
  if (!evaluation) { state.host.innerHTML = '<div class="panel expert-panel"><h2>暂无已注册评价</h2><p>导入真实评价与教学候选后展示，不生成示例得分。</p></div>'; return; }
  const linkedCases = workflowCases();
  const visibleCases = filterCases(linkedCases.map(c => ({ ...c, id: c.caseId })), state.filters);
  if (!linkedCases.some(c => c.caseId === state.selectedCaseId)) state.selectedCaseId = linkedCases.find(c => c.caseId === state.caseData?.defaultCaseId)?.caseId || linkedCases[0]?.caseId || null;
  if (visibleCases.length && !visibleCases.some(c => c.caseId === state.selectedCaseId)) state.selectedCaseId = visibleCases[0].caseId;
  const activeCase = visibleCases.length ? selectedCase() : null;
  const cards = evaluation.cards || [];
  if (state.cardEvaluationId !== evaluation.id) { state.cardEvaluationId = evaluation.id; state.cardId = null; state.skillId = null; }
  const selectableCards = activeCase && view === "cards" ? cards.filter(c => c.roleId === activeCase.roleId) : cards;
  if (!selectableCards.some(c => c.id === state.cardId)) state.cardId = selectableCards.find(c => c.status === "candidate")?.id || selectableCards[0]?.id || null;
  const relatedPreset = (ids) => ({ ...preset, moduleArtifactIds: { ...preset?.moduleArtifactIds, refine: ids } });
  const refineIds = preset?.moduleArtifactIds?.refine || [];
  let content = "";
  if (view === "materials") content = `<section class="panel expert-panel"><h2>工业三维调研 · 任务材料</h2><p>这里是原评价登记的 Gold 与文档要点材料，不把要点摘录冒作完整文档。</p><div class="expert-source-links">${["gold-aspects", "document-aspects"].filter(id => refineIds.includes(id)).map(id => sourceButton(id, data.artifactTitles?.[id] || "查看任务材料")).join("")}</div></section>`;
  if (view === "score") content = renderScore(evaluation) + renderModuleSources(relatedPreset(refineIds.filter(id => !id.startsWith("independent-refine-"))), "refine", evaluation, data.artifactTitles);
  if (view === "refine") content = renderRefineDetail(state.flowNode?.split(':')[1], state.artifacts, refineIds) + renderModuleSources(relatedPreset(refineIds.filter(id => id.startsWith("independent-refine-"))), "refine", { title: "独立历史 Refine · 不属于六例批次" }, data.artifactTitles);
  if (activeCase && ["cases", "harness"].includes(view)) content = renderCaseWorkflow(activeCase, view);
  if (activeCase && view === "boundary") content = `<div class="expert-selected-heading"><h2>${escapeText(caseLabel(activeCase.caseId))}</h2><span>${escapeText(directionName(activeCase.direction))} · ${escapeText(axisName(activeCase.axis))}</span></div><section class="expert-inquiry-grid"><article><h3>边界提问</h3>${artifactText(activeCase.workflow?.boundary?.questionArtifactId, "question")}<details><summary>当时提供的案例与引句</summary>${artifactText(activeCase.workflow?.boundary?.questionArtifactId)}</details></article><article><h3>边界回复</h3><p class="expert-small">历史模型解释，不是已确认标准。</p>${artifactText(activeCase.workflow?.boundary?.answerArtifactId, "answer")}</article></section>`;
  if (activeCase && view === "replay") content = `<div class="expert-selected-heading"><h2>${escapeText(caseLabel(activeCase.caseId))} · 候选回放</h2><span>两次独立业务调用，未整体评分</span></div>${renderSelectedResults(activeCase)}${renderSummaryStatus(activeCase, state.summaryBusy.has(activeCase.caseId))}${renderReasonSamples(activeCase, "after")}`;
  if (view === "cards") content = `<div class="panel expert-filters"><label>相关角色与 Card<select id="expert-card-select">${options(selectableCards.map(c => [c.id, `${roleName(c.roleId)} · ${c.status === "candidate" ? "候选新增" : "原始"} · ${c.version}`]), state.cardId)}</select></label><span class="expert-small">${activeCase ? escapeText(caseLabel(activeCase.caseId)) + " 关联角色；教材是角色级，不是单例专属。" : "原父内容可展开。"}</span></div>${currentCard() ? renderCard(currentCard(), cards, state.feedback, evaluation.skills || []) : '<p class="expert-empty">没有注册的教学 Card。</p>'}`;
  if (linkedCases.length && ["cases", "harness", "boundary", "cards", "replay"].includes(view)) content = renderCasePicker(visibleCases, state.selectedCaseId) + `<details class="expert-full-matrix"><summary>展开六个疑点的结果矩阵</summary>${renderCaseMatrix(visibleCases, state.selectedCaseId)}</details>` + content;
  if (state.caseError && ["cases", "harness", "boundary", "cards", "replay"].includes(view)) content = `<p class="expert-notice" role="alert">案例详情暂不可用：${escapeText(state.caseError)}。已注册原件仍可查看。</p>` + content;
  const selectedNode = state.section === "overview" ? state.flowNode : TASK_FLOW_NODES.find(n => n.panel === view)?.id || (view === "refine" ? "refine" : null);
  const panelTitle = TASK_FLOW_NODES.find(n => n.id === selectedNode)?.title || REFINE_NODES.find(n => `refine:${n.id}` === selectedNode)?.title || "Refine 完整流程";
  const flowNavigation = `<nav class="expert-flow-families" aria-label="选择工作流程"><button type="button" data-flow-family="refine" aria-pressed="${state.flowFamily === 'refine'}"><strong>Refine · Skill 优化</strong><span>任务还原、归因改写、复测与晋升</span></button><button type="button" data-flow-family="experts" aria-pressed="${state.flowFamily === 'experts'}"><strong>Expert / Harness · 判断优化</strong><span>评价、边界通信、Card 教学与回放</span></button></nav>`;
  const flow = state.flowFamily === 'refine' ? renderRefineFlow(state.artifacts, state.flowNode?.split(':')[1], refineIds) : renderTaskFlow(data, preset, linkedCases, selectedNode);
  state.host.innerHTML = `<details class="expert-context-details expert-task-context"><summary>任务来源与历史预设</summary>${preset ? `<label>历史预设<select id="expert-preset-select">${options(data.presets.map(p => [p.id, p.title]), preset.id)}</select></label><p>${escapeText(preset.sourceLabel)}</p><p>${escapeText(preset.notice)}</p>` : `<select id="expert-evaluation-select">${options(data.evaluations.map(e => [e.id, e.title]), evaluation.id)}</select>`}<p>${escapeText(data.notice || "")}</p><p>流程总览、材料、评分、审查、边界和 Card 不生成摘要；进入 Expert 判断或候选回放详情时，未缓存的理由摘要按已启用额度自动生成，已有摘要直接读取。没有重新运行 Expert。</p></details>${flowNavigation}${flow}${view !== "overview" ? `<section id="expert-flow-panel" class="expert-flow-panel" aria-label="${escapeText(panelTitle)}"><header><h2>${escapeText(panelTitle)}</h2><button type="button" class="secondary-button" data-close-flow>收起详情</button></header><div class="expert-content">${content}</div></section>` : ""}<section id="expert-source" class="panel expert-panel hidden" aria-label="来源原件" tabindex="-1"></section>`;
  if (activeCase && ["harness", "boundary"].includes(view)) void loadCaseArtifacts(activeCase);
  if (activeCase && ["cases", "replay"].includes(view) && activeCase.summary?.enabled === true && activeCase.summary.status === "idle") void generateSummary(activeCase.caseId);
}

async function showArtifact(id, button) {
  if (button.disabled) return;
  button.disabled = true;
  const target = state.host.querySelector("#expert-source");
  target.classList.remove("hidden"); target.textContent = "正在读取注册来源…"; target.focus();
  try {
    const artifact = await request(`/api/expert-demo/artifacts/${encodeURIComponent(id)}`);
    if (!target.isConnected) return;
    target.innerHTML = `<div class="expert-card-heading"><h2>${escapeText(artifact.title || "来源原件")}</h2><button class="secondary-button" type="button" data-close-source>收起</button></div><p class="expert-small">注册 ID：${escapeText(artifact.id)} · SHA256：${escapeText(artifact.sha256)}</p>${rawBlock(artifact.content)}`;
  } catch (error) { if (target.isConnected) target.textContent = `来源读取失败：${error.message}`; }
  finally { button.disabled = false; }
}

async function saveFeedback(form) {
  if (state.feedbackBusy) return;
  const status = form.querySelector("#expert-feedback-status"), card = currentCard();
  let body;
  try { const fields = new FormData(form); body = feedbackBinding(card, { thumb: fields.get("thumb"), text: fields.get("text"), paragraph: fields.get("paragraph") }, currentSkill()); }
  catch (error) { status.textContent = error.message; return; }
  state.feedbackBusy = true; form.querySelector("fieldset").disabled = true; status.textContent = "正在保存当前版本反馈…";
  try {
    const saved = await request("/api/expert-demo/skill-feedback", { method: "POST", body: JSON.stringify(body) });
    state.feedback = [saved.item, ...state.feedback];
    let message = "已保存，仅记录反馈，未自动学习。";
    try { state.feedback = (await request("/api/expert-demo/skill-feedback")).items; }
    catch { message = "反馈已保存；列表刷新失败，当前显示已保存回执，请稍后刷新。"; }
    state.feedbackBusy = false; render();
    const current = state.host.querySelector("#expert-feedback-status");
    if (current) current.textContent = message;
  } catch (error) { status.textContent = `保存失败：${error.message}`; }
  finally { state.feedbackBusy = false; if (form.isConnected) form.querySelector("fieldset").disabled = false; }
}

function bind() {
  state.host.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.flowFamily) { state.flowFamily = button.dataset.flowFamily; state.flowNode = null; state.section = 'overview'; render(); }
    if (button.dataset.flowNode) { state.flowNode = button.dataset.flowNode; state.flowFamily = state.flowNode.startsWith('refine') ? 'refine' : 'experts'; state.section = "overview"; render(); if (state.flowFamily === 'refine') void loadRefineStage(); state.host.querySelector("#expert-flow-panel")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }
    if (button.hasAttribute("data-close-flow")) { state.flowNode = null; state.section = "overview"; render(); }
    if (button.dataset.selectCase) { state.selectedCaseId = button.dataset.selectCase; state.cardId = null; state.skillId = null; render(); }
    if (button.dataset.caseCard) { state.cardId = button.dataset.caseCard; state.section = "cards"; render(); }
    if (button.dataset.generateSummary) void generateSummary(button.dataset.generateSummary);
    if (button.dataset.section) { state.section = button.dataset.section; state.flowFamily = state.section === 'refine' ? 'refine' : 'experts'; if (state.section === "overview") state.flowNode = null; render(); }
    if (button.hasAttribute("data-reset-filters")) { state.filters = { roleId: "", direction: "", axis: "", caseId: "" }; render(); }
    if (button.dataset.artifact) void showArtifact(button.dataset.artifact, button);
    if (button.hasAttribute("data-close-source")) state.host.querySelector("#expert-source").classList.add("hidden");
    if (button.hasAttribute("data-retry-experts")) void loadExpertWorkbench({ force: true });
  });
  state.host.addEventListener("change", event => {
    const target = event.target;
    if (target.id === "expert-preset-select") { state.presetId = target.value; state.cardId = null; state.skillId = null; state.filters = { roleId: "", direction: "", axis: "", caseId: "" }; render(); }
    if (target.id === "expert-evaluation-select") { state.evaluationId = target.value; state.cardId = null; state.filters = { roleId: "", direction: "", axis: "", caseId: "" }; render(); }
    if (target.id === "expert-card-select") { state.cardId = target.value; state.skillId = null; render(); }
    if (target.id === "expert-skill-select") { state.skillId = target.value; render(); }
    if (target.dataset.filter) { state.filters[target.dataset.filter] = target.value; const filter = target.dataset.filter; render(); state.host.querySelector(`[data-filter="${filter}"]`)?.focus(); }
  });
  state.host.addEventListener("submit", event => { if (event.target.id === "expert-feedback-form") { event.preventDefault(); void saveFeedback(event.target); } });
}

export async function loadExpertWorkbench({ force = false } = {}) {
  if (!state.host) { state.host = document.querySelector("#expert-workbench"); bind(); }
  if (state.loading) return;
  if (state.data && !force) { render(); return; }
  state.loading = true; state.host.setAttribute("aria-busy", "true"); state.host.innerHTML = '<div class="panel expert-panel"><div class="loading-bar"></div><p>正在载入真实评价与教学记录…</p></div>';
  try {
    state.data = await request("/api/expert-demo");
    if (!Array.isArray(state.data.evaluations)) throw new Error("评价数据格式不完整");
    try { const caseData = await request("/api/expert-demo/cases"); if (!Array.isArray(caseData.cases)) throw new Error("案例工作流字段不完整"); state.caseData = caseData; state.caseError = ""; }
    catch (error) { state.caseData = null; state.caseError = error.message; }
    const presets = state.data.presets || [];
    if (!presets.some(p => p.id === state.presetId)) state.presetId = presets.find(p => p.id === state.data.defaultPresetId)?.id || presets[0]?.id || null;
    if (!state.data.evaluations.some(e => e.id === state.evaluationId)) state.evaluationId = state.data.evaluations[0]?.id;
    await loadRefineArtifacts(['independent-refine-summary', 'independent-refine-result']);
    let feedbackError = false;
    try { state.feedback = (await request("/api/expert-demo/skill-feedback")).items; } catch { feedbackError = true; }
    render();
    if (feedbackError) { const notice = document.createElement("p"); notice.className = "expert-notice"; notice.textContent = "评价已载入，反馈记录暂不可用；可稍后刷新。"; state.host.prepend(notice); }
  } catch (error) { state.host.innerHTML = `<section class="panel expert-panel" role="alert"><h2>暂时无法载入 Expert 工作区</h2><p>${escapeText(error.message)}</p><button type="button" data-retry-experts class="secondary-button">重试载入</button></section>`; }
  finally { state.loading = false; state.host.setAttribute("aria-busy", "false"); }
}

async function loadRefineArtifacts(ids) {
  const registered = currentPreset()?.moduleArtifactIds?.refine || [];
  await Promise.all(ids.filter(id => registered.includes(id) && !state.artifacts[id]).map(async id => {
    state.artifacts[id] = { pending: true };
    try { state.artifacts[id] = await request(`/api/expert-demo/artifacts/${encodeURIComponent(id)}`); }
    catch (error) { state.artifacts[id] = { error: error.message }; }
  }));
}

async function loadRefineStage() {
  const node = REFINE_NODES.find(n => `refine:${n.id}` === state.flowNode);
  if (!node) return;
  await loadRefineArtifacts(['independent-refine-'+node.artifact]);
  if (state.flowNode === `refine:${node.id}`) render();
}
