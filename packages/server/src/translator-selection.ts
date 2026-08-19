import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as typeof import("proper-lockfile");

export const TRANSLATOR_SCORING_VERSION = "depth-coverage-conservative-hard-issues-v2";
export const TRANSLATOR_SELECTION_VERSION = "depth-rung-selection-v1";
export const TRANSLATOR_CLAIM_SELECTION_VERSION = "claim-entailed-revoice-selection-v1";
export const TRANSLATOR_SELECTION_EVIDENCE_SCHEMA_VERSION = "translator-selection-evidence-v2" as const;
export const TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
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

interface PersistedDepthMeasurement {
  jargonPerHundredWords: number | null;
  meanWordsPerSentence: number | null;
  residualCount: number;
  wordCount: number | null;
  sentenceCount: number | null;
}

interface PersistedTranslationCandidateScore {
  depth: number | null;
  coverage: number | null;
  sourceDepth: PersistedDepthMeasurement | null;
  candidateDepth: PersistedDepthMeasurement | null;
  detectedIssues: string[];
  hardIssues: string[];
}

interface PersistedClaimTransport {
  wireReasoningEffort: "minimal" | null;
  rawUsage: {
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  } | null;
  hiddenResidualTokens: number | null;
  guardDisposition: string | null;
  stage: "claim-extract" | "claim-evaluate" | null;
  servedIdentity: CandidateModelIdentity | null;
  finishReason: string | null;
}

interface PersistedClaimEntailment {
  reason: string | null;
  issueCodeCounts: Record<string, number>;
  claimQaVersion: string | null;
  claimCount: number | null;
  claimCategoryCounts: Record<ClaimCategoryName, number>;
  extractionPromptVersion: string | null;
  evaluationPromptVersion: string | null;
  extractionIdentity: CandidateModelIdentity | null;
  evaluationIdentity: CandidateModelIdentity | null;
  extractionFinishReason: string | null;
  evaluationFinishReason: string | null;
  extractionIdentities: CandidateModelIdentity[];
  evaluationIdentities: CandidateModelIdentity[];
  extractionFinishReasons: string[];
  evaluationFinishReasons: string[];
  extractionTransports: PersistedClaimTransport[];
  evaluationTransports: PersistedClaimTransport[];
  candidateAnswerCount: number;
}

export interface PersistedTranslationSelectionEvidenceV2 {
  schemaVersion: typeof TRANSLATOR_SELECTION_EVIDENCE_SCHEMA_VERSION;
  sourceHash: string | null;
  translatorVersion?: string;
  scoringVersion?: string;
  selectionVersion?: string;
  minCoverage?: number;
  depthPreferenceThreshold?: number;
  detectorVersion?: string;
  candidates: Array<{
    rung: DepthRung | null;
    promptVersion: string | null;
    finishReason: string | null;
    servedIdentity: CandidateModelIdentity | null;
    error: string | null;
    securityCodes: string[];
    score: PersistedTranslationCandidateScore | null;
  }>;
  claimEntailment: PersistedClaimEntailment | null;
  decision: {
    rung: DepthRung | null;
    reason: string | null;
  };
}

type ClaimCategoryName = "quantity" | "negation" | "actor-attribution" | "decision" | "blocker";

