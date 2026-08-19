import { describe, expect, it, vi } from "vitest";
import * as translatorServiceModule from "../translator-service.js";
import {
  createTranslatorService,
  type ModelRunRequest,
  type ModelRunResult,
  type TranslationResult,
  type TranslatorDiagnostic,
  type TranslatorModelRunner,
} from "../translator-service.js";
import type { TranslationSelectionEvidence } from "../translator-selection.js";

const SOURCE = "The exact-fetch packet-transfer remains blocked because Lane refused deployment, and no approvals exist.";
const EXPLAIN = "The exact-fetch packet transfer remains blocked because Lane refused deployment, and no approvals exist.";
const REVOICE = "Lane rejected the launch. Nobody approved it, so the work remains blocked.";
const REWRITE_IDENTITY = { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" };
const CLAIM_IDENTITY = { provider: "api.enterprise.githubcopilot.com", model: "gemini-3.5-flash" };
const JUDGE_PASS = { meaning: true, facts: true, decisions: true, severity: true, plainness: true };
const CLAIMS = [
  { id: "c1", category: "actor-attribution", question: "Who rejected deployment?", answer: "Lane rejected deployment" },
  { id: "c2", category: "decision", question: "What deployment decision was made?", answer: "deployment was refused" },
  { id: "c3", category: "blocker", question: "What is the work status?", answer: "the work is blocked" },
  { id: "c4", category: "negation", question: "Do deployment approvals exist?", answer: "no deployment approvals exist" },
] as const;

interface RawProviderUsageFixture {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
  totalTokens: number;
}

interface ClaimTransportFixture {
  wireReasoningEffort: string | null;
  rawUsage: RawProviderUsageFixture | null;
}

interface ClaimEvidenceView {
  status: string;
  reason: string | null;
  revoiceEligible: boolean;
  extractionTransports?: Array<{ wireReasoningEffort: string | null; hiddenResidualTokens: number | null }>;
  evaluationTransports?: Array<{ wireReasoningEffort: string | null; hiddenResidualTokens: number | null }>;
}

interface RunOutcome {
  result: TranslationResult;
  decision: unknown;
  claimEvidence: ClaimEvidenceView | null;
  diagnostics: TranslatorDiagnostic[];
}

const ZERO_RESIDUAL = {
  wireReasoningEffort: "minimal",
  rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: null, totalTokens: 234 },
} satisfies ClaimTransportFixture;

function completed(text: string, served = CLAIM_IDENTITY): ModelRunResult {
  return { text, finishReason: "stop", served };
}

function claimCompleted(text: string, transport: ClaimTransportFixture | null): ModelRunResult {
  return transport === null
    ? { text, finishReason: "stop", served: CLAIM_IDENTITY }
    : { text, finishReason: "stop", served: CLAIM_IDENTITY, claimTransport: transport };
}

function rewriteRunner(): TranslatorModelRunner {
  return async (request) => completed(
    request.rung === "revoice" ? REVOICE : request.rung === "explain" ? EXPLAIN : request.text,
    REWRITE_IDENTITY,
  );
}

function extraction(request: ModelRunRequest): string {
  const input = JSON.parse(request.text) as { category: string };
  const pairs = CLAIMS
    .filter((claim) => claim.category === input.category)
    .map((claim) => [claim.question, claim.answer]);
  return JSON.stringify({ o: false, a: pairs });
}

function evaluation(request: ModelRunRequest): string {
  const input = JSON.parse(request.text) as { question: { question: string } };
  const sourceClaim = CLAIMS.find((claim) => claim.question === input.question.question);
  return JSON.stringify({ i: false, a: sourceClaim?.answer ?? "UNKNOWN" });
}

function claimEvidence(record: TranslationSelectionEvidence): ClaimEvidenceView | null {
  const value = record.claimEntailment;
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-claim-evidence");
  return value as ClaimEvidenceView;
}

type ClaimTransportPlan = ClaimTransportFixture | null | ((request: ModelRunRequest) => ClaimTransportFixture | null);

