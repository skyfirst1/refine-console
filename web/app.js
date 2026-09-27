const state = {
  view: "sessions",
  status: null,
  sessions: [],
  activeKey: null,
  detail: null,
  searchTimer: null,
  sending: false,
  chatAbort: null,
  live: null,
  skills: [],
  activeSkill: null,
  skillFile: null,
  selectedSkill: null,
  acontextTask: null,
  acontextPollTimer: null,
  dreamTask: null,
  dreamPollTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function toast(message, type = "success", timeout = 4200) {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), timeout);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.disabled) button.dataset.label = button.textContent;
    button.textContent = label || "处理中…";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    delete button.dataset.label;
  }
}

function shortProject(path) {
  return path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop().replace(/^pi-/i, "") : "未知项目";
}

function formatDate(value) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

async function loadStatus() {
  const data = await api("/api/status");
  state.status = data;
  $("#project-name").textContent = shortProject(data.cwd);
  if (!$("#provider-input").dataset.edited) $("#provider-input").value = data.defaults.provider;
  if (!$("#model-input").dataset.edited) $("#model-input").value = data.defaults.model;
  const connected = data.memory.connected;
  const configured = data.memory.configured;
  $("#acontext-badge").textContent = connected ? "记忆插件已连接" : configured ? "记忆暂不可用" : "记忆插件未配置";
  $("#acontext-badge").className = `badge ${connected ? "success" : "warning"}`;
  $("#memory-dot").className = `status-dot ${connected ? "online" : ""}`;
  $("#memory-title").textContent = connected ? "Acontext 已自动接入" : "Coding Agent 可正常使用";
  $("#memory-detail").textContent = connected
    ? "会话记忆在后台同步"
    : configured ? "记忆连接失败，不影响 Agent 工具" : "未配置记忆，不影响 Agent 工具";
}

let expertWorkbenchModule;
let humanWorkbenchModule;
async function loadHumanWorkbench(options = {}) {
  humanWorkbenchModule ||= import('/human-workbench.js');
  try { await (await humanWorkbenchModule).loadHumanWorkbench(options); }
  catch(error) { toast(error.message, 'error'); }
}
async function loadExpertWorkbench({ force = false } = {}) {
  expertWorkbenchModule ||= import("/expert-workbench.js");
  try { await (await expertWorkbenchModule).loadExpertWorkbench({ force }); }
  catch (error) { toast(`Expert 工作区载入失败：${error.message}`, "error"); }
}

