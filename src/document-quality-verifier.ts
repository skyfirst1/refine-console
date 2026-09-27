export const QUALITY_CRITERIA = [
  "事实准确性",
  "方案完整性",
  "结构清晰度",
  "语言简洁度",
  "可操作性",
  "边界意识",
] as const;

export type QualityCriterion = (typeof QUALITY_CRITERIA)[number];
export type CandidateName = "baseline" | "memory";
export type BlindLabel = "A" | "B";

export interface HardCheckResult {
  id: string;
  passed: boolean;
  reason: string;
  evidence: string;
}

export interface JudgeDocumentResult {
  hard_checks: HardCheckResult[];
  scores: Record<QualityCriterion, number>;
  factual_errors: string[];
  summary: string;
}

export interface JudgeResult {
  documents: Record<BlindLabel, JudgeDocumentResult>;
  winner: BlindLabel | "tie";
  reason: string;
}

export interface MappedJudgeRound {
  labels: Record<BlindLabel, CandidateName>;
  result: JudgeResult;
  usage?: Record<string, unknown>;
}

export interface CandidateAggregate {
  hardPass: boolean;
  totalScore: number;
  scores: Record<QualityCriterion, number>;
  factualErrors: string[];
}

export interface DocumentComparison {
  verdict: "improved" | "regressed" | "inconclusive";
  reason: string;
  scoreDelta: number;
  baseline: CandidateAggregate;
  memory: CandidateAggregate;
  rounds: MappedJudgeRound[];
  scope: "single_task_pair";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object from the judge");
  }
  return value as Record<string, unknown>;
}

function parseDocument(value: unknown, label: BlindLabel): JudgeDocumentResult {
  const source = object(value);
  const rawScores = object(source.scores);
  const scores = {} as Record<QualityCriterion, number>;
  for (const criterion of QUALITY_CRITERIA) {
    const score = rawScores[criterion];
    if (typeof score !== "number" || score < 1 || score > 5) {
      throw new Error(`Judge score for ${label}/${criterion} must be between 1 and 5`);
    }
    scores[criterion] = score;
  }
  if (!Array.isArray(source.hard_checks) || !Array.isArray(source.factual_errors)) {
    throw new Error(`Judge result for ${label} is missing hard_checks or factual_errors`);
  }
  const hardChecks = source.hard_checks.map((value) => {
    const item = object(value);
    if (typeof item.id !== "string" || typeof item.passed !== "boolean") {
      throw new Error(`Invalid hard check for ${label}`);
    }
    return {
      id: item.id,
      passed: item.passed,
      reason: typeof item.reason === "string" ? item.reason : "",
      evidence: typeof item.evidence === "string" ? item.evidence : "",
    };
  });
  return {
    hard_checks: hardChecks,
    scores,
    factual_errors: source.factual_errors.map(String),
    summary: typeof source.summary === "string" ? source.summary : "",
  };
}

export function parseJudgeJson(content: string): JudgeResult {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const source = object(JSON.parse(cleaned));
  const documents = object(source.documents);
  const winner = source.winner;
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    throw new Error("Judge winner must be A, B, or tie");
  }
  return {
    documents: {
      A: parseDocument(documents.A, "A"),
      B: parseDocument(documents.B, "B"),
    },
    winner,
    reason: typeof source.reason === "string" ? source.reason : "",
  };
}

function aggregate(rounds: MappedJudgeRound[], candidate: CandidateName): CandidateAggregate {
  const documents = rounds.map((round) => {
    const label = round.labels.A === candidate ? "A" : "B";
    return round.result.documents[label];
  });
  const scores = {} as Record<QualityCriterion, number>;
  for (const criterion of QUALITY_CRITERIA) {
    scores[criterion] = documents.reduce((sum, document) => sum + document.scores[criterion], 0) / documents.length;
  }
  return {
    hardPass: documents.every((document) => document.hard_checks.every((check) => check.passed)),
    totalScore: QUALITY_CRITERIA.reduce((sum, criterion) => sum + scores[criterion], 0),
    scores,
    factualErrors: [...new Set(documents.flatMap((document) => document.factual_errors))],
  };
}

export function compareJudgeRounds(rounds: MappedJudgeRound[], minDelta = 1): DocumentComparison {
  if (rounds.length < 2) throw new Error("At least two label-swapped judge rounds are required");
  if (!Number.isFinite(minDelta) || minDelta < 0) throw new Error("minDelta must be non-negative");
  const baseline = aggregate(rounds, "baseline");
  const memory = aggregate(rounds, "memory");
  const scoreDelta = memory.totalScore - baseline.totalScore;
  const factualRegression = memory.scores["事实准确性"] < baseline.scores["事实准确性"];

  let verdict: DocumentComparison["verdict"] = "inconclusive";
  let reason = `Memory score delta ${scoreDelta.toFixed(2)} is below the improvement threshold ${minDelta.toFixed(2)}.`;
  if ((!memory.hardPass && baseline.hardPass) || factualRegression) {
    verdict = "regressed";
    reason = !memory.hardPass && baseline.hardPass
      ? "The memory document introduced a hard-check regression."
      : "The memory document reduced factual accuracy.";
  } else if (memory.hardPass && !factualRegression && scoreDelta >= minDelta) {
    verdict = "improved";
    reason = `The memory document passed all hard checks and improved the aggregate score by ${scoreDelta.toFixed(2)}.`;
  }

  return { verdict, reason, scoreDelta, baseline, memory, rounds, scope: "single_task_pair" };
}
