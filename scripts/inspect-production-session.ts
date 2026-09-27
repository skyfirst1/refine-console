import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverGeneratedArtifacts } from "../src/artifact-discovery.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { session: { type: "string", short: "s" } },
});
const sessionPath = values.session ?? positionals[0];
if (!sessionPath) throw new Error("Usage: tsx scripts/inspect-production-session.ts --session <pi-session.jsonl>");

const manager = SessionManager.open(sessionPath, dirname(sessionPath));
const branch = manager.getBranch();
const artifacts = await discoverGeneratedArtifacts(branch, manager.getCwd());
process.stdout.write(`${JSON.stringify({
  sessionId: manager.getSessionId(),
  sessionName: manager.getSessionName(),
  entries: branch.length,
  contextMessages: manager.buildSessionContext().messages.length,
  artifacts,
}, null, 2)}\n`);
