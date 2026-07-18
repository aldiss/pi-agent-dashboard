/**
 * Unit tests for the "Needs you" band legibility predicate + per-kind label
 * generators + the generate → check → regenerate gate.
 *
 * The load-bearing assertions (Part D#3 / spec §3c):
 *   - generated labels for the fixtures PASS the predicate,
 *   - a raw jargon-laden `event.summary` FAILS it,
 *   - the gate regenerates terser on a LENGTH violation (never truncates),
 *   - a NON-length violation fails LOUD (throws), never ships illegible,
 *   - the action is a verb-phrase + is NEVER length-capped.
 *
 * Cell: pi-agent-dashboard-needs-you-band. Stage 1.
 */
import { describe, expect, it } from "vitest";
import {
  IMPERATIVE_VERBS,
  LabelGenerationError,
  MAX_LABEL_TIER,
  THEMED_NAMES,
  generateLabelTier,
  generateLegibleLabel,
  isLegibleLabel,
  isVerbPhraseAction,
  type LabelInput,
} from "../needs-you-label.js";
import { MAX_LABEL_CHARS } from "../needs-you-band.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * PRESERVE-live: cds-postprod dl-6858. A `production-gate` → its kind is now
 * `production-held` (HALT-tier), split from parked-decision (Joan×Auditor
 * A5-FINAL 2026-07-18). Its verified revoke-path action is unchanged.
 */
const PRODUCTION_HELD: LabelInput = {
  kind: "production-held",
  subject: "the postprod driver",
  what: "a live GitHub token with full access to all your repos",
  stakes: "anyone with it can push to every repo you own",
};

/** A reversible, genuinely-open operator-decision → parked-decision (may drive-with-default). */
const PARKED_DECISION: LabelInput = {
  kind: "parked-decision",
  subject: "the growth experiment",
  what: "which checkout flow to ship: the two-step or the one-page",
  stakes: "the A/B test stays paused until you pick",
};

/** cds-postprod canonical action (Rule 4, verified with the owning driver). */
const CDS_ACTION =
  "Revoke the GitHub CLI OAuth app — Settings → Applications → Authorized OAuth Apps → GitHub CLI → Revoke, then re-auth gh. (Kills the leaked token; the postprod driver then cleans the repo config + files.)";

/** terminal-blocked → stalled-deliverable (grocery device-build signing wall). */
const STALLED: LabelInput = {
  kind: "stalled-deliverable",
  subject: "the grocery-app build",
  what: "stuck at the code-signing step with no valid certificate",
};

/**
 * The jargon-laden raw `event.summary` — the anti-pass-through fixture. This
 * is EXACTLY what must NEVER be shipped as a label. Trips dl-id, §-cite,
 * themed-name, and version-tag rules.
 */
const RAW_JARGON_SUMMARY =
  "dl-6858 cds-postprod F1 RECONSIDER per NOS §16.1 — Salvatore substrate_rev v2, see A6 freshness-safe-read";

// ── §3b: the falsifiable predicate — BOTH ways ─────────────────────────────

describe("isLegibleLabel — generated labels PASS", () => {
  it("the production-held fixture label is legible (cds-postprod dl-6858)", () => {
    const label = generateLegibleLabel(PRODUCTION_HELD);
    expect(isLegibleLabel(label).ok).toBe(true);
  });

  it("the parked-decision fixture label is legible", () => {
    const label = generateLegibleLabel(PARKED_DECISION);
    expect(isLegibleLabel(label).ok).toBe(true);
  });

  it("the stalled-deliverable fixture label is legible", () => {
    const label = generateLegibleLabel(STALLED);
    expect(isLegibleLabel(label).ok).toBe(true);
  });

  it("all six kinds generate a legible label from a clean input", () => {
    const kinds = [
      "parked-decision",
      "production-held",
      "stalled-deliverable",
      "phantom-hold",
      "commitment-drop",
      "runaway-cost",
    ] as const;
    for (const kind of kinds) {
      const label = generateLegibleLabel({ kind, subject: "the report pipeline", what: "waiting on your review" });
      expect(isLegibleLabel(label).ok, `${kind}: "${label}"`).toBe(true);
    }
  });
});

