/**
 * "Needs you" band — legibility predicate + per-kind label generators + the
 * generate → check → regenerate gate (AUTHORITATIVE, Part D#3 / spec §3).
 *
 * THE LABEL MUST BE GENERATED, NEVER a raw `event.summary` pass-through. The
 * live cds-postprod security gate (dl-6858) sat SEVEN DAYS because its surfaced
 * text was crew-jargon the operator could not parse. This module is the fix:
 *
 *   §3a  per-kind generator     — a `parked-decision` reads differently from a
 *        (`generateLabelTier`)    `stalled-deliverable`. Input = STRUCTURED
 *                                 payload fields, never `summary`. Substance-
 *                                 first competent-colleague sentence: WHAT
 *                                 needs you + WHY + WHAT it costs if ignored.
 *
 *   §3b  falsifiable predicate  — `isLegibleLabel`: FAILS on a dl-id, a
 *        (`isLegibleLabel`)       §-citation, a themed-name, a version-tag, or
 *                                 length > MAX_LABEL_CHARS. Unit-tested BOTH
 *                                 ways (generated labels PASS; raw jargon FAILS).
 *
 *   §3c  the gate               — `generateLegibleLabel`: generate → assert →
 *        (`generateLegibleLabel`) on a LENGTH violation regenerate terser
 *                                 (≤3 attempts, each pass more compact) — NEVER
 *                                 truncate mid-string. Non-length violation OR
 *                                 budget-exhaustion ⇒ a LOUD failure
 *                                 (`LabelGenerationError`); never ship illegible.
 *
 * THE ACTION IS A SEPARATE, UNCAPPED FIELD (Rule 4). `isVerbPhraseAction`
 * checks it starts with an imperative verb; it is NEVER subject to the label
 * cap and NEVER regenerated for length (a truncated action is a Rule 4 fail).
 *
 * BROWSER-SAFE: no `node:` imports (the client re-exports `isLegibleLabel`).
 */

import { MAX_LABEL_CHARS, type NeedsYouKind } from "./needs-you-band.js";

// ── §3b: the falsifiable legibility predicate ──────────────────────────────

/** A dl-id: `dl-6858`. Jargon — belongs in `drilldown`, never a `label`. */
const DL_ID_RE = /\bdl-\d+\b/;

/**
 * A §-citation or its word-forms. `§16.1`, `§ 3`, `NOS §`, a bare `A6` / `C1` /
 * `F1` / `R2` clause-cite, or `Rule 4`. Uppercase-anchored to avoid matching
 * prose like "a4 paper".
 *
 * The bare-clause-cite alt is bounded to 1–2 digits (`\b[A-Z]\d{1,2}\b`) so it
 * catches the documented clause-cite word-forms without swallowing legitimate
 * operator-language product names with 3+ digits (e.g. "D365"). CALIBRATION
 * NOTE for Peggy: a 2-char product code like "Q4" would still trip this — flag
 * if a real label needs one.
 */
const SECTION_CITE_RE = /§\s*\d|\bNOS\b|\b[A-Z]\d{1,2}\b|\bRule\s+\d/;

/**
 * A version / substrate-rev tag: `v0`, `v1.4.4`, `-r3`, `substrate_rev`.
 * These are provenance jargon, never operator-language.
 */
const VERSION_TAG_RE = /\bv\d+(\.\d+)*\b|-r\d+\b|substrate_rev/;

/**
 * Known crew / themed code-names that must resolve to ROLE-names in a label
 * ("the postprod driver has the steps", not a themed-name). The generator
 * resolves these upstream; the predicate is the backstop that keeps a leaked
 * themed-name out of a shipped label.
 *
 * Deliberately conservative — only unambiguous code-names that will not
 * collide with ordinary operator-language words. Word-boundary + case-
 * insensitive matched.
 */
export const THEMED_NAMES: readonly string[] = Object.freeze([
  "Salvatore",
  "Hearth",
  "Peggy",
  "Joan",
  "Harry",
  "Dashwright",
  "Compass",
  "Auditor",
  "Herald",
  "ZenNova",
  "Bert",
]);