function showView(view) {
  state.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}-view`));
  $("#page-title").textContent = ({ sessions: "Coding Agent", plugins: "插件", skills: "Skills", experts: "工作流程", history: "历史记录" })[view] || "Coding Agent";
  $("#new-session").classList.toggle("hidden", view === "experts" || view === "history");
  window.location.hash = view;
  if (view === "plugins") void loadPlugins();
  if (view === "skills") void loadSkills();
  if (view === "experts") void loadHumanWorkbench();
  if (view === "history") void loadExpertWorkbench();
}

function sessionCard(session) {
  return `<button class="session-card ${state.activeKey === session.key ? "active" : ""}" data-session-key="${session.key}" type="button">
    <span class="session-card-top"><strong>${escapeHtml(session.name)}</strong><time>${session.source === "codex" ? "Codex 历史 · " : ""}${formatDate(session.modified)}</time></span>
    <p>${escapeHtml(session.firstMessage || "新会话，尚无消息")}</p>
    <span class="session-card-meta"><span>${session.messageCount} 条消息</span><span>${escapeHtml(shortProject(session.cwd))}</span></span>
  </button>`;
}

async function loadSessions() {
  const list = $("#session-list");
  list.innerHTML = '<div class="loading-bar"></div>';
  const scope = $("#scope-all").checked ? "all" : "project";
  const query = encodeURIComponent($("#session-search").value.trim());
  try {
    const [runtime, codex] = await Promise.all([
      api(`/api/sessions?scope=${scope}&q=${query}`),
      api(`/api/codex-sessions?scope=${scope}&q=${query}`),
    ]);
    state.sessions = [...runtime.sessions.map((session) => ({ ...session, source: "agent" })), ...codex.sessions]
      .sort((left, right) => new Date(right.modified) - new Date(left.modified));
    $("#session-count").textContent = `${state.sessions.length} 个会话（含 Codex 历史）`;
    list.innerHTML = state.sessions.length ? state.sessions.map(sessionCard).join("") : '<div class="empty-list">没有找到匹配的会话</div>';
    $$('[data-session-key]').forEach((button) => button.addEventListener("click", () => void selectHistorySession(button.dataset.sessionKey)));
  } catch (error) {
    list.innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
}

async function selectHistorySession(key) {
  const session = state.sessions.find((item) => item.key === key);
  if (!session || session.source !== "codex") return openSession(key);
  const button = $(`[data-session-key="${key}"]`);
  setBusy(button, true, "正在投影为 Agent 会话…");
  try {
    const data = await api(`/api/codex-sessions/${key}/project`, { method: "POST", body: "{}" });
    await loadSessions();
    await openSession(data.session.key, false);
    toast(data.reused ? "已打开现有 Codex 投影" : "Codex 历史已投影为 Agent 会话");
  } catch (error) {
    toast(error.message, "error", 8000);
    setBusy(button, false);
  }
}

async function createNewSession() {
  const buttons = [$("#new-session"), $("#empty-new-session")];
  buttons.forEach((button) => setBusy(button, true, "创建中…"));
  try {
    const data = await api("/api/sessions/new", { method: "POST", body: "{}" });
    await loadSessions();
    await openSession(data.session.key, false);
    $("#chat-input").focus();
  } catch (error) {
    toast(error.message, "error", 7000);
  } finally {
    buttons.forEach((button) => setBusy(button, false));
  }
}

function selectionFromControls() {
  if (!$("#acontext-start").value) return null;
  return {
    version: 1,
    acontext: { startEntryId: $("#acontext-start").value, endEntryId: $("#acontext-end").value },
    refine: { startEntryId: $("#refine-start").value, endEntryId: $("#refine-end").value },
  };
}

function rangeNumber(id) {
  const entry = state.detail?.entries.find((item) => item.id === id);
  return entry ? entry.index + 1 : "—";
}

function updateRangeSummary() {
  const selection = selectionFromControls();
  $("#range-summary").textContent = selection
    ? `蒸馏区间 · A ${rangeNumber(selection.acontext.startEntryId)}→${rangeNumber(selection.acontext.endEntryId)} · R ${rangeNumber(selection.refine.startEntryId)}→${rangeNumber(selection.refine.endEntryId)}`
    : "在消息下方使用 ◇ 选择蒸馏起止点";
}

function applySelection(selection) {
  if (!selection) {
    updateRangeSummary();
    renderTimeline();
    return;
  }
  $("#acontext-start").value = selection.acontext.startEntryId;
  $("#acontext-end").value = selection.acontext.endEntryId;
  $("#refine-start").value = selection.refine.startEntryId;
  $("#refine-end").value = selection.refine.endEntryId;
  updateRangeSummary();
  renderTimeline();
}

function populateSelects(entries) {
  const selectable = entries.filter((entry) => entry.type === "message");
  const options = selectable.map((entry) => `<option value="${entry.id}">${escapeHtml(entry.label)}</option>`).join("");
  ["#acontext-start", "#acontext-end", "#refine-start", "#refine-end"].forEach((selector) => { $(selector).innerHTML = options; });
}

function rangeIndexes(selection, entries) {
  const index = new Map(entries.map((entry, position) => [entry.id, position]));
  return selection ? {
    as: index.get(selection.acontext.startEntryId), ae: index.get(selection.acontext.endEntryId),
    rs: index.get(selection.refine.startEntryId), re: index.get(selection.refine.endEntryId),
  } : {};
}

function messageActions(entry, selection) {
  const feedback = state.detail.feedback?.[entry.id];
  const marked = selection && Object.values(selection.acontext).includes(entry.id) || selection && Object.values(selection.refine).includes(entry.id);
  return `<div class="message-actions">
    <button class="message-action ${feedback === "up" ? "active" : ""}" data-feedback="up" data-entry-id="${entry.id}" title="有帮助" aria-label="有帮助">赞</button>
    <button class="message-action ${feedback === "down" ? "active" : ""}" data-feedback="down" data-entry-id="${entry.id}" title="没帮助" aria-label="没帮助">踩</button>
    <button class="message-action ${marked ? "marker-active" : ""}" data-marker="${entry.id}" title="选择蒸馏起止点" aria-label="选择蒸馏起止点">◇</button>
  </div>`;
}

function toolTrace(tool) {
  return `<div class="tool-trace"><strong>${escapeHtml(tool.name)}</strong>${tool.arguments ? ` · ${escapeHtml(tool.arguments)}` : ""}</div>`;
}

function renderMessage(entry, inA, inR, selection) {
  if (entry.role === "toolResult") {
    return `<div class="meta-entry ${inA ? "in-acontext" : ""} ${inR ? "in-refine" : ""}">${escapeHtml(entry.text || "工具执行完成")}</div>`;
  }
  const role = entry.role === "user" ? "user" : "assistant";
  const avatar = role === "user" ? "你" : "R";
  const tools = entry.toolCalls?.length ? `<div class="tool-traces">${entry.toolCalls.map(toolTrace).join("")}</div>` : "";
  return `<article class="chat-message ${role} ${inA ? "in-acontext" : ""} ${inR ? "in-refine" : ""}" data-message-id="${entry.id}">
    <span class="message-avatar">${avatar}</span>
    <div class="message-stack">
      <div class="message-bubble">${escapeHtml(entry.text || (tools ? "正在调用工具" : "（空）"))}</div>
      ${tools}
      ${messageActions(entry, selection)}
    </div>
  </article>`;
}

function bindMessageActions() {
  $$('[data-feedback]').forEach((button) => button.addEventListener("click", () => void saveFeedback(button.dataset.entryId, button.dataset.feedback)));
  $$('[data-marker]').forEach((button) => button.addEventListener("click", () => toggleMarkerMenu(button)));
}

function renderTimeline() {
  if (!state.detail) return;
  const selection = selectionFromControls();
  const positions = rangeIndexes(selection, state.detail.entries);
  const visible = state.detail.entries.filter((entry) => entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary");
  $("#timeline").innerHTML = visible.map((entry) => {
    const position = state.detail.entries.findIndex((item) => item.id === entry.id);
    const inA = positions.as !== undefined && positions.ae !== undefined && position >= positions.as && position <= positions.ae;
    const inR = positions.rs !== undefined && positions.re !== undefined && position >= positions.rs && position <= positions.re;
    return entry.type === "message"
      ? renderMessage(entry, inA, inR, selection)
      : `<div class="meta-entry">${escapeHtml(entry.text)}</div>`;
  }).join("") || '<div class="empty-list">这是一个新会话，发送消息即可开始。</div>';
  bindMessageActions();
}

function toggleMarkerMenu(button) {
  $$(".endpoint-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "endpoint-menu";
  menu.innerHTML = `
    <button data-endpoint="acontext-start">Acontext 起点</button>
    <button data-endpoint="acontext-end">Acontext 终点</button>
    <button data-endpoint="refine-start">Refine 起点</button>
    <button data-endpoint="refine-end">Refine 终点</button>`;
  menu.querySelectorAll("button").forEach((item) => item.addEventListener("click", () => {
    setRangeEndpoint(button.dataset.marker, item.dataset.endpoint);
    menu.remove();
  }));
  button.parentElement.append(menu);
}

function setRangeEndpoint(entryId, endpoint) {
  const [kind, edge] = endpoint.split("-");
  const start = $(`#${kind}-start`);
  const end = $(`#${kind}-end`);
  const positions = new Map(state.detail.entries.map((entry, index) => [entry.id, index]));
  if (edge === "start") {
    start.value = entryId;
    if ((positions.get(start.value) ?? 0) > (positions.get(end.value) ?? 0)) end.value = entryId;
  } else {
    end.value = entryId;
    if ((positions.get(end.value) ?? 0) < (positions.get(start.value) ?? 0)) start.value = entryId;
  }
  updateRangeSummary();
  renderTimeline();
  toast(`已选择 ${kind === "acontext" ? "Acontext" : "Refine"} ${edge === "start" ? "起点" : "终点"}`);
}

