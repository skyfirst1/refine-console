const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const source = id => `<button type="button" class="secondary-button" data-artifact="${escape(id)}">完整原件与来源</button>`;
export const REFINE_NODES = [
  {id:'description-reconstruction', title:'还原任务要求', hint:'需求与 Gold → Description', artifact:'description'},
  {id:'current-draft-generation', title:'生成当前初稿', hint:'当前 Skill → 初稿', artifact:'draft'},
  {id:'reviewer-private-expert', title:'评价当前初稿', hint:'内容与风格 → 原始评分', artifact:'current-score'},
  {id:'skill-attribution-review', title:'归因审查', hint:'文稿差距 → Skill 问题', artifact:'review'},
  {id:'candidate-skill-compilation', title:'编写候选 Skill', hint:'审查意见 → 候选规则', artifact:'skill'},
  {id:'candidate-draft-generation', title:'生成候选文稿', hint:'候选 Skill → 新文稿', artifact:'candidate-draft'},
  {id:'candidate-private-expert', title:'评价候选文稿', hint:'同一评价机制 → 候选评分', artifact:'candidate-score'},
  {id:'independent-judge', title:'独立对照审查', hint:'两份文稿 → 改善或退化', artifact:'judge'},
  {id:'promotion-decision', title:'决定是否晋升', hint:'评分 + 审查 → 保留或替换', artifact:'decision'},
];
export function parsedArtifact(cache, id) {
  try { return JSON.parse(cache[id]?.content || 'null'); } catch { return null; }
}
export function renderRefineFlow(cache = {}, selected = null, registered = []) {
  const summary = parsedArtifact(cache, 'independent-refine-summary');
  const run = parsedArtifact(cache, 'independent-refine-result');
  const completed = Array.isArray(run?.completedStages) ? run.completedStages : [];
  const decision = summary?.decision;
  const score = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '—';
  const rejected = decision?.decision === 'reject';
  const verdict = rejected ? '未采用新 Skill' : decision?.decision === 'accept' ? '接受候选 Skill' : '采用结果待载入';
  const groups = [
    {title:'原稿是什么样', description:'按原有写作规则完成任务，找出差距。', tag:'原有版本'},
    {title:'规则怎么改', description:'把文稿问题转为规则修改，再写一稿。', tag:'候选版本'},
    {title:'改完值得采用吗', description:'重新评分，并独立检查是否发生退化。', tag:'验证与决定'},
  ];
  const captions = [
    ['任务要求','从需求和参考成稿整理本次写作要求'],
    ['原 Skill 写出的文稿','查看改动前的真实文稿'],
    ['原稿评价',`综合 F1 ${score(decision?.currentF1)}`],
    ['找出规则里的问题','查看文稿差距及对应的规则修改建议'],
    ['改写后的 Skill','查看新版本的完整写作规则'],
    ['新 Skill 写出的文稿','查看使用候选规则重新生成的文稿'],
    ['新稿评价',`综合 F1 ${score(decision?.candidateF1)}`],
    ['两稿独立对照',decision?.judgeVerdict === 'regressed' ? '历史审查结果：新稿出现退化' : '查看独立审查的结论和理由'],
    ['采用决定',verdict],
  ];
  const reasons = [decision?.expertGatePassed === false ? 'Expert 验收门槛未通过' : '',decision?.judgeVerdict === 'regressed' ? '独立审查判为退化' : ''].filter(Boolean);
  return `<section class="expert-task-flow refine-flow"><header><div><span class="eyebrow">工业三维调研 · Refine</span><h2>改写规则，再验证效果</h2><p class="refine-intro">Refine 优化的是写作 Skill；用它重新写一稿，才能判断修改是否有效。</p></div></header>
  <div class="refine-result-strip" aria-label="本轮 Refine 结果"><div class="refine-score-pair"><div><span>原稿 F1</span><strong>${score(decision?.currentF1)}</strong></div><span class="refine-score-arrow" aria-hidden="true">→</span><div><span>新稿 F1</span><strong>${score(decision?.candidateF1)}</strong></div></div><div class="refine-result-verdict"><strong>${escape(verdict)}</strong><span>${escape(reasons.join(' · ') || '结果以历史决策记录为准')}</span><small>${decision?.activeSkillMutated === false ? '当前 Skill 保持不变' : 'Skill 状态见决策原件'}</small></div><button type="button" class="secondary-button" data-flow-node="refine:promotion-decision">为什么？ ↗</button></div>
  <div class="refine-story" aria-label="Refine 完整流程">${groups.map((group,i) => `<section class="refine-chapter"><header><span class="refine-chapter-number">${i+1}</span><div><small>${group.tag}</small><h3>${group.title}</h3></div></header><p>${group.description}</p><div class="refine-chapter-steps">${REFINE_NODES.slice(i*3,i*3+3).map((node,j) => {
    const index = i*3+j, [title,caption] = captions[index];
    const ready = registered.includes('independent-refine-'+node.artifact);
    return `<button type="button" class="refine-story-step ${selected === node.id ? 'selected' : ''}" data-flow-node="refine:${node.id}" aria-pressed="${selected === node.id}" aria-controls="expert-flow-panel"><span class="refine-step-icon" aria-hidden="true">${node.artifact.endsWith('score') ? '◷' : node.artifact === 'decision' ? '◇' : '≡'}</span><span class="refine-step-copy"><strong>${title}</strong><span>${escape(caption)}</span>${!completed.includes(node.id) ? '<small>阶段记录未载入</small>' : !ready ? '<small>正文未登记</small>' : ''}</span><span class="refine-step-open" aria-hidden="true">↗</span></button>`;
  }).join('')}</div></section>`).join('')}</div><footer class="refine-story-foot"><span>${completed.length ? `${completed.length} / 9 阶段已执行` : '阶段记录待载入'} · 点击部件查看原文</span><span>独立历史批次，与 Expert / Harness 六例实验分开展示。</span></footer></section>`;
}
const prose = text => `<pre class="expert-prose">${escape(text)}</pre>`;
function readable(value) {
  if (typeof value === 'string') return prose(value);
  if (Array.isArray(value)) return value.map(v => `<article class="refine-finding">${typeof v === 'string' ? prose(v) : readable(v)}</article>`).join('');
  if (value && typeof value === 'object') {
    const labels = {summary:'观察',reason:'依据',rationale:'判断理由',recommendation:'建议',suggestion:'建议',instruction:'规则',title:'主题',description:'说明',evidence:'证据',change:'改动',skillGap:'Skill 问题',proposedChange:'建议改动',expertAspectIds:'关联评价要点',id:'记录编号',type:'问题类型',skillSpan:'Skill 原文位置',effect:'影响',evidenceAspectIds:'关联证据要点',patchAction:'修改动作',proposedText:'建议规则原文',confidence:'模型自报置信度'};
    return Object.entries(value).map(([key, val]) => `<div class="refine-field"><h4>${escape(labels[key] || key)}</h4>${readable(val)}</div>`).join('');
  }
  return prose(String(value ?? '未提供'));
}
export function renderRefineDetail(stageId, cache = {}, registered = []) {
  const node = REFINE_NODES.find(n => n.id === stageId) || REFINE_NODES[0];
  const id = 'independent-refine-'+node.artifact, entry = cache[id];
  const summary = parsedArtifact(cache, 'independent-refine-summary');
  const format = v => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '未提供';
  let body = '';
  if (!registered.includes(id)) body = '<p>此阶段正文尚未登记，不能用阶段完成状态代替正文。</p>'+source('independent-refine-result');
  else if (entry?.error) body = `<p role="alert">阶段内容读取失败：${escape(entry.error)}</p>${source(id)}`;
  else if (!entry || entry.pending) body = '<p role="status">正在读取该阶段的历史内容…</p>';
  else {
    const data = parsedArtifact(cache, id);
    if (node.artifact.endsWith('score')) {
      body = `<div class="expert-metrics">${[['召回 Recall',data?.recall],['精确 Precision',data?.precision],['综合 F1',data?.f1]].map(([k,v]) => `<div class="expert-metric"><span>${k}</span><strong>${format(v)}</strong></div>`).join('')}</div><p>此处为本次 Refine 文稿评分，不是 Expert 正确率，也不是六例候选回放评分。</p>`;
    } else if (node.artifact === 'decision') {
      body = `<h3>${data?.decision === 'reject' ? '未晋升 · 保留当前 Skill' : escape(data?.decision || '未提供决定')}</h3><div class="expert-metrics"><div class="expert-metric"><span>当前文稿 F1</span><strong>${format(data?.expert?.currentScore)}</strong></div><div class="expert-metric"><span>候选文稿 F1</span><strong>${format(data?.expert?.candidateScore)}</strong></div></div><p>得分提升不等于通过晋升。Expert 门槛：${data?.expert?.gatePassed === true ? '通过' : data?.expert?.gatePassed === false ? '未通过' : '未提供'}；独立审查：${data?.judge?.verdict === 'regressed' ? '判为退化' : escape(data?.judge?.verdict || '未提供')}。</p>${prose(data?.judge?.reason || '')}<p>当前 Skill ${data?.activeSkillMutated === false ? '未被修改' : '修改状态见原件'}。</p>`;
    } else if (node.artifact === 'judge') body = `<h3>${data?.verdict === 'regressed' ? '独立审查判为退化' : escape(data?.verdict || '未提供结论')}</h3>${prose(data?.reason || '')}<p class="expert-small">这是历史 Judge 的判断，不是本页重新核验的结论。</p>`;
    else if (node.artifact === 'review') {
      const labels = {documentGaps:'文稿中的差距',skillGaps:'Skill 中的缺口',skillFindings:'Skill 归因与修改建议',uncertainties:'待确认事项',skillAttributions:'归因结果',revisionRequests:'改写建议',candidateInstructions:'候选规则',summary:'审查结论'};
      body = data ? Object.entries(data).filter(([k]) => k !== 'schemaVersion').map(([k,v]) => `<section class="refine-detail-section"><h3>${escape(labels[k] || k)}</h3>${readable(v)}</section>`).join('') : prose(entry.content);
    } else body = prose(entry.content);
    body += `<details class="expert-fold"><summary>阶段完整原文与来源</summary>${source(id)}${data ? prose(JSON.stringify(data,null,2)) : ''}</details>`;
  }
  return `<section class="panel expert-panel"><span class="eyebrow">Refine · ${escape(node.hint)}</span><h2>${node.title}</h2>${body}<p class="expert-small">原批次 ${escape(summary?.runId || '待载入')} · 历史只读，不会运行模型或修改 Skill。</p></section>`;
}