const THEMED_NAME_RE = new RegExp(`\\b(${THEMED_NAMES.join("|")})\\b`, "i");

/** Result of the legibility predicate: `ok` + every violation found. */
export interface LegibilityResult {
  ok: boolean;
  violations: string[];
}

/**
 * §3b — the falsifiable predicate. Scans ALL rules (does not short-circuit) so
 * a caller sees every reason a label is illegible. Each violation string is
 * prefixed with a stable kind token (`length:` / `dl-id:` / `section-cite:` /
 * `themed-name:` / `version-tag:`) so the gate can distinguish a recoverable
 * LENGTH failure from an unrecoverable structural one.
 */
export function isLegibleLabel(label: string): LegibilityResult {
  const violations: string[] = [];

  if (label.length > MAX_LABEL_CHARS) {
    violations.push(`length: ${label.length} > ${MAX_LABEL_CHARS}`);
  }
  const dl = label.match(DL_ID_RE);
  if (dl) violations.push(`dl-id: ${dl[0]}`);

  const cite = label.match(SECTION_CITE_RE);
  if (cite) violations.push(`section-cite: ${cite[0]}`);

  const themed = label.match(THEMED_NAME_RE);
  if (themed) violations.push(`themed-name: ${themed[0]}`);

  const version = label.match(VERSION_TAG_RE);
  if (version) violations.push(`version-tag: ${version[0]}`);

  return { ok: violations.length === 0, violations };
}

// ── §3a-action: the verb-phrase check for the (separate, uncapped) action ───

/**
 * Imperative verbs an operator-action may open with. A small allow-list is
 * sufficient (Rule 4 / spec §3b): the action must be a verb-phrase — an
 * imperative next step — not a noun-phrase status restatement.
 */
export const IMPERATIVE_VERBS: readonly string[] = Object.freeze([
  "revoke",
  "rotate",
  "approve",
  "reject",
  "decide",
  "choose",
  "pick",
  "confirm",
  "review",
  "unblock",
  "fix",
  "sign",
  "install",
  "run",
  "restart",
  "kill",
  "stop",
  "cancel",
  "resume",
  "retry",
  "check",
  "verify",
  "re-auth",
  "reauth",
  "authorize",
  "merge",
  "deploy",
  "release",
  "ship",
  "open",
  "close",
  "set",
  "update",
  "remove",
  "delete",
  "add",
  "enable",
  "disable",
  "acknowledge",
  "ack",
  "escalate",
  "assign",
  "reassign",
  "discharge",
  "release",
]);

const IMPERATIVE_VERB_SET = new Set(IMPERATIVE_VERBS);

/**
 * True iff `action` is a verb-phrase — its first word is an imperative verb
 * from `IMPERATIVE_VERBS`. Case-insensitive; tolerates leading punctuation and
 * a hyphenated verb (`re-auth`). NEVER length-checked (the action is uncapped).
 */
export function isVerbPhraseAction(action: string): boolean {
  // Strip leading decoration (arrows, bullets, numbering) that may precede the
  // verb — but KEEP letters and hyphens so a real first word survives intact.
  const trimmed = action.trim().replace(/^[^A-Za-z]+/, "");
  if (trimmed.length === 0) return false;
  // First whitespace-delimited token, stripped of trailing punctuation but
  // KEEPING internal hyphens (so `re-auth` survives).
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const word = firstToken.replace(/[^A-Za-z-]+$/, "").toLowerCase();
  return IMPERATIVE_VERB_SET.has(word);
}

// ── §3a: the structured per-kind label input ───────────────────────────────

/**
 * The STRUCTURED payload the generator composes a label from — never a raw
 * `summary`. The watcher fills these from the ledger event's structured fields
 * (production-gate `decision`/`remediation_operator_only`; terminal-blocked
 * `fix`/`root_cause`) or from the derived driver-state, with themed-names
 * ALREADY resolved to role-language.
 */