async function saveFeedback(entryId, value) {
  const current = state.detail.feedback?.[entryId];
  const next = current === value ? null : value;
  try {
    await api(`/api/sessions/${state.activeKey}/feedback`, { method: "POST", body: JSON.stringify({ entryId, value: next }) });
    if (next) state.detail.feedback[entryId] = next;
    else delete state.detail.feedback[entryId];
    renderTimeline();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openSession(key, refreshList = true) {
  state.activeKey = key;
  state.live = null;
  $("#session-empty").classList.add("hidden");
  $("#session-detail").classList.remove("hidden");
  $("#session-detail").insertAdjacentHTML("afterbegin", '<div class="loading-bar"></div>');
  if (refreshList) await loadSessions();
  try {
    const detail = await api(`/api/sessions/${key}`);
    if (state.activeKey !== key) return;
    state.detail = detail;
    $("#session-detail .loading-bar")?.remove();
    $("#detail-title").textContent = detail.session.name;
    $("#detail-kicker").textContent = detail.selectionSource === "saved" ? "SESSION · 已保存蒸馏区间" : "SESSION";
    $("#detail-meta").textContent = `${detail.session.id} · ${detail.session.cwd}`;
    $("#entry-count").textContent = `${detail.entries.filter((entry) => entry.type === "message").length} 条消息`;
    $("#auto-note").textContent = detail.automatic
      ? detail.automatic.artifacts
        ? `${detail.automatic.note} 交付物：${detail.automatic.artifacts.baseline} → ${detail.automatic.artifacts.gold}`
        : detail.automatic.note
      : "发送消息后可自动识别，或使用消息下方的 ◇ 手工选择。";
    populateSelects(detail.entries);
    applySelection(detail.selection);
    void resumeAcontextTask(key);
    void resumeAutoDreamTask(key);
    $("#chat-input").focus();
  } catch (error) {
    $("#session-detail .loading-bar")?.remove();
    toast(error.message, "error", 7000);
  }
}

function setAcontextTaskButton(task) {
  if (!task || task.status === "completed" || task.status === "failed") {
    setBusy($("#learn-acontext"), false);
    return;
  }
  const labels = {
    queued: "后台排队中…",
    preparing: "正在准备…",
    replaying: `回放中 ${task.storedMessages || 0}…`,
    learning: "后台学习中…",
    syncing: "正在同步…",
  };
  setBusy($("#learn-acontext"), true, labels[task.status] || "后台学习中…");
}

function monitorAcontextTask(taskId, announceTerminal = true) {
  window.clearTimeout(state.acontextPollTimer);
  const poll = async () => {
    try {
      const data = await api(`/api/acontext-tasks/${taskId}`);
      const task = data.task;
      state.acontextTask = task;
      if (state.activeKey === task.sessionKey) setAcontextTaskButton(task);
      if (task.status === "completed") {
        if (announceTerminal) toast(`Acontext 已学习 ${task.result.storedMessages} 条消息，并同步 ${task.result.skillCount} 个 skill`, "success", 9000);
        if (task.sessionKey) window.setTimeout(() => void resumeAutoDreamTask(task.sessionKey), 200);
        return;
      }
      if (task.status === "failed") {
        if (announceTerminal) toast(`Acontext 后台学习失败：${task.error}`, "error", 9000);
        return;
      }
      state.acontextPollTimer = window.setTimeout(poll, 2000);
    } catch (error) {
      if (announceTerminal) toast(error.message, "error", 9000);
      if (state.activeKey) setAcontextTaskButton(null);
    }
  };
  void poll();
}

function setAutoDreamStatus(task) {
  const badge = $("#dream-status");
  if (!badge) return;
  if (!task) {
    badge.textContent = "Auto-Dream 等待信号";
    badge.className = "badge neutral";
    return;
  }
  const labels = {
    queued: "Auto-Dream 排队中",
    orienting: "Auto-Dream 定位证据",
    consolidating: "Auto-Dream 整合中",
    validating: "Auto-Dream 独立验证",
    publishing: "Auto-Dream 发布中",
    approved: "Auto-Dream 已通过",
    rejected: "Auto-Dream 已拒绝",
    skipped: "Auto-Dream 已是最新",
    failed: "Auto-Dream 失败",
  };
  badge.textContent = labels[task.status] || `Auto-Dream ${task.status}`;
  badge.className = `badge ${task.status === "approved" || task.status === "skipped" ? "success" : task.status === "rejected" || task.status === "failed" ? "warning" : "neutral"}`;
}

function monitorAutoDreamTask(taskId, announceTerminal = true) {
  window.clearTimeout(state.dreamPollTimer);
  const poll = async () => {
    try {
      const data = await api(`/api/auto-dream-tasks/${taskId}`);
      const task = data.task;
      state.dreamTask = task;
      if (state.activeKey === task.sessionKey) setAutoDreamStatus(task);
      if (["approved", "rejected", "skipped", "failed"].includes(task.status)) {
        if (announceTerminal) {
          if (task.status === "approved") toast("Auto-Dream 已通过独立验证并发布新的合并 Skill", "success", 9000);
          else if (task.status === "skipped") toast("Auto-Dream 输入未变化，沿用当前 Skill", "success", 7000);
          else if (task.status === "rejected") toast(`Auto-Dream 候选未通过验证：${task.result?.reason || "证据不足"}`, "error", 9000);
          else toast(`Auto-Dream 失败：${task.error}`, "error", 9000);
        }
        return;
      }
      state.dreamPollTimer = window.setTimeout(poll, 2000);
    } catch (error) {
      if (announceTerminal) toast(error.message, "error", 9000);
      if (state.activeKey) setAutoDreamStatus(null);
    }
  };
  void poll();
}

async function resumeAutoDreamTask(key) {
  try {
    const data = await api(`/api/sessions/${key}/dream`);
    if (state.activeKey !== key) return;
    state.dreamTask = data.task;
    setAutoDreamStatus(data.task);
    if (data.task && !["approved", "rejected", "skipped", "failed"].includes(data.task.status)) {
      monitorAutoDreamTask(data.task.id, true);
    }
  } catch {
    if (state.activeKey === key) setAutoDreamStatus(null);
  }
}

async function resumeAcontextTask(key) {
  try {
    const data = await api(`/api/sessions/${key}/acontext`);
    if (state.activeKey !== key) return;
    state.acontextTask = data.task;
    setAcontextTaskButton(data.task);
    if (data.task && data.task.status !== "completed" && data.task.status !== "failed") {
      monitorAcontextTask(data.task.id, true);
    }
  } catch {
    if (state.activeKey === key) setAcontextTaskButton(null);
  }
}

async function saveRanges(action = "save") {
  if (!state.activeKey) return;
  const selection = selectionFromControls();
  if (!selection) {
    toast("请先在消息下方使用 ◇ 选择蒸馏区间", "error");
    return;
  }
  const run = action !== "save";
  const button = action === "acontext" ? $("#learn-acontext") : action === "refine" ? $("#run-refine") : $("#save-ranges");
  const payload = action === "acontext"
    ? { range: selection.acontext }
    : action === "refine"
      ? { range: selection.refine }
      : { selection };
  if (run) {
    payload.provider = $("#provider-input").value.trim();
    payload.model = $("#model-input").value.trim();
  }
  if (action === "refine") {
    payload.goldPath = $("#refine-gold-path").value.trim();
    payload.activeSkillPath = $("#refine-active-skill-path").value.trim();
    if (!payload.goldPath || !payload.activeSkillPath) {
      toast("请先填写 Gold 文档路径和 Active Skill 路径", "error");
      return;
    }
  }
  setBusy(button, true, action === "acontext" ? "学习中…" : action === "refine" ? "提炼中…" : "保存中…");
  let keepBusy = false;
  try {
    const endpoint = action === "acontext" ? "acontext" : action === "refine" ? "refine" : "ranges";
    const result = await api(`/api/sessions/${state.activeKey}/${endpoint}`, { method: "POST", body: JSON.stringify(payload) });
    if (action === "acontext") {
      keepBusy = true;
      state.acontextTask = result.task;
      setAcontextTaskButton(result.task);
      toast(`Acontext 后台任务已启动：${result.task.id}`, "success", 7000);
      monitorAcontextTask(result.task.id, true);
    }
    else if (action === "refine") {
      toast('Refine 任务已准备；检查 Skill 并确认费用后开始第一轮。', 'success', 9000);
      showView('experts');
      await loadHumanWorkbench({taskId:result.task.id});
    }
    else toast("蒸馏区间已保存到 session");
    if (action === "save") await openSession(state.activeKey);
  } catch (error) {
    toast(error.message, "error", 9000);
  } finally {
    if (!keepBusy) setBusy(button, false);
  }
}

function appendLiveConversation(userText) {
  $("#timeline .empty-list")?.remove();
  $("#timeline").insertAdjacentHTML("beforeend", `
    <article class="chat-message user"><span class="message-avatar">你</span><div class="message-stack"><div class="message-bubble">${escapeHtml(userText)}</div></div></article>
    <article class="chat-message assistant" id="live-assistant"><span class="message-avatar">R</span><div class="message-stack"><div class="message-bubble" id="live-assistant-text">正在思考…</div><div class="tool-traces" id="live-tools"></div></div></article>`);
  $("#session-detail").scrollTop = $("#session-detail").scrollHeight;
}

function updateLiveConversation() {
  if (!state.live) return;
  $("#live-assistant-text").textContent = state.live.text || state.live.status || "正在思考…";
  $("#live-tools").innerHTML = state.live.tools.map((tool) => `<div class="tool-trace ${tool.done ? "" : "live"}"><strong>${escapeHtml(tool.name)}</strong>${tool.error ? " · 失败" : tool.done ? " · 完成" : " · 执行中"}</div>`).join("");
  $("#session-detail").scrollTop = $("#session-detail").scrollHeight;
}

async function sendChat() {
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message || !state.activeKey || state.sending) return;
  state.sending = true;
  state.live = { text: "", status: "正在连接 Coding Agent…", tools: [] };
  input.value = "";
  input.style.height = "auto";
  $("#send-chat").classList.add("hidden");
  $("#stop-chat").classList.remove("hidden");
  appendLiveConversation(message);
  const controller = new AbortController();
  state.chatAbort = controller;
  try {
    const response = await fetch(`/api/sessions/${state.activeKey}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        provider: $("#provider-input").value.trim(),
        model: $("#model-input").value.trim(),
        ...(state.selectedSkill ? { skillKey: state.selectedSkill.key } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `请求失败 (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "start") state.live.status = event.warning || `使用 ${event.model}`;
        else if (event.type === "delta") state.live.text += event.delta;
        else if (event.type === "status") state.live.status = event.message;
        else if (event.type === "tool_start") state.live.tools.push({ id: event.id, name: event.name, done: false, error: false });
        else if (event.type === "tool_end") {
          const tool = state.live.tools.find((item) => item.id === event.id);
          if (tool) { tool.done = true; tool.error = event.isError; }
        } else if (event.type === "error") throw new Error(event.error);
        updateLiveConversation();
      }
      if (done) break;
    }
    state.selectedSkill = null;
    renderSelectedSkill();
    await loadSessions();
    await openSession(state.activeKey, false);
  } catch (error) {
    if (error.name !== "AbortError") toast(error.message, "error", 9000);
    else toast("已停止生成");
    await openSession(state.activeKey, false);
  } finally {
    state.sending = false;
    state.live = null;
    state.chatAbort = null;
    $("#send-chat").classList.remove("hidden");
    $("#stop-chat").classList.add("hidden");
  }
}

