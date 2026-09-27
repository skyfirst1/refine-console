/** Historical import compatibility only. New code uses agent-task-runner. */
import {runAgentTask, type AgentTaskOptions} from './agent-task-runner.js';
export * from './agent-task-runner.js';
export async function runPiTask(options:AgentTaskOptions) {
  try {return await runAgentTask(options);}
  catch(error) {
    if(error instanceof Error && error.message.startsWith('Agent '))throw new Error(error.message.replace(/^Agent /,'Pi '),{cause:error});
    throw error;
  }
}
export {
  parseAgentTaskEvents as parsePiTaskEvents,
  runtimeCliPath as piCliPath,
  agentTaskExtensionPaths as piTaskExtensionPaths,
  agentTaskResourceIsolationArgs as piTaskResourceIsolationArgs,
  projectPublicAgentEvents as projectPublicPiEvents,
  agentEventProvenance as piEventProvenance,
  readAgentEventProvenance as readPiEventProvenance,
  agentTaskThinkingLevel as piTaskThinkingLevel,
  agentTaskMaxOutputTokens as piTaskMaxOutputTokens,
  agentTaskToolArgs as piTaskToolArgs,
  verifyInlineAgentTaskDelivery as verifyInlinePiTaskDelivery,
  existingAgentTaskSessionPath as existingPiTaskSessionPath,
  agentTaskCommandLineBound as piTaskCommandLineBound,
  agentTaskPromptTransportArgs as piTaskPromptTransportArgs,
} from './agent-task-runner.js';
export type {
  AgentTaskOptions as PiTaskOptions,
  AgentTaskResult as PiTaskResult,
  AgentTaskUsage as PiTaskUsage,
  AgentEventProvenance as PiEventProvenance,
} from './agent-task-runner.js';