const CANDIDATE_ERROR_CODES = new Set([
  "aborted",
  "empty-output",
  "incomplete-output",
  "model-error",
  "model-unavailable",
  "no-small-model",
  "preservation-token",
  "security-injection-detected",
  "served-identity",
  "timeout",
  "unexpected-preservation-token",
]);
const CLAIM_REASON_CODES = new Set([
  "claim-entailment-mismatch",
  "claim-evaluation-invalid",
  "claim-extraction-empty",
  "claim-extraction-invalid",
  "claim-extraction-overflow",
  "claim-hidden-reasoning-detected",
  "claim-reasoning-effort-unverified",
  "claim-usage-unverifiable",
  "deterministic-hard-issue",
  "empty-output",
  "incomplete-output",
  "model-error",
  "revoice-candidate-unavailable",
  "served-identity-mismatch",
  "served-identity-missing",
  "timeout",
  "unavailable-model",
]);
const TRANSLATION_ISSUE_CODES = new Set([
  "action-changed",
  "added-reassurance",
  "blocker-softened",
  "known-pattern",
  "negated-direct-capability-changed",
  "negation-attachment-changed",
  "negation-changed",
  "numbers-changed",
  "quoted-evidence-changed",
  "security-injection-detected",
]);
const SECURITY_DETECTION_CODES = new Set([
  "forced-safe-verdict",
  "evaluator-override",
  "forced-judge-verdict",
]);
const CLAIM_TRANSPORT_DISPOSITIONS = new Set([
  "passed",
  "claim-hidden-reasoning-detected",
  "claim-reasoning-effort-unverified",
  "claim-usage-unverifiable",
]);
const CLAIM_ISSUE_BASES = new Set([
  "claim-evaluator-instruction",
  "claim-answer-duplicate",
  "claim-answer-extra",
  "claim-answer-missing",
  "claim-answer-mismatch",
]);
const DECISION_REASONS = new Set([
  "deepest-faithful-survivor",
  "no-shippable-candidate-cleared-faithfulness-bar",
]);
const FINISH_REASONS = new Set([
  "aborted",
  "cancelled",
  "content_filter",
  "end_turn",
  "error",
  "incomplete",
  "length",
  "max_tokens",
  "stop",
  "toolUse",
  "tool_calls",
  "tool_use",
  "unknown",
]);
const SANITIZED_LINE_PREFIX = Buffer.from(
  `{"schemaVersion":"${TRANSLATOR_SELECTION_EVIDENCE_SCHEMA_VERSION}",`,
  "utf8",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function versionOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : null;
}

function sourceHashOrNull(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDepthRung(value: unknown): value is DepthRung {
  return value === "substitute" || value === "explain" || value === "revoice";
}

function isClaimCategory(value: unknown): value is ClaimCategoryName {
  return value === "quantity"
    || value === "negation"
    || value === "actor-attribution"
    || value === "decision"
    || value === "blocker";
}

function modelIdentity(value: unknown): CandidateModelIdentity | null {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") return null;
  return { provider: value.provider, model: value.model };
}

function modelIdentities(value: unknown): CandidateModelIdentity[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const identity = modelIdentity(candidate);
        return identity ? [identity] : [];
      })
    : [];
}

function controlledStringArray(value: unknown, allowlist: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((candidate): candidate is string =>
    typeof candidate === "string" && allowlist.has(candidate))));
}

function depthMeasurement(value: unknown): PersistedDepthMeasurement | null {
  if (!isRecord(value)) return null;
  return {
    jargonPerHundredWords: finiteNumberOrNull(value.jargonPerHundredWords),
    meanWordsPerSentence: finiteNumberOrNull(value.meanWordsPerSentence),
    residualCount: Array.isArray(value.residual) ? value.residual.length : 0,
    wordCount: finiteNumberOrNull(value.wordCount),
    sentenceCount: finiteNumberOrNull(value.sentenceCount),
  };
}

function persistedScore(value: unknown): PersistedTranslationCandidateScore | null {
  if (!isRecord(value)) return null;
  return {
    depth: finiteNumberOrNull(value.depth),
    coverage: finiteNumberOrNull(value.coverage),
    sourceDepth: depthMeasurement(value.sourceDepth),
    candidateDepth: depthMeasurement(value.candidateDepth),
    detectedIssues: controlledStringArray(value.detectedIssues, TRANSLATION_ISSUE_CODES),
    hardIssues: controlledStringArray(value.hardIssues, TRANSLATION_ISSUE_CODES),
  };
}

function persistedSecurityCodes(value: unknown): string[] {
  return isRecord(value) ? controlledStringArray(value.codes, SECURITY_DETECTION_CODES) : [];
}

function candidateError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && CANDIDATE_ERROR_CODES.has(value) ? value : "model-error";
}

function controlledFinishReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && FINISH_REASONS.has(value) ? value : "unknown";
}

