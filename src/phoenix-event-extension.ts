import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPhoenixAgentEventTracing } from "./phoenix-tracing.js";

/** Isolated Agent tasks load this extension to expose their real AgentSession events. */
export default function phoenixEventExtension(runtime: ExtensionAPI): void {
  registerPhoenixAgentEventTracing(runtime);
}