describe("isLegibleLabel — raw jargon FAILS (anti-pass-through)", () => {
  it("the raw event.summary is illegible", () => {
    expect(isLegibleLabel(RAW_JARGON_SUMMARY).ok).toBe(false);
  });

  it("reports every violation class present in the jargon summary", () => {
    const { violations } = isLegibleLabel(RAW_JARGON_SUMMARY);
    const joined = violations.join(" | ");
    expect(joined).toContain("dl-id:");
    expect(joined).toContain("section-cite:");
    expect(joined).toContain("themed-name:");
    expect(joined).toContain("version-tag:");
  });

  it("the generated label !== the raw summary (the load-bearing assertion)", () => {
    const label = generateLegibleLabel(PARKED_DECISION);
    expect(label).not.toBe(RAW_JARGON_SUMMARY);
  });

  it("fails a dl-id alone", () => {
    expect(isLegibleLabel("Resolve the blocker from dl-6858 before shipping").ok).toBe(false);
  });

  it("fails a §-citation alone", () => {
    expect(isLegibleLabel("Approve the gate per §16.1").ok).toBe(false);
  });

  it("fails a bare clause-cite word-form (A6)", () => {
    expect(isLegibleLabel("Verify the read under A6 first").ok).toBe(false);
  });

  it("fails each known themed-name", () => {
    for (const name of THEMED_NAMES) {
      expect(isLegibleLabel(`${name} has the steps for you`).ok, name).toBe(false);
    }
  });

  it("fails a version-tag (v2) and a substrate_rev", () => {
    expect(isLegibleLabel("Ship the v2 build").ok).toBe(false);
    expect(isLegibleLabel("Roll back the substrate_rev change").ok).toBe(false);
  });

  it("fails a label longer than MAX_LABEL_CHARS", () => {
    const long = "x".repeat(MAX_LABEL_CHARS + 1);
    const result = isLegibleLabel(long);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.startsWith("length:"))).toBe(true);
  });

  it("does NOT false-positive on a 3+ digit product name (D365)", () => {
    // Bare-clause-cite alt is bounded to 1–2 digits, so "D365" is clean.
    expect(isLegibleLabel("Reconnect the D365 sync before the sales close").ok).toBe(true);
  });
});

// ── §3c: the generate → check → regenerate gate ────────────────────────────