function renderSelectedSkill() {
  const badge = $("#selected-skill");
  if (!state.selectedSkill) {
    badge.classList.add("hidden");
    badge.textContent = "";
    return;
  }
  badge.classList.remove("hidden");
  badge.textContent = `Skill: ${state.selectedSkill.name} ×`;
  badge.title = "点击取消本轮 skill 调用";
}

function skillCard(skill) {
  return `<button class="skill-card ${state.activeSkill?.key === skill.key ? "active" : ""}" data-skill-key="${skill.key}" type="button"><strong>${escapeHtml(skill.name)}</strong><span>${escapeHtml(skill.description || "无说明")}</span><small>${skill.files.length} 个可编辑文件</small></button>`;
}

async function loadSkills() {
  const list = $("#skill-list");
  list.innerHTML = '<div class="loading-bar"></div>';
  try {
    const data = await api("/api/skills");
    state.skills = data.skills;
    $("#skill-count").textContent = `${data.skills.length} 个 skill`;
    list.innerHTML = data.skills.length ? data.skills.map(skillCard).join("") : '<div class="empty-list">尚未同步 Acontext skill</div>';
    $$('[data-skill-key]').forEach((button) => button.addEventListener("click", () => void openSkill(button.dataset.skillKey)));
  } catch (error) {
    list.innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
}

async function openSkill(key) {
  const skill = state.skills.find((item) => item.key === key);
  if (!skill) return;
  state.activeSkill = skill;
  $("#skill-empty").classList.add("hidden");
  $("#skill-detail").classList.remove("hidden");
  $("#skill-title").textContent = skill.name;
  $("#skill-description").textContent = skill.description || skill.directory;
  $("#skill-file").innerHTML = skill.files.map((file) => `<option value="${escapeHtml(file.path)}">${escapeHtml(file.path)}</option>`).join("");
  await loadSkillFile();
  await loadSkills();
}

async function loadSkillFile() {
  if (!state.activeSkill) return;
  const file = $("#skill-file").value || "SKILL.md";
  try {
    const data = await api(`/api/skills/${state.activeSkill.key}/file?path=${encodeURIComponent(file)}`);
    state.skillFile = data;
    $("#skill-editor").value = data.content;
    $("#skill-file-meta").textContent = `${data.file} · ${data.sha256.slice(0, 10)}`;
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveSkill() {
  if (!state.activeSkill || !state.skillFile) return;
  const button = $("#save-skill");
  setBusy(button, true, "保存中…");
  try {
    const result = await api(`/api/skills/${state.activeSkill.key}/file?path=${encodeURIComponent(state.skillFile.file)}`, {
      method: "PUT",
      body: JSON.stringify({ content: $("#skill-editor").value, expectedSha256: state.skillFile.sha256 }),
    });
    state.skillFile.sha256 = result.sha256;
    $("#skill-file-meta").textContent = `${state.skillFile.file} · ${result.sha256.slice(0, 10)}`;
    toast("Skill 修改已保存");
  } catch (error) {
    toast(error.message, "error", 8000);
  } finally {
    setBusy(button, false);
  }
}

function pluginCard(plugin) {
  return `<article class="plugin-card">
    <div class="plugin-card-head">
      <span class="plugin-symbol">P</span>
      <span class="plugin-card-title"><strong>${escapeHtml(plugin.name)}</strong><small>${plugin.version ? `v${escapeHtml(plugin.version)} · ` : ""}${plugin.scope === "project" ? "当前项目" : "所有项目"}</small></span>
      <span class="plugin-status ${plugin.installed ? "" : "missing"}">${plugin.installed ? "已安装" : "待恢复"}</span>
    </div>
    <div class="plugin-source" title="${escapeHtml(plugin.source)}">${escapeHtml(plugin.source)}</div>
    <div class="plugin-actions">
      <button class="secondary-button" data-plugin-update="${escapeHtml(plugin.source)}" data-scope="${plugin.scope}" type="button">更新</button>
      <button class="danger-button" data-plugin-remove="${escapeHtml(plugin.source)}" data-scope="${plugin.scope}" type="button">移除</button>
    </div>
  </article>`;
}

async function loadPlugins() {
  const list = $("#plugin-list");
  list.innerHTML = '<div class="loading-bar"></div>';
  try {
    const data = await api("/api/plugins");
    list.innerHTML = data.packages.length ? data.packages.map(pluginCard).join("") : '<div class="empty-list panel">尚未安装 Agent package</div>';
    $("#local-extension-list").innerHTML = data.localExtensions.length
      ? data.localExtensions.map((item) => `<div class="local-extension"><span>${escapeHtml(item.path)}</span><span>${item.scope === "project" ? "当前项目" : "所有项目"}</span></div>`).join("")
      : '<div class="empty-list">没有单独配置的 extension 路径</div>';
    $$('[data-plugin-update]').forEach((button) => button.addEventListener("click", () => void mutatePlugin("update", button.dataset.pluginUpdate, button.dataset.scope, button)));
    $$('[data-plugin-remove]').forEach((button) => button.addEventListener("click", () => void mutatePlugin("remove", button.dataset.pluginRemove, button.dataset.scope, button)));
  } catch (error) {
    list.innerHTML = `<div class="empty-list panel">${escapeHtml(error.message)}</div>`;
  }
}

async function mutatePlugin(action, source, scope, button) {
  if (action === "remove" && !window.confirm(`确认移除 ${source}？`)) return;
  setBusy(button, true, action === "update" ? "更新中…" : "移除中…");
  try {
    await api(`/api/plugins/${action}`, { method: "POST", body: JSON.stringify({ source, scope }) });
    toast(action === "update" ? "插件已更新" : "插件已移除");
    await loadPlugins();
  } catch (error) {
    toast(error.message, "error", 7000);
    setBusy(button, false);
  }
}

async function installPlugin(event) {
  event.preventDefault();
  const source = $("#plugin-source").value.trim();
  const scope = $("#plugin-scope").value;
  const button = event.submitter;
  setBusy(button, true, "安装中…");
  try {
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ source, scope }) });
    $("#plugin-source").value = "";
    $("#install-form").classList.add("hidden");
    toast("插件已安装");
    await loadPlugins();
  } catch (error) {
    toast(error.message, "error", 7000);
  } finally {
    setBusy(button, false);
  }
}

