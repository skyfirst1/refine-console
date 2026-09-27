const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names = {ready:'待开始',running:'本轮执行中','waiting-answer':'等你回答','round-complete':'本轮结束 · 等你决定',failed:'执行失败 · 请核查',stopped:'已请求停止',interrupted:'服务重启 · 未自动恢复'};
const artifacts = {descriptionPath:'任务理解',draftPath:'当前文稿',draftExpertReportPath:'当前 Expert 评价',reviewPath:'审查意见',candidateSkillPath:'候选 Skill',candidateDraftPath:'候选文稿',candidateExpertReportPath:'候选 Expert 评价',judgePath:'独立复核',promotionDecisionPath:'采用建议',alignerCardAppend:'Aligner 教学增量',matcherCardAppend:'Matcher 教学增量'};
let selected, task, timer, mounted = false, busy = false;
const drafts = new Map();
async function api(path='', body) {
  const response = await fetch('/api/workflows'+path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result = await response.json(); if(!response.ok) throw Error(result.error || '操作失败'); return result;
}
function message(text, error=false) { const box=document.querySelector('#workflow-notice'); if(box){box.textContent=text;box.className=error?'workflow-notice error':'workflow-notice';} }
function remember() {
  if(!task)return; const root=document.querySelector('#workflow-detail'); if(!root)return;
  const values=drafts.get(task.id)||{};
  root.querySelectorAll('textarea').forEach(e=>{values[e.name]=e.value;}); drafts.set(task.id,values);
}
function restore() { const values=drafts.get(selected)||{};document.querySelectorAll('#workflow-detail textarea').forEach(e=>{if(Object.hasOwn(values,e.name))e.value=values[e.name];}); }
function cost(value) {return `$${Number(value?.settledUsd||0).toFixed(6)}${value?.unsettledRequests ? ` · ${value.unsettledRequests} 次待核算` : ''}`;}
export async function loadHumanWorkbench({taskId}={}) {
  if(taskId){remember();selected=taskId;}
  const root=document.querySelector('#human-workbench');
  if(!mounted) {
    root.innerHTML=`<div class="workflow-heading"><div><span class="eyebrow">HUMAN IN THE LOOP</span><h2>每一轮，由你决定</h2><p>修改规则 → 执行一轮 → 看结果与费用 → 再决定。不会自动开始下一轮。</p></div><a href="#history" class="secondary-button" id="workflow-history">查看历史记录 ↗</a></div>
      <div id="workflow-notice" role="status" class="workflow-notice"></div>
      <details class="panel workflow-create"><summary>＋ 准备一个真实任务 <small>此步不调用模型</small></summary>
      <form id="workflow-create"><label>流程<select name="kind"><option value="refine">Refine · 改进写作 Skill</option><option value="harness">Harness · 审查 Expert 并生成教学增量</option></select></label><label>任务简称<input name="title" placeholder="例如：调研任务 · 插件项目"></label>
      <div data-input-kind="refine"><label>需求 / 会话记录路径<input name="requirementsPath" placeholder="D:\\project\\requirements.md"></label><label>参考文稿路径<input name="goldPath" placeholder="D:\\project\\gold.md"></label><label>当前 Skill 路径<input name="activeSkillPath" placeholder="D:\\project\\SKILL.md"></label></div>
      <div data-input-kind="harness" hidden><label>固定案例批次配置路径<input name="configPath" placeholder="包含 cases、parents 和费用 guards 的 JSON"></label><p>沿用已固定的 Expert 回放缓存；本轮只运行审查与边界，不重新回放 Expert。</p></div>
      <button class="primary-button">准备任务，不开始计费</button></form></details>
      <div class="workflow-layout"><aside id="workflow-list" class="panel"></aside><section id="workflow-detail" class="panel"></section></div>`;
    root.addEventListener('input',e=>{if(e.target.closest('#workflow-detail'))remember();});
    root.querySelector('[name=kind]').addEventListener('change',e=>{root.querySelectorAll('[data-input-kind]').forEach(el=>{el.hidden=el.dataset.inputKind!==e.target.value;});});
    root.querySelector('#workflow-history').addEventListener('click',()=>document.querySelector('[data-view=history]').click());
    root.addEventListener('click', async e=>{
      const button=e.target.closest('button'); if(!button || busy)return;
      if(button.dataset.task){remember();selected=button.dataset.task;await refresh();}
      if(button.dataset.artifact)await showArtifact(button.dataset.artifact,Number(button.dataset.round));
      if(button.dataset.action)await act(button.dataset.action,button);
    });
    root.querySelector('#workflow-create').addEventListener('submit',async e=>{
      e.preventDefault();if(busy)return;busy=true;const button=e.target.querySelector('button');button.disabled=true;
      try {const result=await api('',Object.fromEntries(new FormData(e.target)));remember();selected=result.task.id;e.target.closest('details').open=false;message('任务已准备。请检查内容，确认后才会调用模型。');await refresh();}catch(error){message(error.message,true);}finally{busy=false;button.disabled=false;}
    });mounted=true;
  }
  await refresh(); clearInterval(timer);timer=setInterval(()=>{if(document.querySelector('#experts-view.active')&&!busy)void refresh(true);},3000);
}
async function refresh(poll=false) {
  try {
    const {tasks}=await api(); if(!selected&&tasks.length)selected=tasks[0].id;
    document.querySelector('#workflow-list').innerHTML=`<h3>实际任务 <small>${tasks.length}</small></h3>`+(tasks.map(t=>`<button type="button" class="workflow-task ${t.id===selected?'selected':''}" data-task="${t.id}"><small>${escape(t.kind.toUpperCase())} · 第 ${t.round} 轮</small><strong>${escape(t.title)}</strong><span>${escape(names[t.status]||t.status)}</span><small>${escape(cost(t.cost))}</small></button>`).join('')||'<p class="muted">还没有实际任务。上方准备任务，或从会话页选择区间。</p>');
    const next=tasks.find(t=>t.id===selected);
    if(poll && next?.id===task?.id && next?.version===task?.version && next?.status===task?.status && JSON.stringify(next?.cost)===JSON.stringify(task?.cost) && JSON.stringify(next?.pendingQuestions)===JSON.stringify(task?.pendingQuestions))return;
    remember();task=next;render();restore();
  } catch(error){message(error.message,true);}
}
function render() {
  const root=document.querySelector('#workflow-detail');
  if(!task){root.innerHTML='<div class="workflow-empty"><h2>先准备，再运行</h2><p>这里展示真实任务。历史回放与演示资料在「历史记录」中保留。</p></div>';return;}
  const active=['running','waiting-answer'].includes(task.status),canRun=['ready','round-complete'].includes(task.status)&&!task.running&&!task.cost.unsettledRequests;
  root.innerHTML=`<div class="workflow-detail-head"><span class="eyebrow">${escape(task.kind.toUpperCase())} · 第 ${task.round} 轮</span><h2>${escape(task.title)}</h2><span class="badge neutral">${escape(names[task.status]||task.status)}</span></div>
    <div class="workflow-cost"><div><small>累计已结算</small><strong>${escape(cost(task.cost))}</strong></div><div><small>本轮已结算</small><strong>${escape(cost(task.roundCost))}</strong></div><p>按模型返回用量计价；待核算不按 $0 处理。此处不是下一轮报价。</p></div>
    <div class="workflow-steps"><span>① 你修改规则</span><span>→ ② Agent 执行 / 提问</span><span>→ ③ 你确认下一轮</span></div>
    ${task.kind==='refine'?`<section class="workflow-editor"><h3>当前 Skill</h3><p>${escape(task.skillScope)}。保存后只用于下一轮；不会自动采用候选版本。</p><textarea name="skill" aria-label="当前 Skill" spellcheck="false" ${active?'disabled':''}>${escape(task.skillText)}</textarea><button data-action="skill" class="secondary-button" ${active?'disabled':''}>保存 Skill 修改</button></section>`:`<section class="workflow-editor"><h3>你补充的评价边界</h3><p>作为任务约束交给审查方与边界方，不冒充原文 Evidence。</p>${task.boundaries.map(b=>`<blockquote>${escape(b.text)}</blockquote>`).join('')}<textarea name="boundary" aria-label="追加评价边界" placeholder="哪些情况应允许，哪些应判为不符合？适用条件是什么？" ${active&&task.status!=='waiting-answer'?'disabled':''}></textarea><button data-action="boundary" class="secondary-button" ${active&&task.status!=='waiting-answer'?'disabled':''}>追加边界</button></section>`}
    ${task.pendingQuestions.map(q=>`<section class="workflow-question"><span class="eyebrow">审查 Harness 在等你</span><h3>${escape(q.question)}</h3>${q.caseId?`<small>局部案例：${escape(q.caseId)}</small>`:''}<textarea name="answer-${q.id}" aria-label="回答审查问题"></textarea><button data-action="answer" data-question="${q.id}" class="primary-button" ${!active?'disabled':''}>回答并继续本轮</button><p>等待期间不发起新的模型请求；回答后会继续本轮，可能产生费用。</p></section>`).join('')}
    <section class="workflow-rounds"><h3>本轮与历史产物</h3>${task.rounds.map(r=>`<details ${r.number===task.round?'open':''}><summary>第 ${r.number} 轮 · ${r.error?'失败':r.result?'已返回结果':'进行中 / 未完成'}</summary>${r.error?`<p class="error">${escape(r.error)}</p>`:''}${r.result?`<p>执行结果：${escape(r.result.status)}。候选不等于已应用。</p><div class="workflow-artifacts">${Object.keys(r.result.stageArtifacts||{}).map(key=>`<button class="secondary-button" data-artifact="${escape(key)}" data-round="${r.number}">${escape(artifacts[key]||key)}</button>`).join('')}</div>`:''}</details>`).join('')||'<p class="muted">尚未调用模型。</p>'}<div id="workflow-artifact"></div></section>
    <footer class="workflow-confirm">${canRun?`<label><input type="checkbox" id="workflow-confirm-cost"> 我已检查当前内容，确认开始第 ${task.round+1} 轮并产生模型费用</label><button data-action="continue" class="primary-button">${task.round?'开始下一轮':'开始第一轮'}</button>`:''}${active?'<button data-action="stop" class="secondary-button">停止本轮</button>':''}<p>${active||task.status==='stopped'?'停止会阻止后续请求；已发出的请求仍可能结算费用。':'每轮结束后停下等你，不自动续跑。失败或费用不明时，请先核查记录。'}</p></footer>`;
}
async function act(action,button) {
  remember();const values=drafts.get(selected)||{};let body={version:task.version};
  if(action==='skill')Object.assign(body,{content:values.skill,expectedSha256:task.skillSha256});
  if(action==='boundary')body.text=values.boundary;
  if(action==='answer')Object.assign(body,{questionId:button.dataset.question,answer:values['answer-'+button.dataset.question]});
  if(action==='continue') {
    if(task.kind==='refine'&&values.skill!==undefined&&values.skill!==task.skillText){message('Skill 还有未保存修改，请先保存。',true);return;}
    if(task.kind==='harness'&&values.boundary?.trim()){message('边界还有未提交内容，请先追加。',true);return;}
    if(!document.querySelector('#workflow-confirm-cost')?.checked){message('请先确认本轮会产生模型费用。',true);return;}body.confirm=true;
  }
  busy=true;button.disabled=true;
  try {const result=await api('/'+selected+'/'+action,body);if(action==='boundary')values.boundary='';if(action==='answer')delete values['answer-'+button.dataset.question];drafts.set(selected,values);task=result.task;render();restore();message(action==='stop'?'已请求停止；在途请求仍可能结算。':action==='continue'?'本轮已开始；结束后等待你确认。':'已保存。');await refresh();}catch(error){message(error.message,true);}finally{busy=false;button.disabled=false;}
}
async function showArtifact(key,round) {
  try {const result=await api('/'+selected+'/artifact?round='+round+'&key='+encodeURIComponent(key));const box=document.querySelector('#workflow-artifact');box.innerHTML=`<h3>${escape(artifacts[key]||key)}</h3><pre>${escape(result.content)}</pre>${key==='candidateSkillPath'?'<button class="secondary-button" id="workflow-load-candidate">放入 Skill 编辑器（尚未保存）</button>':''}`;box.querySelector('button')?.addEventListener('click',()=>{const editor=document.querySelector('[name=skill]');if(editor.disabled)return;editor.value=result.content;remember();editor.focus();message('候选已放入编辑器。请检查后保存；不会自动应用。');});}catch(error){message(error.message,true);}
}