describe("generateLegibleLabel — the gate", () => {
  it("returns tier-0 (with stakes clause) when it already fits", () => {
    const label = generateLegibleLabel(PRODUCTION_HELD);
    // tier-0 keeps the stakes clause after the em-dash.
    expect(label).toContain("—");
    expect(label).toContain("anyone with it can push");
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  });

  it("regenerates TERSER on a length violation (drops the stakes clause), never truncates", () => {
    const longStakes: LabelInput = {
      ...STALLED,
      stakes:
        "the app cannot ship to the device until a new distribution certificate is installed and the build is re-signed",
    };
    // tier-0 (with that stakes clause) is > 120; tier-1 (base only) is 90.
    const tier0 = generateLabelTier(longStakes, 0);
    expect(tier0.length).toBeGreaterThan(MAX_LABEL_CHARS);

    const label = generateLegibleLabel(longStakes);
    expect(label.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    // Terser regeneration = the tier-1 label, NOT a mid-string cut of tier-0.
    expect(label).toBe(generateLabelTier(longStakes, 1));
    // A truncation would have kept a dangling prefix of the stakes clause.
    expect(label).not.toContain("distribution certificate");
    expect(label.endsWith("…")).toBe(false);
  });

  it("throws LOUD (LabelGenerationError) when EVERY tier still exceeds the cap", () => {
    const hopeless: LabelInput = {
      kind: "stalled-deliverable",
      subject: "the build",
      // A single unbreakable WHAT longer than the cap — no tier can fit it.
      what: "x".repeat(MAX_LABEL_CHARS + 20),
    };
    expect(() => generateLegibleLabel(hopeless)).toThrow(LabelGenerationError);
  });

  it("throws LOUD immediately on a NON-length violation (leaked dl-id) — terser can't fix it", () => {
    const leaked: LabelInput = {
      kind: "stalled-deliverable",
      subject: "the build",
      what: "resolve dl-6858 before shipping",
    };
    expect(() => generateLegibleLabel(leaked)).toThrow(LabelGenerationError);
    try {
      generateLegibleLabel(leaked);
    } catch (e) {
      expect(e).toBeInstanceOf(LabelGenerationError);
      const err = e as LabelGenerationError;
      expect(err.violations.some((v) => v.startsWith("dl-id:"))).toBe(true);
      // Fails at tier-0 without exhausting the budget (structural, not length).
      expect(err.lastLabel).toContain("dl-6858");
    }
  });

  it("MAX_LABEL_TIER budget is 2 (tiers 0,1,2 ⇒ 3 attempts)", () => {
    expect(MAX_LABEL_TIER).toBe(2);
  });
});

describe("generateLabelTier — tiers are strictly non-increasing in length", () => {
  it("tier 0 ≥ tier 1 ≥ tier 2 for a fixture with stakes", () => {
    const t0 = generateLabelTier(STALLED, 0);
    const t1 = generateLabelTier(STALLED, 1);
    const t2 = generateLabelTier(STALLED, 2);
    expect(t0.length).toBeGreaterThanOrEqual(t1.length);
    expect(t1.length).toBeGreaterThanOrEqual(t2.length);
  });

  it("each content-framed kind renders a distinct per-kind framing (not one generic bucket)", () => {
    const base = { subject: "the pipeline", what: "waiting on you" } as const;
    const stalled = generateLabelTier({ kind: "stalled-deliverable", ...base }, 1);
    const phantom = generateLabelTier({ kind: "phantom-hold", ...base }, 1);
    const commitment = generateLabelTier({ kind: "commitment-drop", ...base }, 1);
    const runaway = generateLabelTier({ kind: "runaway-cost", ...base }, 1);
    const framed = [stalled, phantom, commitment, runaway];
    // Four distinct content-framings ⇒ four distinct strings.
    expect(new Set(framed).size).toBe(4);
    expect(stalled).toContain("blocked");
    // Peggy §1 re-voices (de-jargoned):
    expect(phantom).toContain("marked active but never actually blocks");
    expect(commitment).toContain("was promised");
    expect(runaway).toContain("burned");
  });

  it("Peggy §1 re-voices render VERBATIM (tier-0, no stakes = the default render)", () => {
    // commitment-drop: kill "last tenure" + double "never finished".
    expect(
      generateLabelTier({ kind: "commitment-drop", subject: "the migration driver", what: "the data-migration cleanup", ageDays: 12 }, 0),
    ).toBe("The data-migration cleanup was promised ~12 days ago and never finished.");
    // phantom-hold: de-jargon the mechanical framing.
    expect(
      generateLabelTier({ kind: "phantom-hold", subject: "the release driver", what: "a release-gate safety check" }, 0),
    ).toBe("A release-gate safety check is marked active but never actually blocks anything.");
    // runaway-cost: de-dup (verbless what + template "burned").
    expect(
      generateLabelTier({ kind: "runaway-cost", subject: "a research agent", what: "$40 of tokens in an hour with no output" }, 0),
    ).toBe("A research agent burned $40 of tokens in an hour with no output.");
  });

  it("parked-decision + production-held share bare-WHAT prose by design (HALT distinction is item-level)", () => {
    // production-held split from parked-decision (A5-FINAL); the difference is
    // `halt_tier=true` + the KILL-step action set by the watcher, NOT the label
    // prose. On identical input both render the bare, substance-first WHAT.
    const base = { subject: "the pipeline", what: "which plan to ship" } as const;
    const parked = generateLabelTier({ kind: "parked-decision", ...base }, 1);
    const held = generateLabelTier({ kind: "production-held", ...base }, 1);
    expect(parked).toBe(held);
    expect(parked).toBe("Which plan to ship");
  });

  it("§2 production-held renders the live-instance EXPOSURE (accurate-to-instance, not a baked framing)", () => {
    const base = { kind: "production-held", subject: "the postprod driver", what: "a live GitHub token" } as const;
    // committed-but-private and leaked-public read DIFFERENTLY — the exposure
    // clause carries the accurate-to-instance context, not a fixed framing.
    const priv = generateLabelTier({ ...base, exposure: "committed to a private repo (not public)" }, 0);
    const pub = generateLabelTier({ ...base, exposure: "pushed to a public repo anyone can read" }, 0);
    expect(priv).toBe("A live GitHub token — committed to a private repo (not public)");
    expect(pub).toBe("A live GitHub token — pushed to a public repo anyone can read");
    expect(priv).not.toBe(pub); // accurate-to-instance, not one baked string
  });

  it("§2 exposure takes precedence over generic stakes; absent exposure falls back to stakes", () => {
    const withBoth = generateLabelTier(
      { kind: "production-held", subject: "s", what: "a held deploy", stakes: "generic stakes", exposure: "the real exposure" },
      0,
    );
    expect(withBoth).toBe("A held deploy — the real exposure"); // exposure wins
    const stakesOnly = generateLabelTier({ kind: "production-held", subject: "s", what: "a held deploy", stakes: "generic stakes" }, 0);
    expect(stakesOnly).toBe("A held deploy — generic stakes"); // falls back to stakes
  });
});

// ── §3a-action: the verb-phrase check (separate, UNCAPPED field) ───────────

describe("isVerbPhraseAction", () => {
  it("the cds-postprod canonical action is a verb-phrase", () => {
    expect(isVerbPhraseAction(CDS_ACTION)).toBe(true);
  });

  it("the action is NEVER length-capped (a 121-char action is fine)", () => {
    expect(CDS_ACTION.length).toBeGreaterThan(MAX_LABEL_CHARS);
    expect(isVerbPhraseAction(CDS_ACTION)).toBe(true);
  });

  it("accepts a hyphenated imperative verb (re-auth gh)", () => {
    expect(isVerbPhraseAction("re-auth gh and confirm the new token")).toBe(true);
  });

  it("accepts each allow-listed imperative verb as an opener", () => {
    for (const verb of IMPERATIVE_VERBS) {
      expect(isVerbPhraseAction(`${verb} the thing`), verb).toBe(true);
    }
  });

  it("rejects a noun-phrase status restatement (not an imperative)", () => {
    expect(isVerbPhraseAction("the token is still live")).toBe(false);
  });

  it("rejects an empty / whitespace action", () => {
    expect(isVerbPhraseAction("")).toBe(false);
    expect(isVerbPhraseAction("   ")).toBe(false);
  });

  it("tolerates leading punctuation before the verb", () => {
    expect(isVerbPhraseAction("→ Revoke the app now")).toBe(true);
  });
});
