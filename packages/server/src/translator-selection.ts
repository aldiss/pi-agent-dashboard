import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TRANSLATOR_SCORING_VERSION = "depth-coverage-conservative-hard-issues-v2";
export const TRANSLATOR_SELECTION_VERSION = "depth-rung-selection-v1";
export const TRANSLATOR_CLAIM_SELECTION_VERSION = "claim-entailed-revoice-selection-v1";
// PROVISIONAL: uncalibrated coverage floor; awaits operator-labelled pairs. Used only by default-off selection.
export const TRANSLATOR_MIN_COVERAGE = 0.85;
// PROVISIONAL: uncalibrated depth-preference threshold; awaits operator-labelled pairs. Used only by default-off selection.
export const TRANSLATOR_DEPTH_PREFERENCE_THRESHOLD = 0;

export type DepthRung = "substitute" | "explain" | "revoice";
export type ShippableDepthRung = Exclude<DepthRung, "revoice">;
const CLAIM_ENTAILED_REVOICE = Symbol("claim-entailed-revoice");

export const TRANSLATOR_RUNG_2_STRUCTURAL_LICENCE =
  "Rung 2 structural licence: All instructions above remain in force. This licence overrides only sentence-structure and original-position requirements, and only to add one short explanatory clause at the explained term's first appearance and to split one sentence into two. Do not otherwise reorder, move, or drop content. Preserve every proposition, quantity, negation including its scope and attachment, attribution, decision, blocker, uncertainty, Markdown element, and preservation token; copy each preservation token exactly once.";

export const TRANSLATOR_RUNG_3_STRUCTURAL_LICENCE =
  "Rung 3 structural licence: All instructions above remain in force. This licence overrides only sentence-structure, sentence-order, and original-position requirements. You may restructure freely: reorder sentences, turn nouns back into verbs, and replace sentence boundaries. You may move a quantity, negation, or preservation token only as required by that restructuring; never change or drop it. Preserve every proposition, every quantity and every negation in meaning, including each negation's scope and attachment; preserve every attribution, decision, blocker, uncertainty, and preservation token; copy each preservation token exactly once. Nothing may be dropped as too technical to express.";

export function composeTranslatorCandidateContracts(basePrompt: string) {
  return [
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
  ] as const;
}

export interface CandidateModelIdentity {
  provider: string;
  model: string;
}

export interface DepthMeasurement {
  jargonPerHundredWords: number;
  meanWordsPerSentence: number;
  residual: string[];
  wordCount: number;
  sentenceCount: number;
}

export interface TranslationCandidateScore {
  depth: number;
  coverage: number;
  sourceDepth: DepthMeasurement;
  candidateDepth: DepthMeasurement;
  detectedIssues: string[];
  hardIssues: string[];
}

export interface ScoredTranslationCandidate<Rung extends DepthRung = DepthRung> {
  rung: Rung;
  rawText: string;
  text: string;
  servedIdentity: CandidateModelIdentity | null;
  finishReason: string;
  score: TranslationCandidateScore;
}

export interface TranslationCandidateSet {
  shippable: ReadonlyArray<ScoredTranslationCandidate<ShippableDepthRung>>;
  evidenceOnly: ScoredTranslationCandidate<"revoice"> | null;
}

export interface ClaimEntailmentAdmission {
  status: "passed";
  claimQaVersion: string;
  claimCount: number;
  extractionIdentity: CandidateModelIdentity;
  evaluationIdentity: CandidateModelIdentity;
}

export interface ClaimEntailedRevoiceCandidate extends ScoredTranslationCandidate<"revoice"> {
  servedIdentity: CandidateModelIdentity;
  claimEntailment: ClaimEntailmentAdmission;
  readonly [CLAIM_ENTAILED_REVOICE]: true;
}

export type TranslationSelectionDecision =
  | {
      kind: "selected";
      rung: ShippableDepthRung;
      text: string;
      reason: "deepest-faithful-survivor";
      score: TranslationCandidateScore;
      candidate: ScoredTranslationCandidate<ShippableDepthRung>;
    }
  | {
      kind: "original";
      text: string;
      reason: "no-shippable-candidate-cleared-faithfulness-bar";
    };

export type ClaimEntailedTranslationSelectionDecision =
  | {
      kind: "selected";
      rung: DepthRung;
      text: string;
      reason: "deepest-faithful-survivor";
      score: TranslationCandidateScore;
      candidate: ScoredTranslationCandidate<DepthRung>;
    }
  | {
      kind: "original";
      text: string;
      reason: "no-shippable-candidate-cleared-faithfulness-bar";
    };

