import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AcontextGateway } from "../src/contracts.js";
import {
  inferProductionRangeSelection,
  startWebDashboard,
} from "../src/web-dashboard.js";

function message(id: string, parentId: string | null, role: "user" | "assistant", content: string): SessionEntry {
  if (role === "user") {
    return { type: "message", id, parentId, timestamp: "2026-08-25T00:00:00.000Z", message: { role, content, timestamp: 0 } };
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-25T00:00:00.000Z",
    message: {
      role,
      content: [{ type: "text", text: content }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

test("automatic range falls back to the meaningful conversation when no artifacts exist", async () => {
  const branch = [message("u1", null, "user", "写一份报告"), message("a1", "u1", "assistant", "完成")];
  const result = await inferProductionRangeSelection(branch, process.cwd());
  assert.equal(result.artifacts, null);
  assert.deepEqual(result.selection.acontext, { startEntryId: "u1", endEntryId: "a1" });
  assert.deepEqual(result.selection.refine, result.selection.acontext);
});

test("dashboard serves the local frontend and an empty session list", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const dashboard = await startWebDashboard({ cwd: root, sessionDir: sessions, port: 0 });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Refine Console/);
    assert.doesNotMatch(pageHtml, /长文档专注模式/);
    const response = await fetch(`${dashboard.url}/api/sessions`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { sessions: unknown[] }).sessions, []);

    const createResponse = await fetch(`${dashboard.url}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { session: { key: string } };
    const detailResponse = await fetch(`${dashboard.url}/api/sessions/${created.session.key}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { entries: unknown[]; selection: unknown };
    assert.equal(detail.entries.length, 1);
    assert.equal(detail.selection, null);
    const dreamStatus = await fetch(`${dashboard.url}/api/sessions/${created.session.key}/dream`);
    assert.equal(dreamStatus.status, 200);
    assert.deepEqual(await dreamStatus.json(), { task: null });
    const prematureDream = await fetch(`${dashboard.url}/api/sessions/${created.session.key}/dream`, { method: "POST", body: "{}" });
    assert.equal(prematureDream.status, 409);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard exposes Codex history and projects it into a readable Agent session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-codex-"));
  const sessions = join(root, "pi-sessions");
  const codex = join(root, "codex-sessions");
  await Promise.all([mkdir(sessions), mkdir(codex)]);
  await writeFile(join(root, "session_index.jsonl"), `${JSON.stringify({
    id: "11111111-1111-1111-1111-111111111111",
    thread_name: "检查实际项目",
  })}\n`, "utf8");
  const rollout = join(codex, "rollout-11111111-1111-1111-1111-111111111111.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-25T01:00:00.000Z", type: "session_meta", payload: { id: "11111111-1111-1111-1111-111111111111", cwd: root } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "检查项目" } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "检查完成" } }),
  ].join("\n"), "utf8");
  const dashboard = await startWebDashboard({ cwd: root, sessionDir: sessions, codexSessionRoot: codex, port: 0 });
  try {
    const historyResponse = await fetch(`${dashboard.url}/api/codex-sessions`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { sessions: Array<{ key: string; name: string }> };
    assert.equal(history.sessions.length, 1);
    assert.equal(history.sessions[0]?.name, "检查实际项目");
    const projectResponse = await fetch(`${dashboard.url}/api/codex-sessions/${history.sessions[0]!.key}/project`, { method: "POST", body: "{}" });
    assert.equal(projectResponse.status, 201);
    const projected = await projectResponse.json() as { session: { key: string; name: string } };
    assert.equal(projected.session.name, "检查实际项目");
    const detailResponse = await fetch(`${dashboard.url}/api/sessions/${projected.session.key}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { entries: Array<{ text: string }> };
    assert.ok(detail.entries.some((entry) => entry.text.includes("检查项目")));
    assert.ok(detail.entries.some((entry) => entry.text.includes("检查完成")));
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard Refine endpoint invokes the fixed Workflow with a frozen selected-range trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-refine-workflow-"));
  const sessions = join(root, "pi-sessions");
  const codex = join(root, "codex-sessions");
  await Promise.all([mkdir(sessions), mkdir(codex)]);
  const goldPath = join(root, "gold.md");
  const activeSkillPath = join(root, "active-skill.md");
  await Promise.all([
    writeFile(goldPath, "# Gold\n\nReference document.\n", "utf8"),
    writeFile(activeSkillPath, "---\nname: active\ndescription: active skill\n---\n\n# Active Skill\n", "utf8"),
  ]);
  const rollout = join(codex, "rollout-33333333-3333-3333-3333-333333333333.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-25T01:00:00.000Z", type: "session_meta", payload: { id: "33333333-3333-3333-3333-333333333333", cwd: root } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "生成候选文档" } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "候选文档已生成" } }),
  ].join("\n"), "utf8");

  let captured: Parameters<NonNullable<Parameters<typeof startWebDashboard>[0]["refineWorkflowRunner"]>>[0] | undefined;
  const dashboard = await startWebDashboard({
    cwd: root,
    sessionDir: sessions,
    codexSessionRoot: codex,
    port: 0,
    refineWorkflowRunner: async (options) => {
      captured = options;
      const runDirectory = join(root, "fake-refine-workflow-run");
      return {
        runId: "workflow-run",
        runDirectory,
        manifestPath: join(runDirectory, "manifest.json"),
        status: "completed-demo",
        descriptionPath: join(runDirectory, "description.md"),
        draftPath: join(runDirectory, "draft.md"),
        stageArtifacts: {
          descriptionPath: join(runDirectory, "description.md"),
          draftPath: join(runDirectory, "draft.md"),
        },
      };
    },
  });
  try {
    const history = await (await fetch(`${dashboard.url}/api/codex-sessions`)).json() as { sessions: Array<{ key: string }> };
    const projected = await (await fetch(`${dashboard.url}/api/codex-sessions/${history.sessions[0]!.key}/project`, { method: "POST", body: "{}" })).json() as { session: { key: string } };
    const detail = await (await fetch(`${dashboard.url}/api/sessions/${projected.session.key}`)).json() as { entries: Array<{ id: string; type: string }> };
    const messages = detail.entries.filter((entry) => entry.type === "message");
    const missingContract = await fetch(`${dashboard.url}/api/sessions/${projected.session.key}/refine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: { startEntryId: messages[0]!.id, endEntryId: messages.at(-1)!.id }, provider: "test", model: "test" }),
    });
    assert.equal(missingContract.status, 422);
    const response = await fetch(`${dashboard.url}/api/sessions/${projected.session.key}/refine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        range: { startEntryId: messages[0]!.id, endEntryId: messages.at(-1)!.id },
        provider: "test",
        model: "test",
        goldPath,
        activeSkillPath,
      }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { task: {id:string;version:number;status:string}; dreamTask: unknown };
    assert.equal(body.task.status, "ready");
    assert.equal(body.dreamTask, null);
    assert.equal(Boolean(captured), false);
    const denied = await fetch(`${dashboard.url}/api/workflows/${body.task.id}/continue`, {method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.example'},body:JSON.stringify({version:body.task.version,confirm:true})});
    assert.equal(denied.status,403);
    const started = await fetch(`${dashboard.url}/api/workflows/${body.task.id}/continue`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:body.task.version,confirm:true})});
    assert.equal(started.status,202);
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(captured);
    assert.equal(captured.executionMode, undefined);
    assert.notEqual(captured.goldPath, goldPath);
    assert.notEqual(captured.activeSkillPath, activeSkillPath);
    assert.equal(await readFile(captured.activeSkillPath,'utf8'),await readFile(activeSkillPath,'utf8'));
    assert.equal("reviewAdapter" in captured, false);
    const frozen = JSON.parse(await readFile(captured.requirementsPath, "utf8")) as { source: string; entries: unknown[] };
    assert.equal(frozen.source, "pi-web-refine-range");
    assert.equal(frozen.entries.length, messages.length);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard starts Acontext learning in the background and exposes recoverable task status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dashboard-acontext-task-"));
  const sessions = join(root, "pi-sessions");
  const codex = join(root, "codex-sessions");
  await Promise.all([mkdir(sessions), mkdir(codex)]);
  const rollout = join(codex, "rollout-22222222-2222-2222-2222-222222222222.jsonl");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-25T01:00:00.000Z", type: "session_meta", payload: { id: "22222222-2222-2222-2222-222222222222", cwd: root } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "记住这项偏好" } }),
    JSON.stringify({ timestamp: "2026-08-25T01:00:02.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "已记住" } }),
  ].join("\n"), "utf8");

  let finishLearning!: () => void;
  const learningGate = new Promise<void>((resolve) => { finishLearning = resolve; });
  const client: AcontextGateway = {
    async ping() { return "pong"; },
    sessions: {
      async create() { return { id: "background-session" }; },
      async storeMessage() {},
      async flush() {},
      async copy() { return { old_session_id: "old", new_session_id: "new" }; },
    },
    learningSpaces: {
      async create() { return { id: "background-space" }; },
      async learn() { return { status: "pending" }; },
      async waitForLearning() { await learningGate; return { status: "completed" }; },
      async listSkills() { return []; },
    },
    skills: {
      async getFile() { throw new Error("not used"); },
    },
  };
  const dashboard = await startWebDashboard({
    cwd: root,
    sessionDir: sessions,
    codexSessionRoot: codex,
    port: 0,
    acontextClientFactory: () => client,
    acontextSkillCacheDir: join(root, "skill-cache"),
  });
  try {
    const history = await (await fetch(`${dashboard.url}/api/codex-sessions`)).json() as { sessions: Array<{ key: string }> };
    const projected = await (await fetch(`${dashboard.url}/api/codex-sessions/${history.sessions[0]!.key}/project`, { method: "POST", body: "{}" })).json() as { session: { key: string } };
    const detail = await (await fetch(`${dashboard.url}/api/sessions/${projected.session.key}`)).json() as { entries: Array<{ id: string; type: string }> };
    const messages = detail.entries.filter((entry) => entry.type === "message");
    const response = await Promise.race([
      fetch(`${dashboard.url}/api/sessions/${projected.session.key}/acontext`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ range: { startEntryId: messages[0]!.id, endEntryId: messages.at(-1)!.id } }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Acontext POST did not return while background learning was pending")), 1_000)),
    ]);
    assert.equal(response.status, 202);
    const accepted = await response.json() as { task: { id: string; status: string } };
    assert.ok(accepted.task.id);
    assert.ok(["queued", "preparing", "replaying", "learning"].includes(accepted.task.status));

    const latest = await (await fetch(`${dashboard.url}/api/sessions/${projected.session.key}/acontext`)).json() as { task: { id: string; status: string } };
    assert.equal(latest.task.id, accepted.task.id);
    assert.ok(["queued", "preparing", "replaying", "learning"].includes(latest.task.status));
    const byId = await (await fetch(`${dashboard.url}/api/acontext-tasks/${accepted.task.id}`)).json() as { task: { id: string } };
    assert.equal(byId.task.id, accepted.task.id);

    finishLearning();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await (await fetch(`${dashboard.url}/api/acontext-tasks/${accepted.task.id}`)).json() as { task: { status: string } };
      if (status.task.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const terminal = await (await fetch(`${dashboard.url}/api/acontext-tasks/${accepted.task.id}`)).json() as { task: { status: string; error?: string } };
    assert.equal(terminal.task.status, "failed");
    assert.match(terminal.task.error ?? "", /no downloadable root SKILL\.md/i);
  } finally {
    finishLearning();
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});