export interface LabelInput {
  kind: NeedsYouKind;
  /** The role-language subject ("the postprod driver", "the grocery-app build"). */
  subject: string;
  /**
   * The core WHAT — the plain-language heart of the label. Per-kind semantics
   * (the watcher fills these; themed-names already resolved to role-language):
   *   - parked-decision / production-held: the decision as an operator-facing
   *     stake ("a live GitHub token with full access to all your repos").
   *   - stalled-deliverable: where/why it is blocked.
   *   - phantom-hold: the operator-language hold description
   *     ("a release-gate safety check").
   *   - commitment-drop: the promised deliverable ("the data-migration cleanup").
   *   - runaway-cost: the burn WITHOUT a leading verb (the template supplies
   *     "burned"): "$40 of tokens in an hour with no output".
   */
  what: string;
  /**
   * The optional WHY/COST-IF-IGNORED clause, rendered after an em-dash in the
   * fullest tier and dropped first when regenerating terser. Keep it a phrase.
   */
  stakes?: string;
  /** Optional age-in-days context for commitment-drop / stalled framing. */
  ageDays?: number;
  /**
   * Optional production-held live-instance EXPOSURE/context (§2). The watcher
   * passes this from the REAL event payload so the label is accurate-to-instance
   * — committed-but-private reads very differently from leaked-public. Rendered
   * as the production-held context clause (PREFERRED over `stakes`). NEVER bake
   * a fixed "exposed to the internet" framing into the template: the cds repo
   * was 404-not-public. Freshness/context, not template.
   */
  exposure?: string;
}

// ── §3a: the per-kind generators (tiered for the regenerate loop) ──────────

/**
 * Generate a candidate label for `input` at a compactness `tier`:
 *   tier 0 — fullest: WHAT + stakes clause.
 *   tier 1 — drop the stakes clause (WHAT only, per-kind framed).
 *   tier 2 — tightest: the bare WHAT, minimal framing.
 * Higher tiers are strictly shorter. The gate escalates the tier ONLY on a
 * length violation; it never truncates mid-string.
 */
export function generateLabelTier(input: LabelInput, tier: 0 | 1 | 2): string {
  const what = input.what.trim();
  const subject = input.subject.trim();
  const stakes = input.stakes?.trim();

  switch (input.kind) {
    case "parked-decision": {
      // A genuinely-open, reversible operator-decision. The decision itself is
      // the WHAT, phrased as an operator-facing pick (the watcher supplies
      // decision-shaped language). Reversible → may drive-with-default.
      if (tier === 0) return stakes ? `${cap(what)} — ${stakes}` : cap(what);
      return cap(what);
    }
    case "production-held": {
      // HALT-tier: a real production action held on the operator's explicit
      // decision (production-gate). Shares parked-decision's substance-first
      // prose SHAPE by design — the HALT distinction lives at the item level
      // (`halt_tier=true` + the KILL-step action), not in the label prose.
      // §2: the live-instance `exposure` context (accurate-to-instance) is the
      // PREFERRED context clause over generic `stakes` — never a baked framing.
      const ctx = input.exposure?.trim() || stakes;
      if (tier === 0) return ctx ? `${cap(what)} — ${ctx}` : cap(what);
      return cap(what);
    }
    case "stalled-deliverable": {
      const base = `${cap(subject)} is blocked: ${what}`;
      const tight = `${cap(subject)} blocked: ${what}`;
      if (tier === 0) return stakes ? `${base} — ${stakes}` : base;
      if (tier === 1) return base;
      return tight;
    }
    case "phantom-hold": {
      // Peggy voice-pass: de-jargon the mechanical/build framing. `what` is the
      // operator-language description of the hold (e.g. "a release-gate safety
      // check"). Default render: "A release-gate safety check is marked active
      // but never actually blocks anything."
      const base = `${cap(what)} is marked active but never actually blocks anything.`;
      const tight = `${cap(what)} is marked active but never blocks.`;
      if (tier === 0) return stakes ? `${base} — ${stakes}` : base;
      if (tier === 1) return base;
      return tight;
    }
    case "commitment-drop": {
      // Peggy voice-pass: kill the "last tenure" crew-jargon + the double
      // "never finished". `what` is the promised deliverable. Default render:
      // "The data-migration cleanup was promised ~12 days ago and never finished."
      const when = input.ageDays ? `~${input.ageDays} days ago` : "earlier";
      const base = `${cap(what)} was promised ${when} and never finished.`;
      const tight = `${cap(what)} was promised ${when}, never finished.`;
      if (tier === 0) return stakes ? `${base} — ${stakes}` : base;
      if (tier === 1) return base;
      return tight;
    }
    case "runaway-cost": {
      // Peggy voice-pass: de-dup ("burning fast" + "$40 in an hour" said the
      // same). `subject` = the agent, `what` = the burn (NO leading verb — the
      // template supplies "burned"). Default render:
      // "A research agent burned $40 of tokens in an hour with no output."
      const base = `${cap(subject)} burned ${what}.`;
      const tight = `${cap(subject)} runaway spend.`;
      if (tier === 0) return stakes ? `${base} — ${stakes}` : base;
      if (tier === 1) return base;
      return tight;
    }
    default:
      return assertNever(input.kind);
  }
}