function controlledFinishReasons(value: unknown): string[] {
  return Array.isArray(value) ? value.map(controlledFinishReason).filter((item): item is string => item !== null) : [];
}

function persistedCandidates(value: unknown): PersistedTranslationSelectionEvidenceV2["candidates"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    return [{
      rung: isDepthRung(candidate.rung) ? candidate.rung : null,
      promptVersion: versionOrNull(candidate.promptVersion),
      finishReason: controlledFinishReason(candidate.finishReason),
      servedIdentity: modelIdentity(candidate.servedIdentity),
      error: candidateError(candidate.error),
      securityCodes: persistedSecurityCodes(candidate.securityDetection),
      score: persistedScore(candidate.score),
    }];
  });
}

function claimCategoryCounts(value: unknown): Record<ClaimCategoryName, number> {
  const counts: Record<ClaimCategoryName, number> = {
    quantity: 0,
    negation: 0,
    "actor-attribution": 0,
    decision: 0,
    blocker: 0,
  };
  if (!Array.isArray(value)) return counts;
  for (const claim of value) {
    if (isRecord(claim) && isClaimCategory(claim.category)) counts[claim.category] += 1;
  }
  return counts;
}

function claimIssueCode(value: unknown): string {
  if (typeof value !== "string") return "unknown-claim-issue";
  const parts = value.split(":");
  const base = parts[0] ?? "";
  if (!CLAIM_ISSUE_BASES.has(base)) return "unknown-claim-issue";
  if (base === "claim-answer-mismatch") {
    const category = parts.at(-1);
    return isClaimCategory(category) ? `${base}:${category}` : base;
  }
  return base;
}

function claimIssueCodeCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(value)) return counts;
  for (const issue of value) {
    const code = claimIssueCode(issue);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function persistedRawUsage(value: unknown): PersistedClaimTransport["rawUsage"] {
  if (!isRecord(value)) return null;
  return {
    promptTokens: finiteNumberOrNull(value.promptTokens),
    completionTokens: finiteNumberOrNull(value.completionTokens),
    reasoningTokens: finiteNumberOrNull(value.reasoningTokens),
    totalTokens: finiteNumberOrNull(value.totalTokens),
  };
}

function persistedTransport(value: unknown): PersistedClaimTransport | null {
  if (!isRecord(value)) return null;
  const guardDisposition = typeof value.guardDisposition === "string"
    && CLAIM_TRANSPORT_DISPOSITIONS.has(value.guardDisposition)
    ? value.guardDisposition
    : null;
  const stage = value.stage === "claim-extract" || value.stage === "claim-evaluate" ? value.stage : null;
  return {
    wireReasoningEffort: value.wireReasoningEffort === "minimal" ? "minimal" : null,
    rawUsage: persistedRawUsage(value.rawUsage),
    hiddenResidualTokens: finiteNumberOrNull(value.hiddenResidualTokens),
    guardDisposition,
    stage,
    servedIdentity: modelIdentity(value.servedIdentity),
    finishReason: controlledFinishReason(value.finishReason),
  };
}

function persistedTransports(value: unknown): PersistedClaimTransport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const transport = persistedTransport(candidate);
    return transport ? [transport] : [];
  });
}

function controlledClaimReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && CLAIM_REASON_CODES.has(value) ? value : "model-error";
}

function persistedClaimEntailment(value: unknown): PersistedClaimEntailment | null {
  if (!isRecord(value)) return null;
  const candidateEvaluation = isRecord(value.candidateEvaluation) ? value.candidateEvaluation : null;
  const candidateAnswers = candidateEvaluation && Array.isArray(candidateEvaluation.answers)
    ? candidateEvaluation.answers.length
    : 0;
  return {
    reason: controlledClaimReason(value.reason),
    issueCodeCounts: claimIssueCodeCounts(value.issues),
    claimQaVersion: versionOrNull(value.claimQaVersion),
    claimCount: finiteNumberOrNull(value.claimCount),
    claimCategoryCounts: claimCategoryCounts(value.claims),
    extractionPromptVersion: versionOrNull(value.extractionPromptVersion),
    evaluationPromptVersion: versionOrNull(value.evaluationPromptVersion),
    extractionIdentity: modelIdentity(value.extractionIdentity),
    evaluationIdentity: modelIdentity(value.evaluationIdentity),
    extractionFinishReason: controlledFinishReason(value.extractionFinishReason),
    evaluationFinishReason: controlledFinishReason(value.evaluationFinishReason),
    extractionIdentities: modelIdentities(value.extractionIdentities),
    evaluationIdentities: modelIdentities(value.evaluationIdentities),
    extractionFinishReasons: controlledFinishReasons(value.extractionFinishReasons),
    evaluationFinishReasons: controlledFinishReasons(value.evaluationFinishReasons),
    extractionTransports: persistedTransports(value.extractionTransports),
    evaluationTransports: persistedTransports(value.evaluationTransports),
    candidateAnswerCount: candidateAnswers,
  };
}

