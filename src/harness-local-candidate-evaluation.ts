import { mkdir } from "node:fs/promises";
import { runEvidenceAlignmentMode, type AtomicAspect, type AspectSet, type RefineExpertEvaluationOptions } from "./refine-expert-pipeline.js";
import { refineExpertCard } from "./refine-expert-cards.js";
import { validateRefineHarnessProfile } from "./refine-harness-profile.js";
import { runHarnessFindingRevision, type HarnessFindingRevisionInput } from "./harness-finding-revision.js";

export interface LocalAlignerCardCandidate {
  roleId: "refine.evidence-aligner";
  surface: "agent_card";
  currentText: string;
  proposedText: string;
}

/** Execute one actual local Expert call. Caller owns paired ordering, checkpoint and provider budget. */
export async function runLocalAlignerCandidate(
  pair: {direction:"recall"|"precision";sourceAspect:AtomicAspect;targetAspect:AtomicAspect;matchRationale:string},
  candidate: LocalAlignerCardCandidate | null,
  options: RefineExpertEvaluationOptions,
) {
  const card=refineExpertCard("refine.evidence-aligner");
  let harnessProfile=undefined;
  if(candidate){
    if(candidate.roleId!==card.roleId||candidate.surface!=="agent_card"||!card.systemPrompt.includes(candidate.currentText)||!candidate.proposedText.startsWith(candidate.currentText))throw new Error("Local Card candidate must be a bound append-only change");
    const instruction=candidate.proposedText.slice(candidate.currentText.length).trim();if(!instruction)throw new Error("Empty Card increment");
    harnessProfile=validateRefineHarnessProfile({profileId:"local-aligner-candidate",version:"1",taskFamily:"local-style-trial",taskConditions:["Local style-mode evidence-pair trial only"],negativeControls:["No content-mode or other-role activation"],sourceRun:options.runId,evidenceSummary:"Frozen public candidate; effectiveness untested",roleOverlays:[{roleId:card.roleId,sourceProposalId:"frozen-card-candidate",surface:"agent_card",capabilityGap:"Public decision/rationale inconsistency",expectedBehavior:"Test the supplied operational increment without assuming a correct Boolean",activationCondition:"style local trial",evidenceRefs:["frozen public candidate"],revisionTrajectory:{initialObservation:"Candidate based on public role output",selfCorrection:"No candidate rewrite in this trial",residualFailure:"Effectiveness and regressions remain unknown"},instruction}]});
  }
  const set=(aspect:AtomicAspect):AspectSet=>({sourceSha256:"local-frozen-pair",descriptionSha256:"local-frozen-task",aspects:[aspect]});
  const gold=set(pair.direction==="recall"?pair.sourceAspect:pair.targetAspect),document=set(pair.direction==="recall"?pair.targetAspect:pair.sourceAspect);
  await mkdir(options.runDirectory,{recursive:true});
  const {harnessProfile: _priorProfile, ...baseOptions}=options;
  return runEvidenceAlignmentMode({...baseOptions,taskType:"local-style-trial",...(harnessProfile?{harnessProfile}:{}),maxCorrections:0}, {direction:pair.direction,sourceAspectId:pair.sourceAspect.id,targetAspectId:pair.targetAspect.id,matched:true,rationale:pair.matchRationale},gold,document,options.runDirectory,0,"style");
}

/** One feedback session over frozen real executions, without automatically applying or rerunning its proposal. */
export async function runLocalCandidateFeedback(
  input: HarnessFindingRevisionInput,
  feedback: unknown,
  options: Parameters<typeof runHarnessFindingRevision>[1],
  runner?: Parameters<typeof runHarnessFindingRevision>[2],
) {
  return runHarnessFindingRevision({...input,publicEvidence:{originalPublicEvidence:input.publicEvidence,executionFeedback:feedback,feedbackTask:"Review the frozen candidate using the actual current-versus-candidate local executions below. Retain, narrow or abandon it, separating changed behavior from evidence of benefit and from protocol status. Current outputs, not historical outputs, are the baseline. Both arms succeeding does not establish added benefit. A non-reproduced historical failure is a valid observation. At most propose one successor candidate; do not execute it. No private test labels are supplied."}},options,runner);
}