const EVIDENCE_SPAN = /`[^`\n]+`|```[\s\S]*?```|"(?:\\.|[^"\\\n])*"|“[^”\n]*”/g;
const ORDINARY_ENGLISH = new Set([
  "self-contained", "top-level", "well-known", "read-only", "edge-to-edge", "double-click",
  "three-bucket", "own-hand", "half-way", "long-running", "up-to-date", "so-called", "e-mail",
]);
const CONTENT_FUNCTION_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is",
  "are", "was", "were", "be", "been", "it", "its", "this", "that", "i", "we", "he", "she",
  "they", "as", "by", "from", "not", "no", "so", "if", "then", "than", "which", "what", "who",
]);
const NON_HARD_SELECTION_ISSUES = new Set([
  "known-pattern",
  "numbers-changed",
  "negation-changed",
  "negation-attachment-changed",
  "action-changed",
]);

export function measureTranslationDepth(text: string): DepthMeasurement {
  const prose = text.replace(EVIDENCE_SPAN, " ");
  const patterns: RegExp[] = [
    /\bdl-\d+\b/gi,
    /§\d+/g,
    /\btenure-\d+\b/gi,
    /\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b/g,
    /\b[A-Z]\d+(?:-[A-Z]?\d+)?\b/g,
    /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
    /\b[a-z]+(?:-[a-z]+){1,}\b/g,
    /\b[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+\b/g,
  ];
  const residual = patterns
    .flatMap((pattern) => Array.from(prose.matchAll(pattern), (match) => match[0]))
    .filter((token) => !ORDINARY_ENGLISH.has(token.toLowerCase()));
  const wordCount = (text.match(/[A-Za-z0-9'-]+/g) ?? []).length;
  const sentenceCount = prose.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim()).length;
  return {
    jargonPerHundredWords: (100 * residual.length) / Math.max(1, wordCount),
    meanWordsPerSentence: wordCount / Math.max(1, sentenceCount),
    residual,
    wordCount,
    sentenceCount,
  };
}

export function measureTranslationCoverage(source: string, candidate: string): number {
  const contentWords = (text: string): string[] =>
    (text.toLowerCase().match(/[a-z0-9'-]+/g) ?? [])
      .filter((word) => !CONTENT_FUNCTION_WORDS.has(word) && word.length > 2);
  const sourceWords = contentWords(source);
  if (sourceWords.length === 0) return 1;
  const candidateWords = new Set(contentWords(candidate));
  return sourceWords.filter((word) => candidateWords.has(word)).length / sourceWords.length;
}

export function scoreTranslationCandidate(
  source: string,
  candidate: string,
  detectedIssues: readonly string[],
): TranslationCandidateScore {
  const sourceDepth = measureTranslationDepth(source);
  const candidateDepth = measureTranslationDepth(candidate);
  const sourceDensity = sourceDepth.jargonPerHundredWords;
  return {
    depth: sourceDensity === 0
      ? 0
      : Math.max(0, (sourceDensity - candidateDepth.jargonPerHundredWords) / sourceDensity),
    coverage: measureTranslationCoverage(source, candidate),
    sourceDepth,
    candidateDepth,
    detectedIssues: [...detectedIssues],
    hardIssues: detectedIssues.filter((issue) => !NON_HARD_SELECTION_ISSUES.has(issue)),
  };
}

function clearsFaithfulnessBar(candidate: ScoredTranslationCandidate): boolean {
  return Number.isFinite(candidate.score.depth)
    && Number.isFinite(candidate.score.coverage)
    && candidate.score.coverage >= TRANSLATOR_MIN_COVERAGE
    && candidate.score.hardIssues.length === 0;
}

function clearsClaimEntailedRevoiceBar(candidate: ClaimEntailedRevoiceCandidate): boolean {
  return Number.isFinite(candidate.score.depth) && candidate.score.hardIssues.length === 0;
}

function deepestCandidate<Rung extends DepthRung>(
  candidates: ReadonlyArray<ScoredTranslationCandidate<Rung>>,
): ScoredTranslationCandidate<Rung> | undefined {
  return candidates.reduce<ScoredTranslationCandidate<Rung> | undefined>(
    (best, candidate) => !best
      || candidate.score.depth - best.score.depth > TRANSLATOR_DEPTH_PREFERENCE_THRESHOLD
      ? candidate
      : best,
    undefined,
  );
}

export function admitClaimEntailedRevoice(
  candidate: ScoredTranslationCandidate<"revoice">,
  claimEntailment: ClaimEntailmentAdmission,
): ClaimEntailedRevoiceCandidate {
  if (!candidate.servedIdentity) throw new Error("claim-entailed-revoice-missing-served-identity");
  return {
    ...candidate,
    servedIdentity: candidate.servedIdentity,
    claimEntailment,
    [CLAIM_ENTAILED_REVOICE]: true,
  };
}

export function selectTranslationCandidate(
  original: string,
  candidates: TranslationCandidateSet,
): TranslationSelectionDecision {
  const survivors = candidates.shippable.filter(clearsFaithfulnessBar);
  const selected = deepestCandidate(survivors);
  if (!selected) {
    return { kind: "original", text: original, reason: "no-shippable-candidate-cleared-faithfulness-bar" };
  }
  return {
    kind: "selected",
    rung: selected.rung,
    text: selected.text,
    reason: "deepest-faithful-survivor",
    score: selected.score,
    candidate: selected,
  };
}

export function selectTranslationCandidateWithClaimEntailedRevoice(
  original: string,
  candidates: TranslationCandidateSet,
  revoice: ClaimEntailedRevoiceCandidate | null,
): ClaimEntailedTranslationSelectionDecision {
  const conservative = candidates.shippable.filter(clearsFaithfulnessBar);
  const survivors: ScoredTranslationCandidate<DepthRung>[] = [...conservative];
  if (revoice && clearsClaimEntailedRevoiceBar(revoice)) survivors.push(revoice);
  const selected = deepestCandidate(survivors);
  if (!selected) {
    return { kind: "original", text: original, reason: "no-shippable-candidate-cleared-faithfulness-bar" };
  }
  return {
    kind: "selected",
    rung: selected.rung,
    text: selected.text,
    reason: "deepest-faithful-survivor",
    score: selected.score,
    candidate: selected,
  };
}

export interface TranslationSelectionEvidence {
  schemaVersion: "translator-selection-evidence-v1";
  [key: string]: unknown;
}

export function defaultTranslationSelectionEvidencePath(home = homedir()): string {
  return join(home, ".pi", "dashboard", "translator-selection-evidence.jsonl");
}

export function appendTranslationSelectionEvidence(path: string, evidence: TranslationSelectionEvidence): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
