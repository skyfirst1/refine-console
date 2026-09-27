import assert from "node:assert/strict";
import test from "node:test";
import {
  compareJudgeRounds,
  parseJudgeJson,
  QUALITY_CRITERIA,
  type BlindLabel,
  type CandidateName,
  type JudgeResult,
  type MappedJudgeRound,
} from "../src/document-quality-verifier.js";

function result(aScore: number, bScore: number, aHard = true, bHard = true): JudgeResult {
  const document = (score: number, hard: boolean) => ({
    hard_checks: [{ id: "required", passed: hard, reason: "fixture", evidence: "fixture" }],
    scores: Object.fromEntries(QUALITY_CRITERIA.map((criterion) => [criterion, score])) as Record<(typeof QUALITY_CRITERIA)[number], number>,
    factual_errors: [],
    summary: "fixture",
  });
  return { documents: { A: document(aScore, aHard), B: document(bScore, bHard) }, winner: aScore > bScore ? "A" : aScore < bScore ? "B" : "tie", reason: "fixture" };
}

function round(labels: Record<BlindLabel, CandidateName>, judgeResult: JudgeResult): MappedJudgeRound {
  return { labels, result: judgeResult };
}

test("parses fenced judge JSON", () => {
  const value = result(4, 3);
  assert.deepEqual(parseJudgeJson(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), value);
});

test("reports improvement across label-swapped rounds", () => {
  const comparison = compareJudgeRounds([
    round({ A: "baseline", B: "memory" }, result(3, 4)),
    round({ A: "memory", B: "baseline" }, result(4, 3)),
  ]);
  assert.equal(comparison.verdict, "improved");
  assert.equal(comparison.scoreDelta, 6);
});

test("reports a hard-check regression", () => {
  const comparison = compareJudgeRounds([
    round({ A: "baseline", B: "memory" }, result(4, 5, true, false)),
    round({ A: "memory", B: "baseline" }, result(5, 4, false, true)),
  ]);
  assert.equal(comparison.verdict, "regressed");
});
