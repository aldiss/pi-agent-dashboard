import { createHash } from "node:crypto";
import { diffWordsWithSpace } from "diff";
import { createSemaphore } from "@blackbelt-technology/pi-dashboard-shared/semaphore.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { getModelRegistry, getStreamSimpleFn } from "./model-proxy/registry-singleton.js";
import { streamCompletion } from "./model-proxy/streamer.js";

export const TRANSLATOR_VERSION = "dashboard-plain-english-v1";
export const TRANSLATOR_MIN_CHARS = 80;
export const TRANSLATOR_TIMEOUT_MS = 12_000;

const TRANSLATOR_PROMPT = `Rewrite the agent reply in plain English for a human operator.
Return only the rewritten reply. Keep its Markdown structure.
Preserve the same facts, decisions, severity, and force. Never soften blocked, failed, refused, stuck, or unresolved work.
Preserve every negation and every number exactly. Do not round, spell out, add, remove, or move them.
Digits inside ledger ids, section references, and tenure ids are identifiers, not factual numbers. Remove those ids and their digits completely; never turn them into numbered records, rules, or sections.
Preservation tokens beginning __PI_TRANSLATOR_ are immutable evidence. Copy each token exactly once.
Rewrite internal ledger ids, section references, role jargon, and invented internal nouns into ordinary words. Do not copy ids such as dl-15176, tenure-2, or §10.
Assume the reader has no project documentation. Replace every internal track name, role label, process metaphor, abbreviated label, and coined hyphenated term with its concrete meaning in this reply.
Do not preserve an internal label merely for fidelity. Keep the fact it represented, expressed in ordinary language.
Unpack coined labels: a "-origin" label means source, "-first" means starting with, "-get" means retrieval, "-turns" means interactions, "out-of-" means outside the normal process, and "door-N" means check N.
For example, rewrite "lint-eligibility" as "eligibility for the language check," "out-of-band" as "outside the normal process," and a label such as "D5 rule" as "that rule" plus its stated meaning.
Replace letter-number rule labels and lettered track labels with their stated meaning. Never replace removed ids with invented numbered labels such as "Record 1"; use relative phrases such as "the earlier record" and "the latest record".
Do not output any unprotected coined hyphenated term. Do not use opaque workflow nouns such as Track, Packet, Ledger, Gate, seat, rotation, or banked as labels; say architecture choice, document, recorded history, required decision, role, handoff, or the concrete action instead.
Example shape: "Track Quartz is blocked at door-2; exact-fetch found 12-day ghosts (dl-88, §4)." becomes "The architecture choice is blocked at eligibility check 2; exact retrieval found stale records 12 days old."
Add no reassurance, confidence, summary judgement, conclusion, or advice.
If the reply is already plain, return it byte-for-byte unchanged.
Before returning, check the entire reply: it must contain no section symbol, no ledger or tenure id, no unexplained track/door/record label, no internal acronym, and no coined hyphenated term. Preservation tokens are the only exception.`;

export interface TranslationRequest {
  entryId: string;
  sessionId: string;
  text: string;
}

export type TranslationResult =
  | { status: "translated"; entryId: string; text: string; sourceHash: string }
  | { status: "unchanged"; entryId: string; sourceHash: string }
  | { status: "failed"; entryId: string; sourceHash: string; reason: string };