async function refreshCurrent() {
  const button = $("#refresh-button");
  setBusy(button, true, "…");
  try {
    await loadStatus();
    if (state.view === "plugins") await loadPlugins();
    else if (state.view === "skills") await loadSkills();
    else if (state.view === "experts") await loadHumanWorkbench();
    else if (state.view === "history") await loadExpertWorkbench({ force: true });
    else {
      await loadSessions();
      if (state.activeKey) await openSession(state.activeKey, false);
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#refresh-button").addEventListener("click", () => void refreshCurrent());
  $("#new-session").addEventListener("click", () => void createNewSession());
  $("#empty-new-session").addEventListener("click", () => void createNewSession());
  $("#scope-all").addEventListener("change", () => void loadSessions());
  $("#session-search").addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => void loadSessions(), 250);
  });
  ["#acontext-start", "#acontext-end", "#refine-start", "#refine-end"].forEach((selector) => $(selector).addEventListener("change", () => { updateRangeSummary(); renderTimeline(); }));
  $("#auto-range").addEventListener("click", () => {
    if (!state.detail?.automatic) return toast("发送消息后才能自动识别区间", "error");
    applySelection(state.detail.automatic.selection);
    toast("已应用自动识别区间，保存后写入 session");
  });
  $("#save-ranges").addEventListener("click", () => void saveRanges("save"));
  $("#learn-acontext").addEventListener("click", () => void saveRanges("acontext"));
  $("#run-refine").addEventListener("click", () => void saveRanges("refine"));
  $("#send-chat").addEventListener("click", () => void sendChat());
  $("#stop-chat").addEventListener("click", () => state.chatAbort?.abort());
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendChat(); }
  });
  $("#chat-input").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
  });
  ["#provider-input", "#model-input"].forEach((selector) => $(selector).addEventListener("input", (event) => { event.target.dataset.edited = "true"; }));
  $("#show-install").addEventListener("click", () => $("#install-form").classList.remove("hidden"));
  $("#cancel-install").addEventListener("click", () => $("#install-form").classList.add("hidden"));
  $("#install-form").addEventListener("submit", installPlugin);
  $("#open-skills-window").addEventListener("click", () => window.open(`${window.location.origin}/#skills`, "skill-workbench", "popup,width=1180,height=820"));
  $("#skill-file").addEventListener("change", () => void loadSkillFile());
  $("#save-skill").addEventListener("click", () => void saveSkill());
  $("#invoke-skill").addEventListener("click", () => {
    if (!state.activeSkill) return;
    state.selectedSkill = { key: state.activeSkill.key, name: state.activeSkill.name };
    renderSelectedSkill();
    showView("sessions");
    toast(`下一条消息将显式调用 ${state.activeSkill.name}`);
    $("#chat-input").focus();
  });
  $("#selected-skill").addEventListener("click", () => { state.selectedSkill = null; renderSelectedSkill(); });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-marker]") && !event.target.closest(".endpoint-menu")) $$(".endpoint-menu").forEach((menu) => menu.remove());
  });
}

async function init() {
  bindEvents();
  showView(["sessions", "plugins", "skills", "experts", "history"].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "experts");
  try {
    await Promise.all([loadStatus(), loadSessions()]);
  } catch (error) {
    toast(error.message, "error", 7000);
  }
}

void init();