function persistedDecision(value: unknown): PersistedTranslationSelectionEvidenceV2["decision"] {
  if (!isRecord(value)) return { rung: null, reason: null };
  const reason = typeof value.reason === "string" && DECISION_REASONS.has(value.reason)
    ? value.reason
    : null;
  return {
    rung: isDepthRung(value.rung) ? value.rung : null,
    reason,
  };
}

export function sanitizeTranslationSelectionEvidence(
  evidence: TranslationSelectionEvidence,
): PersistedTranslationSelectionEvidenceV2 {
  const translatorVersion = versionOrNull(evidence.translatorVersion);
  const scoringVersion = versionOrNull(evidence.scoringVersion);
  const selectionVersion = versionOrNull(evidence.selectionVersion);
  const minCoverage = finiteNumberOrNull(evidence.minCoverage);
  const depthPreferenceThreshold = finiteNumberOrNull(evidence.depthPreferenceThreshold);
  const detectorVersion = versionOrNull(evidence.detectorVersion);
  return {
    schemaVersion: TRANSLATOR_SELECTION_EVIDENCE_SCHEMA_VERSION,
    sourceHash: sourceHashOrNull(evidence.sourceHash),
    ...(translatorVersion !== null ? { translatorVersion } : {}),
    ...(scoringVersion !== null ? { scoringVersion } : {}),
    ...(selectionVersion !== null ? { selectionVersion } : {}),
    ...(minCoverage !== null ? { minCoverage } : {}),
    ...(depthPreferenceThreshold !== null ? { depthPreferenceThreshold } : {}),
    ...(detectorVersion !== null ? { detectorVersion } : {}),
    candidates: persistedCandidates(evidence.candidates),
    claimEntailment: persistedClaimEntailment(evidence.claimEntailment),
    decision: persistedDecision(evidence.decision),
  };
}

export function defaultTranslationSelectionEvidencePath(home = homedir()): string {
  return join(home, ".pi", "dashboard", "translator-selection-evidence.jsonl");
}

function archiveEvidencePath(path: string): string {
  return `${path}.1`;
}