// ── §3c: the generate → check → regenerate gate ────────────────────────────

/** The bounded regenerate budget: tiers 0, 1, 2 ⇒ 3 attempts total. */
export const MAX_LABEL_TIER = 2;

/**
 * A LOUD, unrecoverable label-generation failure. Thrown when a generated
 * label STILL fails after the regenerate budget, OR fails a non-length rule
 * (dl-id / §-cite / themed-name / version-tag) that terser regeneration cannot
 * fix. NEVER ship an illegible label: dev/test throw this; prod renders a loud
 * "label-generation failed" placeholder + escalates (never the raw jargon).
 */
export class LabelGenerationError extends Error {
  constructor(
    message: string,
    readonly input: LabelInput,
    readonly lastLabel: string,
    readonly violations: string[],
  ) {
    super(message);
    this.name = "LabelGenerationError";
  }
}

/**
 * §3c — the gate. Generate tier-0 → assert legible. On a LENGTH-only
 * violation, regenerate one tier terser and re-assert (≤ MAX_LABEL_TIER). On a
 * NON-length violation, fail loud immediately (terser won't fix a leaked
 * dl-id / themed-name). On budget-exhaustion, fail loud. Returns the first
 * legible label.
 */
export function generateLegibleLabel(input: LabelInput): string {
  let lastLabel = "";
  let lastViolations: string[] = [];

  for (let tier = 0 as 0 | 1 | 2; tier <= MAX_LABEL_TIER; tier = (tier + 1) as 0 | 1 | 2) {
    const label = generateLabelTier(input, tier);
    const { ok, violations } = isLegibleLabel(label);
    if (ok) return label;

    lastLabel = label;
    lastViolations = violations;

    // A structural (non-length) violation is unrecoverable by terser
    // regeneration — fail loud now rather than burn the budget.
    const lengthOnly = violations.every((v) => v.startsWith("length:"));
    if (!lengthOnly) {
      throw new LabelGenerationError(
        `label failed a non-length legibility rule (kind=${input.kind}): ${violations.join("; ")}`,
        input,
        label,
        violations,
      );
    }
    // else: length-only ⇒ loop to the next (terser) tier.
  }

  // Budget exhausted still too long.
  throw new LabelGenerationError(
    `label still exceeds ${MAX_LABEL_CHARS} chars after ${MAX_LABEL_TIER + 1} tighten attempts (kind=${input.kind})`,
    input,
    lastLabel,
    lastViolations,
  );
}

// ── tiny helpers ───────────────────────────────────────────────────────────

/** Capitalize the first character; leave the rest untouched. */
function cap(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Exhaustiveness guard — a compile-time + runtime backstop for the switch. */
function assertNever(x: never): never {
  throw new Error(`unreachable NeedsYouKind: ${String(x)}`);
}
