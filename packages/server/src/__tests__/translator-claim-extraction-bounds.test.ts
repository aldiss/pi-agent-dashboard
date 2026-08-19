import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_EXTRACTION_MAX_CLAIMS_PER_CATEGORY,
  CLAIM_EXTRACTION_PROMPT_VERSION,
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  parseSourceClaimBatch,
} from "../translator-claim-entailment.js";
import {
  createTranslatorService,
  type ModelRunRequest,
  type ModelRunResult,
} from "../translator-service.js";
import type { TranslationSelectionEvidence } from "../translator-selection.js";

const EXPECTED_MAX_CLAIMS_PER_CATEGORY = 4;
const EXPECTED_EXTRACTION_COMPLETION_BUDGET = 512;
const SOURCE = "Lane refused deployment, no approvals exist, and work remains blocked until the release decision changes.";
const REWRITE_IDENTITY = { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" };
const CLAIM_IDENTITY = { provider: "github-copilot", model: "gemini-3.5-flash" };
const JUDGE_PASS = { meaning: true, facts: true, decisions: true, severity: true, plainness: true };
const ZERO_CLAIM_TRANSPORT = {
  wireReasoningEffort: "minimal",
  rawUsage: {
    promptTokens: 211,
    completionTokens: 23,
    reasoningTokens: null,
    totalTokens: 234,
  },
} satisfies NonNullable<ModelRunResult["claimTransport"]>;

function completed(text: string, served: ModelRunResult["served"]): ModelRunResult {
  return { text, finishReason: "stop", ...(served ? { served } : {}) };
}

function claimCompleted(text: string): ModelRunResult {
  return { text, finishReason: "stop", served: CLAIM_IDENTITY, claimTransport: ZERO_CLAIM_TRANSPORT };
}

function serviceWithEntailment(
  runEntailment: (request: ModelRunRequest) => Promise<ModelRunResult>,
  persisted: TranslationSelectionEvidence[] = [],
) {
  return createTranslatorService({
    enableDepthRungSelection: true,
    enableRevoiceClaimGate: true,
    minChars: 0,
    runModel: async (request) => completed(request.text, REWRITE_IDENTITY),
    runEntailment,
    runJudge: async () => completed(JSON.stringify(JUDGE_PASS), CLAIM_IDENTITY),
    persistEvidence: (evidence) => { persisted.push(evidence); },
    onDiagnostic: () => {},
  });
}

describe("bounded claim extraction", () => {
  it("accepts the explicit per-category maximum and rejects any unflagged excess", () => {
    expect(CLAIM_EXTRACTION_MAX_CLAIMS_PER_CATEGORY).toBe(EXPECTED_MAX_CLAIMS_PER_CATEGORY);
    expect(CLAIM_EXTRACTION_PROMPT_VERSION).toBe("claim-extraction-v3-terse-category-batches-4");
    const claims = Array.from({ length: EXPECTED_MAX_CLAIMS_PER_CATEGORY }, (_, index) => [
      `Question ${index + 1}?`,
      `Answer ${index + 1}`,
    ]);

    expect(parseSourceClaimBatch(JSON.stringify({ o: false, a: claims }))).toMatchObject({
      overflow: false,
      claims: { length: EXPECTED_MAX_CLAIMS_PER_CATEGORY },
    });
    expect(parseSourceClaimBatch(JSON.stringify({ o: false, a: [...claims, ["Excess question?", "Excess answer"]] }))).toBeNull();
    expect(parseSourceClaimBatch(JSON.stringify({ o: true, a: claims }))).toBeNull();
    expect(parseSourceClaimBatch(JSON.stringify({ o: true, a: [] }))).toEqual({ overflow: true, claims: [] });
  });

  it("requires explicit overflow instead of silently omitting a claim", () => {
    expect(CLAIM_EXTRACTION_SYSTEM_PROMPT).toContain(`Maximum ${EXPECTED_MAX_CLAIMS_PER_CATEGORY} claims.`);
    expect(CLAIM_EXTRACTION_SYSTEM_PROMPT).toContain(`If more than ${EXPECTED_MAX_CLAIMS_PER_CATEGORY} claims exist, return overflow true and no claims.`);
    expect(CLAIM_EXTRACTION_SYSTEM_PROMPT).toContain("Return every explicit claim in that category");
    expect(CLAIM_EXTRACTION_SYSTEM_PROMPT).toContain("Never omit a claim to fit.");
  });

  it("keeps the claim-extraction allowance at 512 and evaluation bounded", async () => {
    const requests: ModelRunRequest[] = [];
    const runEntailment = vi.fn(async (request: ModelRunRequest): Promise<ModelRunResult> => {
      requests.push(request);
      if (request.stage === "claim-extract") {
        const input = JSON.parse(request.text) as { category: string };
        return claimCompleted(JSON.stringify({ o: false, a: [[`Question for ${input.category}?`, "same"]] }));
      }
      return claimCompleted(JSON.stringify({ i: false, a: "same" }));
    });
    const service = serviceWithEntailment(runEntailment);

    await service.translate({ entryId: "bounded-budget", sessionId: "s", text: SOURCE });

    const extraction = requests.filter((request) => request.stage === "claim-extract");
    const evaluation = requests.filter((request) => request.stage === "claim-evaluate");
    expect(extraction).toHaveLength(5);
    expect(extraction.map((request) => request.maxTokens)).toEqual(Array(5).fill(EXPECTED_EXTRACTION_COMPLETION_BUDGET));
    expect(evaluation).toHaveLength(5);
    expect(evaluation.map((request) => request.maxTokens)).toEqual(Array(5).fill(256));
  });

  it("keeps explicit extraction overflow as hard revoice ineligibility only", async () => {
    const persisted: TranslationSelectionEvidence[] = [];
    const runEntailment = vi.fn(async (request: ModelRunRequest): Promise<ModelRunResult> => {
      if (request.stage !== "claim-extract") throw new Error("overflow must stop before evaluation");
      return claimCompleted(JSON.stringify({ o: true, a: [] }));
    });
    const service = serviceWithEntailment(runEntailment, persisted);

    const result = await service.translate({ entryId: "bounded-overflow", sessionId: "s", text: SOURCE });

    expect(result.status).not.toBe("failed");
    expect(persisted[0]).toMatchObject({
      claimEntailment: {
        status: "failed",
        revoiceEligible: false,
        reason: "claim-extraction-overflow",
      },
    });
    expect(runEntailment).toHaveBeenCalledOnce();
  });

  it("evaluates and persists every accepted same-category claim without slicing", async () => {
    const claims = Array.from({ length: EXPECTED_MAX_CLAIMS_PER_CATEGORY }, (_, index) => ({
      question: `Who made decision ${index + 1}?`,
      answer: `actor ${index + 1}`,
    }));
    const evaluatedQuestions: string[] = [];
    const persisted: TranslationSelectionEvidence[] = [];
    const runEntailment = vi.fn(async (request: ModelRunRequest): Promise<ModelRunResult> => {
      if (request.stage === "claim-extract") {
        const input = JSON.parse(request.text) as { category: string };
        const pairs = input.category === "actor-attribution"
          ? claims.map(({ question, answer }) => [question, answer])
          : [];
        return claimCompleted(JSON.stringify({ o: false, a: pairs }));
      }
      const input = JSON.parse(request.text) as { question: { question: string } };
      evaluatedQuestions.push(input.question.question);
      const matching = claims.find((claim) => claim.question === input.question.question);
      return claimCompleted(JSON.stringify({ i: false, a: matching?.answer ?? "UNKNOWN" }));
    });
    const service = serviceWithEntailment(runEntailment, persisted);

    await service.translate({ entryId: "bounded-no-slice", sessionId: "s", text: SOURCE });

    expect(evaluatedQuestions).toEqual(claims.map((claim) => claim.question));
    expect(persisted[0]).toMatchObject({
      claimEntailment: {
        status: "passed",
        claimCount: EXPECTED_MAX_CLAIMS_PER_CATEGORY,
      },
    });
    const claimEntailment = persisted[0]?.claimEntailment;
    if (!claimEntailment || typeof claimEntailment !== "object" || Array.isArray(claimEntailment)) {
      throw new Error("missing-claim-entailment-evidence");
    }
    expect((claimEntailment as Record<string, unknown>).claims).toHaveLength(EXPECTED_MAX_CLAIMS_PER_CATEGORY);
  });
});
