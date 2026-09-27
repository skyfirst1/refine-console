import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveRefineHarnessProfile,
  validateRefineHarnessProfile,
  type RefineHarnessProfile,
} from "../src/refine-harness-profile.js";

function validProfile(): RefineHarnessProfile {
  return {
    profileId: "technical-report-style-v1",
    version: "v1",
    taskFamily: "technical_research_report",
    taskConditions: ["The document compares multiple tools under shared categories."],
    negativeControls: ["Do not optimize factual recall from Gold-only details."],
    sourceRun: "validation/run-1",
    evidenceSummary: "The Reviewer repeatedly treated shared boilerplate as item-specific positioning.",
    roleOverlays: [{
      roleId: "refine.review",
      sourceProposalId: "proposal-review-1",
      surface: "prompt",
      capabilityGap: "Per-item differentiation is missed after a correct category summary.",
      expectedBehavior: "Inspect whether each listed item performs a distinct document function without inventing facts.",
      activationCondition: "The Description requests a multi-item technical comparison.",
      evidenceRefs: ["event:review:L12", "artifact:review.json#gap-2"],
      revisionTrajectory: {
        initialObservation: "The first review treated shared boilerplate as sufficient.",
        selfCorrection: "The revision noticed the category summary but did not inspect item roles.",
        residualFailure: "Item-level content-style differentiation remained absent from the final review.",
      },
      instruction: "Check item-level differentiation after validating the category summary without inventing facts.",
    }],
  };
}

test("validates a generic task-family append-only profile", () => {
  assert.deepEqual(validateRefineHarnessProfile(validProfile()), validProfile());
});

test("resolver exposes append instructions only for an exact task-family match", () => {
  const profile = validateRefineHarnessProfile(validProfile());
  assert.equal(resolveRefineHarnessProfile(profile, "resume_project_entry"), null);
  const resolved = resolveRefineHarnessProfile(profile, "technical_research_report");
  assert.equal(resolved?.roles[0]?.roleId, "refine.review");
  assert.equal(resolved?.roles[0]?.surface, "prompt");
  assert.match(resolved?.roles[0]?.instruction ?? "", /item-level differentiation/);
});

test("rejects non-evolvable roles and full Prompt replacement fields", () => {
  const expert = validProfile() as unknown as Record<string, unknown>;
  (expert.roleOverlays as Array<Record<string, unknown>>)[0]!.roleId = "refine.expert-reducer";
  assert.throws(() => validateRefineHarnessProfile(expert), /not evolvable/);

  const replacement = validProfile() as unknown as Record<string, unknown>;
  (replacement.roleOverlays as Array<Record<string, unknown>>)[0]!.systemPrompt = "replace the entire prompt";
  assert.throws(() => validateRefineHarnessProfile(replacement), /unsupported fields/);
});

test("isolates one role/surface and rejects missing evidence or instruction", () => {
  const duplicate = validProfile();
  duplicate.roleOverlays.push({ ...duplicate.roleOverlays[0]!, evidenceRefs: ["event:review:L20"] });
  assert.throws(() => validateRefineHarnessProfile(duplicate), /exactly one role/);

  const noEvidence = validProfile();
  noEvidence.roleOverlays[0]!.evidenceRefs = [];
  assert.throws(() => validateRefineHarnessProfile(noEvidence), /must not be empty/);

  const empty = validProfile();
  empty.roleOverlays[0]!.instruction = "";
  assert.throws(() => validateRefineHarnessProfile(empty), /instruction must be a non-empty string/);

  const noConditions = validProfile();
  noConditions.taskConditions = [];
  assert.throws(() => validateRefineHarnessProfile(noConditions), /taskConditions must not be empty/);

  const noNegative = validProfile();
  noNegative.negativeControls = [];
  assert.throws(() => validateRefineHarnessProfile(noNegative), /negativeControls must not be empty/);
});
