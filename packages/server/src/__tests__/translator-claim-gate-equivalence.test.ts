import { describe, expect, it } from "vitest";
import {
  createTranslatorService,
  type ModelRunRequest,
  type ModelRunResult,
  type TranslationResult,
  type TranslatorModelRunner,
} from "../translator-service.js";
import type { TranslationSelectionEvidence } from "../translator-selection.js";

const SOURCE = "The exact-fetch packet-transfer remains blocked because Lane refused deployment, and no approvals exist.";
const EXPLAIN = "The exact-fetch packet transfer remains blocked because Lane refused deployment, and no approvals exist.";
const REVOICE = "Lane rejected the launch. Nobody approved it, so the work remains blocked.";
const REWRITE_IDENTITY = { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" };
const CLAIM_IDENTITY = { provider: "github-copilot", model: "gemini-3.5-flash" };
const CLAIMS = {
  claims: [
    { id: "c1", category: "actor-attribution", question: "Who rejected deployment?", answer: "Lane rejected deployment" },
    { id: "c2", category: "decision", question: "What deployment decision was made?", answer: "deployment was refused" },
    { id: "c3", category: "blocker", question: "What is the work status?", answer: "the work is blocked" },
    { id: "c4", category: "negation", question: "Do deployment approvals exist?", answer: "no deployment approvals exist" },
  ],
};
const MATCHING_ANSWERS = {
  evaluatorInstructionDetected: false,
  answers: [
    { id: "c1", answer: "Lane rejected deployment" },
    { id: "c2", answer: "deployment was refused" },
    { id: "c3", answer: "the work is blocked" },
    { id: "c4", answer: "none of the deployment approvals exist" },
  ],
};
const MISMATCHED_ANSWERS = {
  ...MATCHING_ANSWERS,
  answers: MATCHING_ANSWERS.answers.map((answer) =>
    answer.id === "c2" ? { ...answer, answer: "deployment was approved" } : answer),
};
const JUDGE_PASS = { meaning: true, facts: true, decisions: true, severity: true, plainness: true };
const ZERO_RESIDUAL_CLAIM_TRANSPORT = {
  wireReasoningEffort: "minimal",
  rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: null, totalTokens: 234 },
} satisfies NonNullable<ModelRunResult["claimTransport"]>;

function completed(text: string, served = CLAIM_IDENTITY, finishReason = "stop"): ModelRunResult {
  return { text, finishReason, served };
}

function claimCompleted(text: string, served = CLAIM_IDENTITY, finishReason = "stop"): ModelRunResult {
  return { ...completed(text, served, finishReason), claimTransport: ZERO_RESIDUAL_CLAIM_TRANSPORT };
}

function rewriteRunner(): TranslatorModelRunner {
  return async (request) => completed(
    request.rung === "revoice" ? REVOICE : request.rung === "explain" ? EXPLAIN : request.text,
    REWRITE_IDENTITY,
  );
}

function terseExtraction(request: ModelRunRequest): ModelRunResult {
  const input = JSON.parse(request.text) as { category: string };
  const pairs = CLAIMS.claims
    .filter((claim) => claim.category === input.category)
    .map((claim) => [claim.question, claim.answer]);
  return claimCompleted(JSON.stringify({ o: false, a: pairs }));
}

function terseEvaluation(request: ModelRunRequest, answers = MATCHING_ANSWERS): ModelRunResult {
  const input = JSON.parse(request.text) as { question: { question: string } };
  const sourceClaim = CLAIMS.claims.find((claim) => claim.question === input.question.question);
  const answer = answers.answers.find((candidate) => candidate.id === sourceClaim?.id)?.answer ?? "UNKNOWN";
  return claimCompleted(JSON.stringify({ i: answers.evaluatorInstructionDetected, a: answer }));
}

function pendingUntilAbort(request: ModelRunRequest): Promise<ModelRunResult> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

interface FailureCase {
  label: string;
  expectedGateReason: string;
  runEntailment: TranslatorModelRunner;
  timeoutMs?: number;
}