async function runFixedPath(claimGate: boolean, transport: ClaimTransportPlan): Promise<RunOutcome> {
  const evidence: TranslationSelectionEvidence[] = [];
  const diagnostics: TranslatorDiagnostic[] = [];
  const service = createTranslatorService({
    enableDepthRungSelection: true,
    enableRevoiceClaimGate: claimGate,
    minChars: 0,
    runModel: rewriteRunner(),
    runEntailment: async (request) => claimCompleted(
      request.stage === "claim-extract" ? extraction(request) : evaluation(request),
      typeof transport === "function" ? transport(request) : transport,
    ),
    runJudge: async () => completed(JSON.stringify(JUDGE_PASS)),
    persistEvidence: (record) => { evidence.push(record); },
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const result = await service.translate({ entryId: "claim-transport", sessionId: "s", text: SOURCE });
  const record = evidence[0];
  if (!record) throw new Error("missing-selection-evidence");
  return { result, decision: record.decision, claimEvidence: claimEvidence(record), diagnostics };
}

describe("claim transport guard", () => {
  it("enables reasoning-effort serialization only for both claim stages", () => {
    const candidate = (translatorServiceModule as Record<string, unknown>).withClaimStageReasoningEffort;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") throw new Error("missing-withClaimStageReasoningEffort");
    const prepare = candidate as (
      model: { provider: string; id: string; api: string; reasoning: boolean; compat: { supportsReasoningEffort: boolean } },
      stage: ModelRunRequest["stage"],
    ) => { provider: string; id: string; api: string; reasoning: boolean; compat: { supportsReasoningEffort: boolean } };
    const registryDescriptor = {
      provider: "github-copilot",
      id: "gemini-3.5-flash",
      api: "openai-completions",
      reasoning: true,
      compat: { supportsReasoningEffort: false },
    };

    const extractionDescriptor = prepare(registryDescriptor, "claim-extract");
    const evaluationDescriptor = prepare(registryDescriptor, "claim-evaluate");

    expect(extractionDescriptor.compat.supportsReasoningEffort).toBe(true);
    expect(evaluationDescriptor.compat.supportsReasoningEffort).toBe(true);
    expect(prepare(registryDescriptor, "rewrite")).toBe(registryDescriptor);
    expect(prepare(registryDescriptor, "judge")).toBe(registryDescriptor);
    expect(registryDescriptor.compat.supportsReasoningEffort).toBe(false);
  });

  it.each([
    {
      label: "absent whole transport record",
      transport: null,
      reason: "claim-usage-unverifiable",
      stage: "claim-extract" as const,
    },
    {
      label: "wire without minimal",
      transport: { ...ZERO_RESIDUAL, wireReasoningEffort: null },
      reason: "claim-reasoning-effort-unverified",
      stage: "claim-extract" as const,
    },
    {
      label: "missing raw usage",
      transport: { wireReasoningEffort: "minimal", rawUsage: null },
      reason: "claim-usage-unverifiable",
      stage: "claim-extract" as const,
    },
    {
      label: "positive derived hidden reasoning",
      transport: {
        wireReasoningEffort: "minimal",
        rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: null, totalTokens: 241 },
      },
      reason: "claim-hidden-reasoning-detected",
      stage: "claim-evaluate" as const,
    },
    {
      label: "positive explicit hidden reasoning",
      transport: {
        wireReasoningEffort: "minimal",
        rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: 7, totalTokens: 241 },
      },
      reason: "claim-hidden-reasoning-detected",
      stage: "claim-extract" as const,
    },
    {
      label: "inconsistent raw usage",
      transport: {
        wireReasoningEffort: "minimal",
        rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: 0, totalTokens: 241 },
      },
      reason: "claim-usage-unverifiable",
      stage: "claim-evaluate" as const,
    },
  ])("contains $label and proves the zero-residual positive control", async ({ transport, reason, stage }) => {
    const conservative = await runFixedPath(false, ZERO_RESIDUAL);
    const guarded = await runFixedPath(true, (request) => request.stage === stage ? transport : ZERO_RESIDUAL);
    const positiveControl = await runFixedPath(true, ZERO_RESIDUAL);

    expect(guarded.result).toEqual(conservative.result);
    expect(guarded.decision).toEqual(conservative.decision);
    expect(guarded.result).toMatchObject({ status: "translated", text: EXPLAIN });
    expect(guarded.claimEvidence).toMatchObject({ status: "failed", revoiceEligible: false, reason });
    expect(guarded.diagnostics).toHaveLength(1);
    expect(guarded.diagnostics[0]).toMatchObject({ issueCode: reason, stage });

    expect(positiveControl.result).toMatchObject({ status: "translated", text: REVOICE });
    expect(positiveControl.claimEvidence).toMatchObject({ status: "passed", revoiceEligible: true, reason: null });
    expect(positiveControl.diagnostics).toEqual([]);
  });

  it("accepts zero residual and records minimal wire evidence for extraction and evaluation", async () => {
    const outcome = await runFixedPath(true, ZERO_RESIDUAL);

    expect(outcome.result).toMatchObject({ status: "translated", text: REVOICE });
    expect(outcome.claimEvidence).toMatchObject({ status: "passed", revoiceEligible: true });
    expect(outcome.claimEvidence?.extractionTransports).toHaveLength(5);
    expect(outcome.claimEvidence?.evaluationTransports).toHaveLength(CLAIMS.length);
    expect([
      ...(outcome.claimEvidence?.extractionTransports ?? []),
      ...(outcome.claimEvidence?.evaluationTransports ?? []),
    ]).toEqual(Array(5 + CLAIMS.length).fill(expect.objectContaining({
      wireReasoningEffort: "minimal",
      hiddenResidualTokens: 0,
    })));
  });
});
