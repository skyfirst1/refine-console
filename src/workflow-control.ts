/** Control-plane interruption, never model repair feedback. Request status is explicit. */
export class WorkflowControlError extends Error {
  readonly name = "WorkflowControlError";
  expertCalls?: unknown[];
  workflowStageRecord?: unknown;
  constructor(readonly reason: "pause" | "budget" | "source" | "accounting", message: string, readonly providerStarted = false) { super(message); }
}
export interface UnsentAttemptIdentity { stage: string; attempt: number; eventsPath: string }
export interface ResumeControlEvidence { path: string; sha256: string }