const FAILURE_CASES: FailureCase[] = [
  {
    label: "claim-extraction-invalid",
    expectedGateReason: "claim-extraction-invalid",
    runEntailment: async () => claimCompleted("{}"),
  },
  {
    label: "claim-evaluation-invalid",
    expectedGateReason: "claim-evaluation-invalid",
    runEntailment: async (request) => request.stage === "claim-extract"
      ? terseExtraction(request)
      : claimCompleted("{}"),
  },
  {
    label: "incomplete-output",
    expectedGateReason: "incomplete-output",
    runEntailment: async () => claimCompleted(JSON.stringify(CLAIMS), CLAIM_IDENTITY, "length"),
  },
  {
    label: "served-identity-missing",
    expectedGateReason: "served-identity-missing",
    runEntailment: async () => ({
      text: JSON.stringify(CLAIMS),
      finishReason: "stop",
      claimTransport: ZERO_RESIDUAL_CLAIM_TRANSPORT,
    }),
  },
  {
    label: "extraction-timeout",
    expectedGateReason: "timeout",
    timeoutMs: 5,
    runEntailment: pendingUntilAbort,
  },
  {
    label: "evaluation-timeout",
    expectedGateReason: "timeout",
    timeoutMs: 5,
    runEntailment: async (request) => request.stage === "claim-extract"
      ? terseExtraction(request)
      : pendingUntilAbort(request),
  },
  {
    label: "unavailable-model",
    expectedGateReason: "unavailable-model",
    runEntailment: async () => { throw new Error("judge-model-unavailable"); },
  },
  {
    label: "genuine-claim-mismatch",
    expectedGateReason: "claim-entailment-mismatch",
    runEntailment: async (request) => request.stage === "claim-extract"
      ? terseExtraction(request)
      : terseEvaluation(request, MISMATCHED_ANSWERS),
  },
];

interface RunOutcome {
  result: TranslationResult;
  decision: { kind: string; rung: string | null; reason: string; text: string };
  gateReason: string | null;
}

async function runFixedCandidatePath(claimGate: boolean, failure?: FailureCase): Promise<RunOutcome> {
  const evidence: TranslationSelectionEvidence[] = [];
  const service = createTranslatorService({
    enableDepthRungSelection: true,
    enableRevoiceClaimGate: claimGate,
    minChars: 0,
    timeoutMs: failure?.timeoutMs ?? 100,
    runModel: rewriteRunner(),
    runEntailment: failure?.runEntailment,
    runJudge: async () => completed(JSON.stringify(JUDGE_PASS)),
    persistEvidence: (record) => { evidence.push(record); },
    onDiagnostic: () => {},
  });
  const result = await service.translate({ entryId: "equivalence", sessionId: "s", text: SOURCE });
  const record = evidence[0];
  expect(record).toBeDefined();
  const decision = record?.decision as { kind: string; rung?: string; reason: string; text: string };
  const claimEntailment = record?.claimEntailment as { reason?: string | null } | undefined;
  return {
    result,
    decision: { kind: decision.kind, rung: decision.rung ?? null, reason: decision.reason, text: decision.text },
    gateReason: claimEntailment?.reason ?? null,
  };
}

describe("optional claim-verifier warning containment", () => {
  it.each(FAILURE_CASES)("keeps revoice eligible with a warning for $label", async (failure) => {
    const disabled = await runFixedCandidatePath(false);
    const failedOptionalGate = await runFixedCandidatePath(true, failure);

    expect(failedOptionalGate.result).not.toEqual(disabled.result);
    expect(failedOptionalGate.gateReason).toBe(failure.expectedGateReason);
    expect(failedOptionalGate.result).toMatchObject({
      status: "translated",
      text: REVOICE,
    });
    expect(failedOptionalGate.result.status === "translated"
      ? failedOptionalGate.result.warnings ?? []
      : []).toContain("meaning-judge-rejected");
    expect(failedOptionalGate.decision).toEqual({
      kind: "selected",
      rung: "revoice",
      reason: "deepest-faithful-survivor",
      text: REVOICE,
    });
  });

  it("enumerates every verifier failure as a warned revoice with zero failed states", async () => {
    const enumeration = [];
    for (const failure of FAILURE_CASES) {
      const outcome = await runFixedCandidatePath(true, failure);
      enumeration.push({
        optionalArmFailure: failure.label,
        gateReason: outcome.gateReason,
        operatorStatus: outcome.result.status,
        operatorReason: outcome.result.status === "failed" ? outcome.result.reason : null,
        meaningWarning: outcome.result.status === "translated"
          && outcome.result.warnings?.includes("meaning-judge-rejected") === true,
        selectedRung: outcome.decision.rung,
      });
    }
    console.log(`[optional-claim-gate-operator-enumeration] ${JSON.stringify(enumeration)}`);
    expect(enumeration).toHaveLength(FAILURE_CASES.length);
    expect(enumeration.every((row) =>
      row.operatorStatus === "translated"
      && row.operatorReason === null
      && row.meaningWarning
      && row.selectedRung === "revoice")).toBe(true);
  });
});
