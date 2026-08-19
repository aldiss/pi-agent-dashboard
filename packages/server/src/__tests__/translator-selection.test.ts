import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  TRANSLATOR_MIN_COVERAGE,
  TRANSLATOR_RUNG_2_STRUCTURAL_LICENCE,
  TRANSLATOR_RUNG_3_STRUCTURAL_LICENCE,
  appendTranslationSelectionEvidence,
  composeTranslatorCandidateContracts,
  scoreTranslationCandidate,
  selectTranslationCandidate,
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

describe("translation rung selection", () => {
  it("RED CONTROL: a dominant rung-3 candidate is structurally incapable of selection", () => {
    const set: TranslationCandidateSet = {
      shippable: [
        candidate("substitute", "safe shallow", 0.2, 0.9),
        candidate("explain", "safe deeper", 0.6, 0.95),
      ],
      evidenceOnly: candidate("revoice", "dominant but unshippable", 1, 1),
    };

    const decision = selectTranslationCandidate("original", set);

    expect(decision).toMatchObject({ kind: "selected", rung: "explain", text: "safe deeper" });
    expect(decision.text).not.toBe("dominant but unshippable");
    if (decision.kind === "selected") expectTypeOf(decision.rung).toEqualTypeOf<"substitute" | "explain">();
  });

  it("falls back to the original when no shippable candidate clears the joint bar", () => {
    const decision = selectTranslationCandidate("original", {
      shippable: [
        candidate("substitute", "too little coverage", 0.9, TRANSLATOR_MIN_COVERAGE - 0.01),
        candidate("explain", "unsafe", 1, 1, ["quoted-evidence-changed"]),
      ],
      evidenceOnly: candidate("revoice", "irrelevant evidence", 1, 1),
    });

    expect(decision).toEqual({
      kind: "original",
      text: "original",
      reason: "no-shippable-candidate-cleared-faithfulness-bar",
    });
  });

  it("selects the deepest survivor instead of the first or shallowest survivor", () => {
    const decision = selectTranslationCandidate("original", {
      shippable: [
        candidate("substitute", "first shallow", 0.1, 1),
        candidate("explain", "second deep", 0.8, 0.9),
      ],
      evidenceOnly: candidate("revoice", "evidence", 0, 0),
    });

    expect(decision).toMatchObject({
      kind: "selected",
      rung: "explain",
      text: "second deep",
      reason: "deepest-faithful-survivor",
    });
  });

  it("never returns a candidate carrying a deterministic hard issue", () => {
    const decision = selectTranslationCandidate("original", {
      shippable: [
        candidate("substitute", "clean survivor", 0.2, 0.9),
        candidate("explain", "deeper but unsafe", 1, 1, ["blocker-softened"]),
      ],
      evidenceOnly: candidate("revoice", "evidence", 1, 1),
    });

    expect(decision).toMatchObject({ kind: "selected", text: "clean survivor" });
    if (decision.kind === "selected") expect(decision.score.hardIssues).toEqual([]);
  });
});

describe("translation rung scoring and evidence", () => {
  it("composes the unchanged base with only the scoped rung licences", () => {
    const basePrompt = "unchanged Stage 1 base prompt";

    expect(composeTranslatorCandidateContracts(basePrompt)).toEqual([
      {
        rung: "substitute",
        version: "depth-rung-substitute-v2",
        systemPrompt: basePrompt,
        selectable: true,
      },
      {
        rung: "explain",
        version: "depth-rung-explain-v2",
        systemPrompt: `${basePrompt}\n\n${TRANSLATOR_RUNG_2_STRUCTURAL_LICENCE}`,
        selectable: true,
      },
      {
        rung: "revoice",
        version: "depth-rung-revoice-v2",
        systemPrompt: `${basePrompt}\n\n${TRANSLATOR_RUNG_3_STRUCTURAL_LICENCE}`,
        selectable: false,
      },
    ]);
  });

  it("uses the frozen deterministic depth, coverage, and hard-issue rules", () => {
    const score = scoreTranslationCandidate(
      "Internal exact-fetch process remains blocked after sixteen attempts.",
      "Internal retrieval process remains blocked after sixteen attempts.",
      ["numbers-changed"],
    );

    expect(score.depth).toBe(1);
    expect(score.coverage).toBe(0.875);
    expect(score.detectedIssues).toEqual(["numbers-changed"]);
    expect(score.hardIssues).toEqual([]);
  });

  it("appends private line-delimited evidence that can be replayed without a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "translator-selection-evidence-"));
    const path = join(dir, "selection.jsonl");
    try {
      const evidence = {
        schemaVersion: "translator-selection-evidence-v1",
        sourceText: "original",
        candidates: [{ rung: "substitute", rawText: "candidate", score: { depth: 1, coverage: 1, hardIssues: [] } }],
        decision: { kind: "selected", rung: "substitute", reason: "deepest-faithful-survivor" },
      } as any;

      appendTranslationSelectionEvidence(path, evidence);

      expect(readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([evidence]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
