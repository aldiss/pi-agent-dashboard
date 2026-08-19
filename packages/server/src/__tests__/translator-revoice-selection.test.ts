import { describe, expect, it } from "vitest";
import {
  admitClaimEntailedRevoice,
  selectTranslationCandidateWithClaimEntailedRevoice,
  type ClaimEntailmentAdmission,
  type DepthRung,
  type ScoredTranslationCandidate,
  type TranslationCandidateSet,
} from "../translator-selection.js";

function candidate<Rung extends DepthRung>(
  rung: Rung,
  text: string,
  depth: number,
  coverage: number,
  hardIssues: string[] = [],
): ScoredTranslationCandidate<Rung> {
  return {
    rung,
    rawText: text,
    text,
    servedIdentity: { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" },
    finishReason: "stop",
    score: {
      depth,
      coverage,
      sourceDepth: { jargonPerHundredWords: 1, meanWordsPerSentence: 10, residual: ["CC"], wordCount: 10, sentenceCount: 1 },
      candidateDepth: { jargonPerHundredWords: 0, meanWordsPerSentence: 10, residual: [], wordCount: 10, sentenceCount: 1 },
      detectedIssues: [...hardIssues],
      hardIssues: [...hardIssues],
    },
  };
}

const admission: ClaimEntailmentAdmission = {
  status: "passed",
  claimQaVersion: "claim-question-answer-v1",
  claimCount: 5,
  extractionIdentity: { provider: "api.enterprise.githubcopilot.com", model: "gemini-3.5-flash" },
  evaluationIdentity: { provider: "api.enterprise.githubcopilot.com", model: "gemini-3.5-flash" },
};

describe("claim-entailed revoice selection", () => {
  it("lets a claim-entailed revoice win without lexical coverage veto", () => {
    const revoice = candidate("revoice", "deep faithful rewrite", 0.9, 0.2);
    const candidates: TranslationCandidateSet = {
      shippable: [candidate("substitute", "safe shallow rewrite", 0.1, 0.95)],
      evidenceOnly: revoice,
    };

    const decision = selectTranslationCandidateWithClaimEntailedRevoice(
      "original",
      candidates,
      admitClaimEntailedRevoice(revoice, admission),
    );

    expect(decision).toMatchObject({ kind: "selected", rung: "revoice", text: "deep faithful rewrite" });
  });

  it("keeps deterministic hard issues fatal even after claim entailment passes", () => {
    const revoice = candidate("revoice", "unsafe rewrite", 1, 1, ["quoted-evidence-changed"]);
    const candidates: TranslationCandidateSet = {
      shippable: [candidate("substitute", "below coverage", 0.1, 0.4)],
      evidenceOnly: revoice,
    };

    const decision = selectTranslationCandidateWithClaimEntailedRevoice(
      "original",
      candidates,
      admitClaimEntailedRevoice(revoice, admission),
    );

    expect(decision).toEqual({
      kind: "original",
      text: "original",
      reason: "no-shippable-candidate-cleared-faithfulness-bar",
    });
  });
});
