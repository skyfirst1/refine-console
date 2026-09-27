import type { AcontextGateway } from "./contracts.js";

// Matches Acontext's upstream ProjectConfig default. When the SDK exposes the
// project config endpoint, prefer the live value so replay follows the server.
export const ACONTEXT_DEFAULT_BUFFER_MAX_TURNS = 16;

export async function resolveAcontextReplayChunkSize(client: AcontextGateway): Promise<number> {
  const configs = client.project ? await client.project.getConfigs() : undefined;
  const configured = configs?.project_session_message_buffer_max_turns;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : ACONTEXT_DEFAULT_BUFFER_MAX_TURNS;
}