function legacyPrivateEvidencePath(path: string, archive = false): string {
  const stem = basename(path).replace(/\.jsonl$/u, "");
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const kind = archive ? "archive" : "active";
  const privateDirectory = join(dirname(path), "_private-text");
  const prefix = `${stem}-${timestamp}-${kind}-v1-RAW-PRIVATE`;
  for (let ordinal = 0; ordinal <= 999; ordinal += 1) {
    const suffix = ordinal === 0 ? "" : `-${ordinal.toString().padStart(3, "0")}`;
    const candidate = join(privateDirectory, `${prefix}${suffix}.jsonl`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("translation-selection-evidence-quarantine-name-exhausted");
}

function evidenceLockAnchorPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.lock-anchor`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

async function withEvidenceLock<T>(path: string, operation: () => T): Promise<T> {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const anchor = evidenceLockAnchorPath(path);
  try {
    writeFileSync(anchor, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  chmodSync(anchor, 0o600);
  const release = await lockfile.lock(anchor, {
    stale: 10_000,
    realpath: false,
    retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 10, randomize: false },
  });
  try {
    return operation();
  } finally {
    await release();
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function isSanitizedV2Log(path: string): boolean {
  if (!existsSync(path) || statSync(path).size === 0) return true;
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lineHasBytes = false;
  let prefixIndex = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0x0a) {
          if (lineHasBytes && prefixIndex < SANITIZED_LINE_PREFIX.length) return false;
          lineHasBytes = false;
          prefixIndex = 0;
          continue;
        }
        lineHasBytes = true;
        if (prefixIndex < SANITIZED_LINE_PREFIX.length) {
          if (byte !== SANITIZED_LINE_PREFIX[prefixIndex]) return false;
          prefixIndex += 1;
        }
      }
    }
    return !lineHasBytes || prefixIndex === SANITIZED_LINE_PREFIX.length;
  } finally {
    closeSync(descriptor);
  }
}

function quarantineLegacyEvidence(sourcePath: string, destinationPath: string): void {
  const privateDirectory = dirname(destinationPath);
  ensurePrivateDirectory(privateDirectory);
  if (existsSync(destinationPath)) throw new Error("translation-selection-evidence-quarantine-collision");
  chmodSync(sourcePath, 0o600);
  const before = { bytes: statSync(sourcePath).size, sha256: sha256File(sourcePath) };
  renameSync(sourcePath, destinationPath);
  chmodSync(destinationPath, 0o600);
  const after = { bytes: statSync(destinationPath).size, sha256: sha256File(destinationPath) };
  if (before.bytes !== after.bytes || before.sha256 !== after.sha256) {
    throw new Error("translation-selection-evidence-quarantine-verification-failed");
  }
}

function initializeEvidenceFiles(path: string): void {
  const archivePath = archiveEvidencePath(path);
  if (existsSync(path) && statSync(path).size > 0 && !isSanitizedV2Log(path)) {
    quarantineLegacyEvidence(path, legacyPrivateEvidencePath(path));
  }
  if (existsSync(archivePath) && statSync(archivePath).size > 0 && !isSanitizedV2Log(archivePath)) {
    quarantineLegacyEvidence(archivePath, legacyPrivateEvidencePath(path, true));
  }
}

function removeExtraEvidenceArchives(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const ordinal = entry.slice(prefix.length);
    if (/^\d+$/u.test(ordinal) && Number(ordinal) >= 2) rmSync(join(directory, entry), { force: true });
  }
}

async function appendBoundedEvidenceLine(path: string, line: string): Promise<void> {
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES) {
    throw new Error("translation-selection-evidence-record-too-large");
  }
  await withEvidenceLock(path, () => {
    const archivePath = archiveEvidencePath(path);
    const preexistingActiveBytes = existsSync(path) ? statSync(path).size : 0;
    const preexistingArchiveBytes = existsSync(archivePath) ? statSync(archivePath).size : 0;
    if (preexistingActiveBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES
      || preexistingArchiveBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES) {
      throw new Error("translation-selection-evidence-preexisting-over-cap");
    }
    initializeEvidenceFiles(path);
    removeExtraEvidenceArchives(path);
    if (existsSync(archivePath)) {
      chmodSync(archivePath, 0o600);
    }
    let activeBytes = existsSync(path) ? statSync(path).size : 0;
    if (activeBytes > 0 && activeBytes + lineBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES) {
      rmSync(archivePath, { force: true });
      renameSync(path, archivePath);
      chmodSync(archivePath, 0o600);
      activeBytes = 0;
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    const finalActiveBytes = statSync(path).size;
    const finalArchiveBytes = existsSync(archivePath) ? statSync(archivePath).size : 0;
    if (finalActiveBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES
      || finalArchiveBytes > TRANSLATOR_SELECTION_EVIDENCE_MAX_BYTES) {
      throw new Error("translation-selection-evidence-retention-bound-violated");
    }
  });
}

export async function appendTranslationSelectionEvidence(
  path: string,
  evidence: TranslationSelectionEvidence,
): Promise<void> {
  const sanitized = sanitizeTranslationSelectionEvidence(evidence);
  await appendBoundedEvidenceLine(path, `${JSON.stringify(sanitized)}\n`);
}