export interface DashboardTranslator {
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

export interface ModelRunRequest {
  text: string;
  system: string;
  signal: AbortSignal;
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelRunResult {
  text: string;
  finishReason: string;
}

export type TranslatorModelRunner = (request: ModelRunRequest) => Promise<string | ModelRunResult>;

export interface TranslatorServiceOptions {
  runModel?: TranslatorModelRunner;
  version?: string;
  minChars?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
}

interface CachedTranslation {
  status: "translated" | "unchanged" | "failed";
  text?: string;
  sourceHash: string;
  reason?: string;
}

export interface ProtectedText {
  text: string;
  tokens: ReadonlyArray<{ token: string; value: string }>;
}

export interface KnownBadPatternCounts {
  ledgerIds: number;
  sectionReferences: number;
  tenureIds: number;
}

export type TranslationSafetyIssue =
  | "known-pattern"
  | "blocker-softened"
  | "negation-changed"
  | "numbers-changed"
  | "quoted-evidence-changed"
  | "added-reassurance"
  | "negation-attachment-changed"
  | "action-changed";

class TranslatorFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function matches(pattern: RegExp, text: string): number {
  return Array.from(text.matchAll(pattern)).length;
}

export function countKnownBadPatterns(text: string): KnownBadPatternCounts {
  return {
    ledgerIds: matches(/\bdl-\d+\b/gi, text),
    sectionReferences: matches(/§\d+/g, text),
    tenureIds: matches(/\btenure-\d+\b/gi, text),
  };
}

function hasKnownBadPattern(text: string): boolean {
  const counts = countKnownBadPatterns(text);
  return counts.ledgerIds > 0 || counts.sectionReferences > 0 || counts.tenureIds > 0;
}

interface Span {
  start: number;
  end: number;
}

const PROTECTED_PATTERNS: ReadonlyArray<RegExp> = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /^>[^\n]*(?:\n|$)/gm,
  /`[^`\n]+`/g,
  /"(?:\\.|[^"\\\n])*"/g,
  /“[^”\n]*”/g,
  /‘[^’\n]*’/g,
  /(^|[\s(])'[^'\n]+'(?=$|[\s.,;:!?])/gm,
  /https?:\/\/[^\s<>)\]}]+/gi,
  /\b[A-Za-z]:\\(?:[^\s<>:"|?*\r\n]+\\)*[^\s<>:"|?*\r\n]*/g,
  /\/(?:[A-Za-z0-9._~@%+\-]+\/)*[A-Za-z0-9._~@%+\-]+/g,
  /\b(?:\.{1,2}\/|~\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\b/g,
  /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|toml|sh|css|html|xml|sql)\b/gi,
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g,
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
  /\b[A-Za-z_$][\w$]*(?=\()/g,
];

function collectProtectedSpans(text: string): Span[] {
  const candidates: Span[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      candidates.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const selected: Span[] = [];
  for (const candidate of candidates) {
    if (selected.some((span) => candidate.start < span.end && candidate.end > span.start)) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.start - b.start);
}

export function maskProtectedSpans(text: string): ProtectedText {
  const spans = collectProtectedSpans(text);
  let salt = 0;
  let seed = "";
  do {
    seed = sha256(`${salt}:${text}`).slice(0, 10).toUpperCase();
    salt++;
  } while (text.includes(`__PI_TRANSLATOR_${seed}_`));

  const tokens: Array<{ token: string; value: string }> = [];
  let cursor = 0;
  let masked = "";
  for (const span of spans) {
    masked += text.slice(cursor, span.start);
    const token = `__PI_TRANSLATOR_${seed}_${tokens.length}__`;
    const value = text.slice(span.start, span.end);
    tokens.push({ token, value });
    masked += token;
    cursor = span.end;
  }
  masked += text.slice(cursor);
  return { text: masked, tokens };
}

function restoreProtectedSpans(output: string, protectedText: ProtectedText): string {
  let restored = output;
  for (const { token, value } of protectedText.tokens) {
    const occurrences = restored.split(token).length - 1;
    if (occurrences !== 1) throw new TranslatorFailure("preservation-token");
    restored = restored.replace(token, value);
  }
  return restored;
}

const BLOCKER_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:blocked|stuck|refused|deadlocked|failed|unresolved)\b/i,
  /\b(?:cannot|can't|unable to)\s+proceed\b/i,
  /\bnot settled\b/i,
  /\bnever completed?\b/i,
];

function blockerSeverity(text: string): number {
  return BLOCKER_PATTERNS.some((pattern) => pattern.test(text)) ? 1 : 0;
}

const NEGATION_PATTERN = /\b(?:not|cannot|can't|never|no|none|without|failed|absent|neither)\b/gi;

function negations(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(NEGATION_PATTERN), (match) => match[0]).sort();
}

function stripKnownPatternNumbers(text: string): string {
  return text
    .replace(/\bdl-\d+\b/gi, " ")
    .replace(/§\d+/g, " ")
    .replace(/\btenure-\d+\b/gi, " ");
}

const NUMBER_PATTERN = /\bv?\d+(?:[.,:/-]\d+)*(?:%|[A-Za-z]{1,4})?\b/gi;

function numbers(text: string): string[] {
  return Array.from(stripKnownPatternNumbers(text).matchAll(NUMBER_PATTERN), (match) => match[0]).sort();
}

const REASSURANCE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bprogressing well\b/i,
  /\bon track\b/i,
  /\bworking as intended\b/i,
  /\bno cause for concern\b/i,
  /\ball good\b/i,
  /\bsuccessfully\b/i,
  /\bfortunately\b/i,
  /\bwe can be confident\b/i,
];

const ATTACHMENT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "did", "do", "does", "for", "had",
  "has", "have", "he", "i", "in", "is", "it", "of", "on", "or", "she", "that", "the", "they", "to",
  "was", "were", "will", "with",
]);

function negationAttachments(text: string): string[] {
  const words = Array.from(text.toLowerCase().matchAll(/[a-z0-9']+/g), (match) => match[0]);
  const markers = new Set(["not", "cannot", "can't", "never", "no", "none", "without", "failed", "absent", "neither"]);
  const signatures: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!markers.has(words[i])) continue;
    let before = "";
    for (let j = i - 1; j >= 0; j--) {
      if (!ATTACHMENT_STOP_WORDS.has(words[j])) { before = words[j]; break; }
    }
    let after = "";
    for (let j = i + 1; j < words.length; j++) {
      if (!ATTACHMENT_STOP_WORDS.has(words[j])) { after = words[j]; break; }
    }
    if (words[i] === "not" && after === "settled") before = "";
    signatures.push(`${before}:${words[i]}:${after}`);
  }
  return signatures.sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ACTION_PATTERNS: ReadonlyArray<{ action: string; pattern: RegExp }> = [
  {
    action: "record-durably",
    pattern: /\b(?:bank|banks|banked|banking|record|records|recorded|recording|preserve|preserves|preserved|preserving|document|documents|documented|documenting|archive|archives|archived|archiving|log|logs|logged|logging)\b/gi,
  },
  {
    action: "reach-agreement",
    pattern: /\b(?:agree|agrees|agreed|agreeing|agreement|consensus)\b/gi,
  },
];

function actionsIn(text: string): string[] {
  const actions = new Set<string>();
  for (const { action, pattern } of ACTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) actions.add(action);
  }
  return Array.from(actions).sort();
}

export interface ChangedSpanActionCheck {
  source: string;
  output: string;
  sourceActions: string[];
  outputActions: string[];
  sameAction: boolean;
}

/** Independent action/proposition check over every changed word span. */
export function checkChangedSpanActions(source: string, output: string): ChangedSpanActionCheck[] {
  const checks: ChangedSpanActionCheck[] = [];
  let removed = "";
  let added = "";

  const flush = () => {
    if (!removed && !added) return;
    const sourceActions = actionsIn(removed);
    const outputActions = actionsIn(added);
    checks.push({
      source: removed,
      output: added,
      sourceActions,
      outputActions,
      sameAction: sameStrings(sourceActions, outputActions),
    });
    removed = "";
    added = "";
  };

  for (const part of diffWordsWithSpace(source, output)) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else flush();
  }
  flush();
  return checks;
}

export function translationSafetyIssues(source: string, output: string): TranslationSafetyIssue[] {
  const issues: TranslationSafetyIssue[] = [];
  if (hasKnownBadPattern(output)) issues.push("known-pattern");
  if (blockerSeverity(output) < blockerSeverity(source)) issues.push("blocker-softened");
  if (!sameStrings(negations(source), negations(output))) issues.push("negation-changed");
  if (!sameStrings(numbers(source), numbers(output))) issues.push("numbers-changed");

  const protectedValues = maskProtectedSpans(source).tokens.map(({ value }) => value);
  if (protectedValues.some((value) => !output.includes(value))) issues.push("quoted-evidence-changed");

  if (REASSURANCE_PATTERNS.some((pattern) => pattern.test(output) && !pattern.test(source))) {
    issues.push("added-reassurance");
  }
  const sourceAttachments = negationAttachments(source);
  const outputAttachments = negationAttachments(output);
  if (sourceAttachments.length > 0 && !sameStrings(sourceAttachments, outputAttachments)) {
    issues.push("negation-attachment-changed");
  }
  if (checkChangedSpanActions(source, output).some((check) => !check.sameAction)) {
    issues.push("action-changed");
  }
  return issues;
}

export function selectTranslatorModel(models: readonly any[]): any | null {
  const catalogued4oMini = models.find((model) =>
    model?.provider === "github-copilot" && model?.id === "gpt-4o-mini",
  );
  if (catalogued4oMini) return catalogued4oMini;
  // Copilot's live integrator advertises gpt-4o-mini even when pi-ai's static
  // catalogue omits it. Reuse the non-reasoning gpt-4.1 transport metadata;
  // only the model id/name change. Provider rejection still falls back original.
  const copilot41 = models.find((model) =>
    model?.provider === "github-copilot" && model?.id === "gpt-4.1" && model?.api === "openai-completions",
  );
  if (copilot41) {
    return { ...copilot41, id: "gpt-4o-mini", name: "GPT-4o mini", reasoning: false };
  }

  const scored = models
    .filter((model) => model && typeof model.id === "string")
    .map((model) => {
      const id = model.id.toLowerCase();
      const provider = String(model.provider ?? "").toLowerCase();
      let score = Number.POSITIVE_INFINITY;
      if (provider === "github-copilot" && id === "gpt-5.4-mini") score = 0;
      else if (provider === "github-copilot" && id === "gpt-5-mini") score = 1;
      else if (provider !== "github-copilot" && id.includes("nano")) score = 0;
      else if (id.includes("flash-lite")) score = 2;
      else if (id === "gemini-3.5-flash") score = 3;
      else if (id === "gemini-3-flash-preview") score = 4;
      else if (id.includes("flash")) score = 5;
      else if (id.includes("haiku")) score = 6;
      else if (id.includes("gpt-4.1-mini")) score = 7;
      else if (id.includes("gpt-4o-mini")) score = 8;
      else if (id.includes("mini") || id.includes("small")) score = 9;
      return { model, score };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || String(a.model.id).localeCompare(String(b.model.id)));
  return scored[0]?.model ?? null;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function extractTranslationRequest(sessionId: string, event: DashboardEvent): TranslationRequest | null {
  if (event.eventType !== "message_end") return null;
  const data = event.data as Record<string, unknown> | undefined;
  const message = data?.message as { role?: unknown } | undefined;
  const entryId = data?.entryId;
  if (message?.role !== "assistant" || typeof entryId !== "string" || entryId.length === 0) return null;
  const text = extractAssistantText(message);
  if (text.length === 0) return null;
  return { entryId, sessionId, text };
}

function textFromAssistantMessage(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

async function runModelProxy(request: ModelRunRequest): Promise<ModelRunResult> {
  let registry;
  try {
    registry = await getModelRegistry();
  } catch {
    throw new TranslatorFailure("model-unavailable");
  }
  const model = selectTranslatorModel(await registry.getAvailable());
  if (!model) throw new TranslatorFailure("no-small-model");
  const streamSimple = getStreamSimpleFn();
  if (!streamSimple) throw new TranslatorFailure("model-unavailable");

  const iterable = await streamCompletion(
    {
      model,
      system: request.system,
      messages: [{
        role: "user",
        content: `<agent_reply>\n${request.text}\n</agent_reply>\nReturn only the plain-English rewrite. Final check: zero section symbols, ledger ids, unexplained internal labels, or coined terms; copy every preservation token exactly once.`,
        timestamp: Date.now(),
      }],
      maxTokens: request.maxTokens,
      ...(model.reasoning === true ? {} : { temperature: 0 }),
      ...(model.reasoning === true ? { reasoning: "minimal" as const } : {}),
      timeoutMs: request.timeoutMs,
      maxRetries: 0,
      signal: request.signal,
    },
    streamSimple,
    registry,
  );

  let deltas = "";
  let finalText = "";
  let finishReason = "incomplete";
  for await (const event of iterable) {
    if (event?.type === "text_delta" && typeof event.delta === "string") deltas += event.delta;
    if (event?.type === "done") {
      finalText = textFromAssistantMessage(event.message);
      finishReason = String(event.reason ?? event.message?.stopReason ?? "incomplete");
    }
    if (event?.type === "error") {
      const detail = event.error?.errorMessage ?? event.error?.message ?? "unknown provider error";
      console.error(`[translator] model request failed: ${String(detail)}`);
      throw new TranslatorFailure("model-error");
    }
  }
  return { text: finalText || deltas, finishReason };
}

function attachEntry(entryId: string, cached: CachedTranslation): TranslationResult {
  if (cached.status === "translated") {
    return { status: "translated", entryId, sourceHash: cached.sourceHash, text: cached.text! };
  }
  if (cached.status === "unchanged") {
    return { status: "unchanged", entryId, sourceHash: cached.sourceHash };
  }
  return { status: "failed", entryId, sourceHash: cached.sourceHash, reason: cached.reason ?? "model-error" };
}

export function createTranslatorService(options: TranslatorServiceOptions = {}): DashboardTranslator {
  const runModel = options.runModel ?? runModelProxy;
  const version = options.version ?? TRANSLATOR_VERSION;
  const minChars = options.minChars ?? TRANSLATOR_MIN_CHARS;
  const timeoutMs = options.timeoutMs ?? TRANSLATOR_TIMEOUT_MS;
  const semaphore = createSemaphore(options.maxConcurrent ?? 2);
  const cache = new Map<string, CachedTranslation>();
  const inFlight = new Map<string, Promise<CachedTranslation>>();
  const translatedOutputHashes = new Set<string>();

  async function translateOnce(text: string, sourceHash: string): Promise<CachedTranslation> {
    const protectedText = maskProtectedSpans(text);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const modelPromise = Promise.resolve(runModel({
        text: protectedText.text,
        system: TRANSLATOR_PROMPT,
        signal: controller.signal,
        maxTokens: Math.min(4_096, Math.max(2_048, Math.ceil(text.length / 2) + 1_024)),
        timeoutMs,
      }));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TranslatorFailure("timeout"));
        }, timeoutMs);
      });
      const rawResult = await Promise.race([modelPromise, timeoutPromise]);
      const modelResult: ModelRunResult = typeof rawResult === "string"
        ? { text: rawResult, finishReason: "stop" }
        : rawResult;
      if (!new Set(["stop", "end_turn"]).has(modelResult.finishReason)) {
        throw new TranslatorFailure("incomplete-output");
      }
      if (modelResult.text.trim().length === 0) throw new TranslatorFailure("empty-output");
      const output = restoreProtectedSpans(modelResult.text, protectedText);
      if (output.trim().length === 0) throw new TranslatorFailure("empty-output");
      const issues = translationSafetyIssues(text, output);
      if (issues.length > 0) {
        throw new TranslatorFailure(issues.includes("known-pattern") ? "known-pattern" : `safety-check:${issues[0]}`);
      }
      if (output === text) return { status: "unchanged", sourceHash };
      translatedOutputHashes.add(sha256(output));
      return { status: "translated", sourceHash, text: output };
    } catch (error) {
      const reason = error instanceof TranslatorFailure
        ? error.code
        : controller.signal.aborted
          ? "timeout"
          : "model-error";
      return { status: "failed", sourceHash, reason };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    async translate(request: TranslationRequest): Promise<TranslationResult> {
      const sourceHash = sha256(request.text);
      if (request.text.length === 0) {
        return { status: "unchanged", entryId: request.entryId, sourceHash };
      }
      if (translatedOutputHashes.has(sourceHash)) {
        return { status: "failed", entryId: request.entryId, sourceHash, reason: "recursive-input" };
      }
      if (request.text.length < minChars) {
        return { status: "unchanged", entryId: request.entryId, sourceHash };
      }

      const key = `${sourceHash}:${version}`;
      const cached = cache.get(key);
      if (cached) return attachEntry(request.entryId, cached);

      let pending = inFlight.get(key);
      if (!pending) {
        pending = semaphore.run(() => translateOnce(request.text, sourceHash));
        inFlight.set(key, pending);
      }
      try {
        const result = await pending;
        if (result.status !== "failed") cache.set(key, result);
        return attachEntry(request.entryId, result);
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  };
}

export function displayTextForTranslation(original: string, result: TranslationResult): string {
  return result.status === "translated" && result.text.length > 0 ? result.text : original;
}
