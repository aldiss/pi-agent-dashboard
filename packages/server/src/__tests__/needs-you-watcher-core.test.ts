/**
 * Unit tests for the "Needs you" watcher PURE CORE (`computeMustActSet`).
 *
 * Fixtures reflect the VERIFIED ground-truth (own-hand 2026-07-18 + Auditor-8
 * dl-9194 + Peggy) — the brief §7 fixtures DRIFTED; these supersede them:
 *
 *   - CANDIDATE SOURCE = `open-decisions` (the closes-edge-HONORING projection).
 *     NEVER raw event `status` (append-only ⇒ a resolved event still reads
 *     `status=open`).
 *   - dl-6858 (cds-postprod) = EXCLUDE via closes-edge (dl-9167 `closes=dl-6858`).
 *     Already absent from `open-decisions` — the exclusion is FREE. A defensive
 *     test proves a raw-status-open row WITH a closes-edge is still excluded.
 *   - dl-7878 (grocery) = the REAL provable-supersede test: still in
 *     `open-decisions` (NO closes-edge); resolver dl-8756 signals via
 *     `to_state` "DONE — …INSTALLED…" on the same cell (no closes-edge).
 *   - PRESERVE-live = an INJECTED-SYNTHETIC genuinely-open must-act (the live
 *     genuine set may be ~empty after freshness-filtering the ~79 stale).
 *   - The ~79 stale operator-decisions make Rule-2 freshness LOAD-BEARING.
 *
 * Covers §7 unit criteria 1 (type-filter), 2 (provable-supersede), 3 (SAFETY),
 * 7 (worth-triggers), plus the freshness layer + source→kind.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIONABLE_LEDGER_TYPES,
  INFORMATIONAL_LEDGER_TYPES,
  LABEL_FAILED_PLACEHOLDER,
  OPERATOR_DECISION_STALE_MS,
  applyTypeFilter,
  buildLedgerLabelInput,
  computeMustActSet,
  detectWorthTriggers,
  directiveVerdict,
  ledgerTypeToKind,
  operatorDecisionFreshness,
  provablyResolves,
  resolutionVerdict,
  type DriverRow,
  type LedgerEvent,
  type MustActDeps,
  type MustActInputs,
  type PaneRow,
} from "../needs-you-watcher-core.js";
import { MAX_LABEL_CHARS } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import { isLegibleLabel } from "@blackbelt-technology/pi-dashboard-shared/needs-you-label.js";

const NOW = Date.parse("2026-07-18T12:00:00Z");

// ── Faithful fixtures (real ledger shapes) ──────────────────────────────────

/**
 * dl-6858 — production-gate, cds-postprod. RESOLVED ~09:42 today by dl-9167
 * (production-apply, top-level `closes=dl-6858`). EXCLUDE via closes-edge.
 * Raw `status` still literally reads "open" (append-only) — the trap.
 */
const DL_6858: LedgerEvent = {
  event_id: "dl-6858",
  ts: "2026-07-11T14:08:55Z",
  type: "production-gate",
  thread_id: "peggy+cds-postprod",
  status: "open", // append-only immutability — NOT actually open.
  source: "Salvatore",
  summary: "F1 LIVE PRIVACY INCIDENT... Operator remediation HELD: rotate credential...",
  payload: { driver: "Salvatore", gate_class: "privacy-remediation", decision: "rotate the exposed credential" },
};

/** dl-9167 — the production-apply that closed dl-6858 (top-level closes-edge). */
const DL_9167: LedgerEvent = {
  event_id: "dl-9167",
  ts: "2026-07-18T09:42:00Z",
  type: "production-apply",
  thread_id: "peggy+cds-postprod",
  status: "closed",
  closes: "dl-6858",
  summary: "cds-postprod credential rotation applied; gate retired.",
  payload: {},
};

/** dl-7878 — terminal-blocked, grocery, still OPEN (no closes-edge). The real test. */
const DL_7878: LedgerEvent = {
  event_id: "dl-7878",
  ts: "2026-07-13T19:29:15Z",
  type: "terminal-blocked",
  thread_id: "harry+grocery-meal-planner-ios",
  status: "open",
  source: "Hearth",
  summary: "grocery DEVICE build BLOCKED at signing (operator GUI fix needed)...",
  payload: {
    driver: "Hearth",
    cell_id: "grocery-meal-planner-ios",
    root_cause: "Xcode has no logged-in Apple ID",
    fix: "operator adds their Apple ID in Xcode Settings → Accounts, then re-fire the build",
  },
};

/**
 * dl-8756 — the LANDING that resolves dl-7878. Type `w-step-status-transition`
 * (INFORMATIONAL — excluded by the type-filter, so the supersede scan MUST read
 * the full thread index). NO closes-edge. The authoritative landing signal is
 * `to_state` = "DONE — …INSTALLED…" on the same cell, strictly later.
 */
const DL_8756: LedgerEvent = {
  event_id: "dl-8756",
  ts: "2026-07-17T11:45:16Z",
  type: "w-step-status-transition",
  thread_id: "harry+grocery-meal-planner-ios",
  status: "open",
  source: "Hearth-6",
  summary: "SIGNED DEVICE BUILD+INSTALL LANDED — Meal Planner on operator iPhone 16.",
  payload: {
    driver: "Hearth",
    cell_id: "grocery-meal-planner-ios",
    to_state: "DONE — app built+signed+INSTALLED on operator iPhone 16.",
    unblocks: "The standing on-device gate owed since dl-8378 is now RUNNABLE.",
    w_step: "SIGNED DEVICE BUILD+INSTALL LANDED",
  },
};

/**
 * PRESERVE-live INJECTED-SYNTHETIC — a genuinely-open production-gate with NO
 * resolver. Proves the band SURFACES a real must-act (the SAFETY half: must NOT
 * wrongly exclude a genuinely-open one). Synthetic shape pending Auditor-8's
 * E2E-criterion-1 recast; this is a faithful placeholder of that shape.
 */
const SYNTH_PRESERVE: LedgerEvent = {
  event_id: "dl-99001",
  ts: "2026-07-18T11:30:00Z",
  type: "production-gate",
  thread_id: "synthetic+preserve-live",
  status: "open",
  summary: "SYNTHETIC genuinely-open production-gate for the PRESERVE-live SAFETY test.",
  payload: {
    cell_id: "synthetic-preserve",
    decision: "a real production action is held on your decision",
    stakes: "the deploy is paused until you decide",
  },
};

/** A representative slice of informational cruft (the ~2042 never-surfaced). */
const CRUFT: LedgerEvent[] = INFORMATIONAL_LEDGER_TYPES.map((type, i) => ({
  event_id: `dl-${9500 + i}`,
  ts: "2026-07-01T00:00:00Z",
  type,
  thread_id: `cruft-${i}`,
  summary: `[${type}] institutional record ${i}`,
  payload: {},
}));

function stubDeps(over: Partial<MustActDeps> = {}): MustActDeps {
  return {
    resolveRole: (key) => {
      if (key.includes("cds-postprod")) return "the postprod driver";
      if (key.includes("grocery")) return "the grocery-app build";
      if (key.includes("synthetic")) return "the deploy pipeline";
      return "the driver";
    },
    ...over,
  };
}

/** Thread index over a fixed event universe, keyed by thread_id AND cell_id. */
function indexOver(events: LedgerEvent[]): (k: string) => LedgerEvent[] | undefined {
  return (k: string) => {
    const hits = events.filter((e) => e.thread_id === k || e.payload?.["cell_id"] === k);
    return hits.length > 0 ? hits : undefined;
  };
}

/** Base inputs: the open-decisions projection + the full thread-index universe. */
function baseInputs(openDecisions: LedgerEvent[], universe: LedgerEvent[]): MustActInputs {
  return {
    openDecisions,
    ledgerThreadIndex: indexOver(universe),
    driverRegistry: [],
    paneState: [],
    now: NOW,
    ledgerHead: "dl-9200",
    deps: stubDeps(),
  };
}

// ── 1. Type-filter (criterion 1) ────────────────────────────────────────────

describe("applyTypeFilter — 2185-open-shaped → only actionable survives", () => {
  it("drops all informational cruft, keeps only actionable types", () => {
    const open = [DL_7878, ...CRUFT];
    const kept = applyTypeFilter(open);
    expect(kept.map((e) => e.event_id)).toEqual(["dl-7878"]);
    expect(kept.every((e) => ACTIONABLE_LEDGER_TYPES.includes(e.type))).toBe(true);
  });

  it("excludes each informational type categorically", () => {
    for (const type of INFORMATIONAL_LEDGER_TYPES) {
      expect(ACTIONABLE_LEDGER_TYPES).not.toContain(type);
      const one: LedgerEvent = { event_id: "dl-x", ts: "", type, thread_id: "t", summary: "s" };
      expect(applyTypeFilter([one])).toHaveLength(0);
    }
  });

  it("keeps the 4 actionable types (production-gate, terminal-blocked, operator-decision, operator-ratify)", () => {
    const rows = ACTIONABLE_LEDGER_TYPES.map((type, i) => ({
      event_id: `dl-${i}`,
      ts: "",
      type,
      thread_id: "t",
      summary: "s",
    }));
    expect(applyTypeFilter(rows)).toHaveLength(4);
  });
});

// ── 2. Exclusion mechanisms: closes-edge (free) + provable-supersede ────────

describe("EXCLUDE mechanism 1 — closes-edge (dl-6858 via open-decisions projection)", () => {
  it("dl-6858 is ABSENT from open-decisions ⇒ never surfaces (exclusion is FREE)", () => {
    // The projection already subtracts dl-6858 (closed by dl-9167). The watcher
    // consumes open-decisions, so dl-6858 simply is not a candidate.
    const openDecisions = [DL_7878]; // dl-6858 NOT here — projection excluded it.
    const items = computeMustActSet(baseInputs(openDecisions, [DL_7878, DL_8756, DL_6858, DL_9167]));
    expect(items.some((i) => i.source.event_id === "dl-6858")).toBe(false);
  });

  it("DEFENSIVE: a raw-status-open row WITH a closes-edge on-thread is still excluded", () => {
    // If a raw-status-open dl-6858 ever slipped into the candidate set, the
    // provable-supersede backstop (closes-edge = proof (a)) still excludes it.
    const items = computeMustActSet(baseInputs([DL_6858], [DL_6858, DL_9167]));
    expect(items.some((i) => i.source.event_id === "dl-6858")).toBe(false);
  });

  it("provablyResolves honors dl-9167.closes === dl-6858 (defensive proof (a))", () => {
    expect(provablyResolves(DL_6858, DL_9167)).toBe(true);
  });
});

describe("EXCLUDE mechanism 2 — provable-supersede (dl-7878 → dl-8756, the REAL test)", () => {
  it("dl-8756 provably resolves dl-7878 via to_state DONE on the same cell, later", () => {
    expect(provablyResolves(DL_7878, DL_8756)).toBe(true);
  });

  it("resolutionVerdict(dl-7878)=resolved when dl-8756 (info-type) is on the thread", () => {
    expect(resolutionVerdict(DL_7878, indexOver([DL_7878, DL_8756]))).toBe("resolved");
  });

  it("computeMustActSet: dl-7878 does NOT surface (superseded by dl-8756)", () => {
    const items = computeMustActSet(baseInputs([DL_7878], [DL_7878, DL_8756]));
    expect(items.some((i) => i.source.event_id === "dl-7878")).toBe(false);
  });

  it("the landing signal is to_state (authoritative), independent of w_step", () => {
    const landingByToStateOnly: LedgerEvent = {
      ...DL_8756,
      event_id: "dl-8760",
      payload: { cell_id: "grocery-meal-planner-ios", to_state: "DONE — INSTALLED" },
      summary: "no landing token in the summary here",
    };
    expect(provablyResolves(DL_7878, landingByToStateOnly)).toBe(true);
  });
});

// ── 3. PRESERVE-live + SAFETY (criteria 3 + 7-SAFETY) ───────────────────────

describe("PRESERVE-live — a genuinely-open must-act SURFACES (SAFETY: no wrong-exclude)", () => {
  it("the synthetic genuinely-open production-gate surfaces as production-held", () => {
    const items = computeMustActSet(baseInputs([SYNTH_PRESERVE], [SYNTH_PRESERVE]));
    const held = items.find((i) => i.source.event_id === "dl-99001");
    expect(held).toBeDefined();
    expect(held?.kind).toBe("production-held");
    expect(held?.halt_tier).toBe(true);
    expect(held?.uncertain).toBe(false); // proven-open (readable thread, no resolver)
    expect(isLegibleLabel(held!.label).ok).toBe(true);
  });

  it("mixed set: synthetic PRESERVES while dl-7878 EXCLUDES (both invariants at once)", () => {
    const items = computeMustActSet(baseInputs([SYNTH_PRESERVE, DL_7878], [SYNTH_PRESERVE, DL_7878, DL_8756]));
    const ids = items.map((i) => i.source.event_id);
    expect(ids).toContain("dl-99001"); // genuinely-open preserved
    expect(ids).not.toContain("dl-7878"); // superseded excluded
  });
});

describe("SAFETY — freshness-safe-read + provable-supersede-only", () => {
  it("unreadable thread ⇒ uncertain=true, SURFACED (never dropped)", () => {
    const items = computeMustActSet({ ...baseInputs([SYNTH_PRESERVE], [SYNTH_PRESERVE]), ledgerThreadIndex: () => undefined });
    const held = items.find((i) => i.source.event_id === "dl-99001");
    expect(held).toBeDefined();
    expect(held?.uncertain).toBe(true); // UNKNOWN-LOUD
  });

  it("a similar-but-UNPROVEN later event does NOT exclude (provable-supersede-only)", () => {
    const laterUnproven: LedgerEvent = {
      event_id: "dl-7900",
      ts: "2026-07-14T00:00:00Z",
      type: "terminal-blocked",
      thread_id: "harry+grocery-meal-planner-ios",
      summary: "still blocked at signing, still working on it",
      payload: { cell_id: "grocery-meal-planner-ios" }, // no to_state, no unblocks, no landing
    };
    expect(provablyResolves(DL_7878, laterUnproven)).toBe(false);
    expect(resolutionVerdict(DL_7878, indexOver([DL_7878, laterUnproven]))).toBe("open");
  });

  it("a landing on a DIFFERENT cell does NOT resolve", () => {
    const otherCell: LedgerEvent = {
      ...DL_8756,
      event_id: "dl-8757",
      thread_id: "other",
      payload: { cell_id: "other-cell", to_state: "DONE — LANDED" },
    };
    expect(provablyResolves(DL_7878, otherCell)).toBe(false);
  });

  it("an EARLIER event with a landing token does NOT resolve (must be strictly later)", () => {
    const earlier: LedgerEvent = { ...DL_8756, event_id: "dl-100", payload: { cell_id: "grocery-meal-planner-ios", to_state: "DONE" } };
    expect(provablyResolves(DL_7878, earlier)).toBe(false);
  });
});

// ── 2b. Rule-2 freshness — the ~79 stale operator-decisions (LOAD-BEARING) ──

describe("operatorDecisionFreshness — the ~79-stale layer", () => {
  const staleTs = new Date(NOW - OPERATOR_DECISION_STALE_MS - 24 * 3600 * 1000).toISOString(); // aged past window
  const freshTs = new Date(NOW - 60 * 1000).toISOString(); // 1 min ago

  function opDecision(id: string, ts: string, thread = "op-thread"): LedgerEvent {
    return { event_id: id, ts, type: "operator-decision", thread_id: thread, status: "open", summary: `decision ${id}`, payload: {} };
  }

  it("a FRESH operator-decision ⇒ fresh (surfaces normally)", () => {
    const d = opDecision("dl-8000", freshTs);
    expect(operatorDecisionFreshness(d, NOW, indexOver([d]))).toBe("fresh");
  });

  it("aged + cell moved on (later non-operator event) + no engagement ⇒ stale-exclude", () => {
    const d = opDecision("dl-3000", staleTs);
    const laterCellMove: LedgerEvent = { event_id: "dl-9000", ts: freshTs, type: "w-step-status-transition", thread_id: "op-thread", summary: "cell moved on" };
    expect(operatorDecisionFreshness(d, NOW, indexOver([d, laterCellMove]))).toBe("stale-exclude");
  });

  it("aged + a later OPERATOR engagement ⇒ stale-uncertain (can't prove it closed — never wrong-drop)", () => {
    const d = opDecision("dl-3001", staleTs);
    const laterOp: LedgerEvent = { event_id: "dl-9001", ts: freshTs, type: "operator-decision", thread_id: "op-thread", summary: "another operator decision later" };
    expect(operatorDecisionFreshness(d, NOW, indexOver([d, laterOp]))).toBe("stale-uncertain");
  });

  it("aged but cell DORMANT (no later event) ⇒ stale-uncertain (can't prove stale)", () => {
    const d = opDecision("dl-3002", staleTs);
    expect(operatorDecisionFreshness(d, NOW, indexOver([d]))).toBe("stale-uncertain");
  });

  it("aged + unreadable thread ⇒ stale-uncertain (freshness-safe-read)", () => {
    const d = opDecision("dl-3003", staleTs);
    expect(operatorDecisionFreshness(d, NOW, () => undefined)).toBe("stale-uncertain");
  });

  it("computeMustActSet: a provably-stale operator-decision is EXCLUDED", () => {
    const d = opDecision("dl-3010", staleTs);
    const laterCellMove: LedgerEvent = { event_id: "dl-9010", ts: freshTs, type: "cell-DONE", thread_id: "op-thread", summary: "moved on" };
    const items = computeMustActSet(baseInputs([d], [d, laterCellMove]));
    expect(items.some((i) => i.source.event_id === "dl-3010")).toBe(false);
  });

  it("computeMustActSet: an aged-unprovable operator-decision SURFACES uncertain (never dropped)", () => {
    const d = opDecision("dl-3011", staleTs);
    const items = computeMustActSet(baseInputs([d], [d])); // dormant cell ⇒ can't prove stale
    const surfaced = items.find((i) => i.source.event_id === "dl-3011");
    expect(surfaced).toBeDefined();
    expect(surfaced?.uncertain).toBe(true);
    expect(surfaced?.kind).toBe("parked-decision");
  });
});

// ── 2c. (d) provable-directive discriminator (interim PENDING-JOAN-RATIFY) ──

describe("directiveVerdict — the (d) provable-directive-ONLY discriminator", () => {
  function opDec(id: string, thread: string, payload: Record<string, unknown> = {}): LedgerEvent {
    return { event_id: id, ts: "2026-07-18T08:00:00Z", type: "operator-decision", thread_id: thread, status: "open", summary: `decision ${id}`, payload };
  }

  it("action-named (awaited_operator_action) ⇒ surface (confident + protected)", () => {
    const d = opDec("dl-9200", "t", { awaited_operator_action: "choose the rollout region" });
    expect(directiveVerdict(d, indexOver([d]))).toBe("surface");
  });

  it("action-named (≥2 decision options) ⇒ surface", () => {
    const d = opDec("dl-9201", "t", { options: ["us-east", "eu-west"] });
    expect(directiveVerdict(d, indexOver([d]))).toBe("surface");
  });

  it("no-action + PROVABLE directive (convergence event) ⇒ exclude", () => {
    const d = opDec("dl-9094", "workstream");
    const converged: LedgerEvent = { event_id: "dl-9098", ts: "2026-07-18T09:00:00Z", type: "mesh-bilateral", thread_id: "workstream", summary: "converged: design ratified, build dispatched", payload: {} };
    expect(directiveVerdict(d, indexOver([d, converged]))).toBe("exclude");
  });

  it("no-action + PROVABLE directive (≥2 sustained crew-progress events) ⇒ exclude", () => {
    const d = opDec("dl-9095", "buildthread");
    const p1: LedgerEvent = { event_id: "dl-9096", ts: "", type: "w-step-status-transition", thread_id: "buildthread", summary: "prepping scripts", payload: {} };
    const p2: LedgerEvent = { event_id: "dl-9097", ts: "", type: "w-step-status-transition", thread_id: "buildthread", summary: "scaffolding built", payload: {} };
    expect(directiveVerdict(d, indexOver([d, p1, p2]))).toBe("exclude");
  });

  it("no-action + only ONE ambiguous later event ⇒ surface-uncertain (provable-ONLY)", () => {
    const d = opDec("dl-9300", "lonely");
    const one: LedgerEvent = { event_id: "dl-9301", ts: "", type: "w-step-status-transition", thread_id: "lonely", summary: "one step", payload: {} };
    expect(directiveVerdict(d, indexOver([d, one]))).toBe("surface-uncertain");
  });

  it("no-action + unreadable thread ⇒ surface-uncertain (never drop)", () => {
    const d = opDec("dl-9302", "gone");
    expect(directiveVerdict(d, () => undefined)).toBe("surface-uncertain");
  });
});

describe("(d) composed into computeMustActSet — the 5 gate fixtures", () => {
  // dl-9094: a directive already GIVEN (dl-9098 converged) + being executed by
  // crew, no awaited operator-action ⇒ EXCLUDE (parked-on-crew, not you).
  const DL_9094: LedgerEvent = {
    event_id: "dl-9094",
    ts: "2026-07-18T08:00:00Z", // RECENT — freshness alone would NOT catch it.
    type: "operator-decision",
    thread_id: "needs-you-band-workstream",
    status: "open",
    summary: "operator-decision: build the needs-you band",
    payload: {}, // no awaited_operator_action
  };
  const DL_9098: LedgerEvent = {
    event_id: "dl-9098",
    ts: "2026-07-18T09:00:00Z",
    type: "mesh-bilateral",
    thread_id: "needs-you-band-workstream",
    summary: "converged: needs-you band design ratified, build dispatched as this workstream",
    payload: { note: "convergence — being built now" },
  };

  it("FIXTURE 1 — dl-9094 EXCLUDED (provable directive; recent, so freshness misses it)", () => {
    const items = computeMustActSet(baseInputs([DL_9094], [DL_9094, DL_9098]));
    expect(items.some((i) => i.source.event_id === "dl-9094")).toBe(false);
    // Prove it's (d) doing the work: without the convergence event on-thread it
    // would SURFACE (recent + no resolver + not action-named ⇒ surface-uncertain).
    const withoutConvergence = computeMustActSet(baseInputs([DL_9094], [DL_9094]));
    expect(withoutConvergence.some((i) => i.source.event_id === "dl-9094")).toBe(true);
  });

  // 1a synthetics: production-gate + terminal-blocked are OUT of (d)'s scope —
  // pending-ness is inherent to their type ⇒ they SURFACE.
  const SYNTH_TERMINAL_BLOCKED: LedgerEvent = {
    event_id: "dl-99002",
    ts: "2026-07-18T11:30:00Z",
    type: "terminal-blocked",
    thread_id: "synthetic+preserve-block",
    status: "open",
    summary: "SYNTHETIC terminal-blocked for the PRESERVE-live SAFETY test",
    payload: { cell_id: "synthetic-block", fix: "operator adds the missing signing credential, then re-fire" },
  };

  it("FIXTURE 2 — 1a synthetics SURFACE: production-gate→production-held, terminal-blocked→stalled-deliverable", () => {
    const items = computeMustActSet(baseInputs([SYNTH_PRESERVE, SYNTH_TERMINAL_BLOCKED], [SYNTH_PRESERVE, SYNTH_TERMINAL_BLOCKED]));
    const held = items.find((i) => i.source.event_id === "dl-99001");
    const blocked = items.find((i) => i.source.event_id === "dl-99002");
    expect(held?.kind).toBe("production-held");
    expect(blocked?.kind).toBe("stalled-deliverable");
  });

  it("FIXTURE 2b — (d) is SCOPED OUT of production-gate: surfaces even WITH a convergence event on-thread", () => {
    // A production-gate on a thread that LOOKS like a given-directive must still
    // SURFACE — (d) applies to operator-decision/ratify ONLY.
    const converged: LedgerEvent = { event_id: "dl-99050", ts: "2026-07-18T11:40:00Z", type: "mesh-bilateral", thread_id: "synthetic+preserve-live", summary: "converged and being built", payload: {} };
    const items = computeMustActSet(baseInputs([SYNTH_PRESERVE], [SYNTH_PRESERVE, converged]));
    expect(items.some((i) => i.source.event_id === "dl-99001")).toBe(true);
  });

  // 4th: (d)-governs-(c). An ACTION-NAMED pick + crew-progress on-thread must
  // STILL SURFACE — an action-named pick is PROTECTED from soft-supersede.
  const ACTION_NAMED_PICK: LedgerEvent = {
    event_id: "dl-9400",
    ts: "2026-07-18T08:00:00Z",
    type: "operator-decision",
    thread_id: "action-named-thread",
    status: "open",
    summary: "operator must choose the rollout region",
    payload: { awaited_operator_action: "choose the rollout region: us-east or eu-west" },
  };
  const CREW_PROG_1: LedgerEvent = { event_id: "dl-9401", ts: "2026-07-18T09:00:00Z", type: "w-step-status-transition", thread_id: "action-named-thread", summary: "prepping rollout scripts", payload: {} };
  const CREW_PROG_2: LedgerEvent = { event_id: "dl-9402", ts: "2026-07-18T10:00:00Z", type: "w-step-status-transition", thread_id: "action-named-thread", summary: "rollout scaffolding built", payload: {} };

  it("FIXTURE 4 — (d)-governs-(c): action-named pick + crew-progress STILL SURFACES (not soft-superseded)", () => {
    const items = computeMustActSet(baseInputs([ACTION_NAMED_PICK], [ACTION_NAMED_PICK, CREW_PROG_1, CREW_PROG_2]));
    const pick = items.find((i) => i.source.event_id === "dl-9400");
    expect(pick).toBeDefined(); // surfaced despite 2 crew-progress events
    expect(pick?.kind).toBe("parked-decision");
    expect(pick?.uncertain).toBe(false); // action-named ⇒ CONFIDENT, not uncertain
  });

  // 5th: DROP-safety. A no-action-named operator-decision NOT provably a
  // directive ⇒ SURFACE-UNCERTAIN, never drop.
  const UNPROVEN_PICK: LedgerEvent = {
    event_id: "dl-9500",
    ts: "2026-07-18T08:00:00Z", // recent (freshness=fresh); the ONLY gate is (d)
    type: "operator-decision",
    thread_id: "lonely-thread",
    status: "open",
    summary: "a decision that does not name its awaited action",
    payload: {},
  };

  it("FIXTURE 5 — DROP-safety: no-action, not-provably-directive ⇒ SURFACE-UNCERTAIN (not dropped)", () => {
    const items = computeMustActSet(baseInputs([UNPROVEN_PICK], [UNPROVEN_PICK]));
    const surfaced = items.find((i) => i.source.event_id === "dl-9500");
    expect(surfaced).toBeDefined(); // NOT dropped
    expect(surfaced?.uncertain).toBe(true); // UNKNOWN-LOUD
  });

  // honest-empty: only stale + directive items ⇒ [] cleanly.
  const STALE_OD: LedgerEvent = {
    event_id: "dl-3020",
    ts: new Date(NOW - OPERATOR_DECISION_STALE_MS - 24 * 3600 * 1000).toISOString(), // aged
    type: "operator-decision",
    thread_id: "stale-thread",
    status: "open",
    summary: "an aged, provably-stale operator-decision",
    payload: {},
  };
  const STALE_CELL_MOVE: LedgerEvent = { event_id: "dl-9020", ts: "2026-07-18T09:00:00Z", type: "w-step-status-transition", thread_id: "stale-thread", summary: "cell advanced to next step", payload: {} };

  it("FIXTURE 6 — honest-empty: only a directive + a stale pick ⇒ computeMustActSet returns []", () => {
    const items = computeMustActSet(baseInputs([DL_9094, STALE_OD], [DL_9094, DL_9098, STALE_OD, STALE_CELL_MOVE]));
    expect(items).toEqual([]); // dl-9094 excluded by (d); dl-3020 excluded by freshness
  });

  it("the discriminator is PLUGGABLE (deps.directiveDiscriminator swaps it cleanly for Joan)", () => {
    // A stub discriminator that force-excludes every operator pick.
    const forceExclude = stubDeps({ directiveDiscriminator: () => "exclude" as const });
    const items = computeMustActSet({ ...baseInputs([ACTION_NAMED_PICK], [ACTION_NAMED_PICK]), deps: forceExclude });
    expect(items.some((i) => i.source.event_id === "dl-9400")).toBe(false);
  });
});

describe("label + action — structured extraction, curation, uncapped verb-phrase action", () => {
  it("buildLedgerLabelInput extracts the structured field, not the summary", () => {
    const input = buildLedgerLabelInput(DL_7878, "stalled-deliverable", stubDeps());
    expect(input.what).not.toBe(DL_7878.summary);
    expect(input.what).toContain("Apple ID"); // from payload.fix
    expect(input.subject).toBe("the grocery-app build");
  });

  it("a jargon/over-long raw field ⇒ loud placeholder (never ships illegible)", () => {
    const jargon: LedgerEvent = {
      event_id: "dl-88",
      ts: "2026-07-18T11:00:00Z",
      type: "production-gate",
      thread_id: "peggy+x",
      status: "open",
      summary: "raw",
      payload: { decision: "F1 RECONSIDER per NOS §16.1 — Salvatore substrate_rev v2 dl-6858 " + "x".repeat(120) },
    };
    const items = computeMustActSet(baseInputs([jargon], [jargon]));
    expect(items.find((i) => i.source.event_id === "dl-88")?.label).toBe(LABEL_FAILED_PLACEHOLDER);
  });

  it("WITH curation + owner action, an item renders legible + carries the uncapped exact action", () => {
    const deps = stubDeps({
      labelInputOverride: (id) =>
        id === "dl-88"
          ? { what: "a live GitHub token with full access to all your repos", stakes: "anyone with it can push to every repo you own" }
          : undefined,
      actionOverride: (key) =>
        key === "dl-88"
          ? "Revoke the GitHub CLI OAuth app — Settings → Applications → Authorized OAuth Apps → GitHub CLI → Revoke, then re-auth gh. (Kills the leaked token; the postprod driver then cleans the repo config + files.)"
          : undefined,
    });
    const jargon: LedgerEvent = {
      event_id: "dl-88",
      ts: "2026-07-18T11:00:00Z",
      type: "production-gate",
      thread_id: "peggy+x",
      status: "open",
      summary: "raw jargon summary that must NOT be the label",
      payload: { decision: "F1 RECONSIDER Salvatore v2" },
    };
    const items = computeMustActSet({ ...baseInputs([jargon], [jargon]), deps });
    const held = items.find((i) => i.source.event_id === "dl-88");
    expect(held).toBeDefined();
    expect(isLegibleLabel(held!.label).ok).toBe(true);
    expect(held!.label).not.toBe(jargon.summary); // anti-pass-through
    expect(held!.action).toContain("Authorized OAuth Apps");
    expect(held!.action.length).toBeGreaterThan(MAX_LABEL_CHARS); // uncapped
  });
});

// ── 4. Source → kind mapping ────────────────────────────────────────────────

describe("ledgerTypeToKind — never collapse", () => {
  it("production-gate → production-held (HALT-tier)", () => {
    expect(ledgerTypeToKind("production-gate")).toEqual({ kind: "production-held", halt_tier: true });
  });
  it("terminal-blocked → stalled-deliverable", () => {
    expect(ledgerTypeToKind("terminal-blocked")).toEqual({ kind: "stalled-deliverable", halt_tier: false });
  });
  it("operator-decision / operator-ratify → parked-decision (reversible)", () => {
    expect(ledgerTypeToKind("operator-decision")).toEqual({ kind: "parked-decision", halt_tier: false });
    expect(ledgerTypeToKind("operator-ratify")).toEqual({ kind: "parked-decision", halt_tier: false });
  });
});

// ── 7. Worth-triggers (criterion 7) ─────────────────────────────────────────

describe("detectWorthTriggers — derived rows produce the right DISTINCT kinds", () => {
  it("stalled: claimed-active but silent > 30min ⇒ stalled-deliverable (derived/stalled)", () => {
    const reg: DriverRow[] = [{ name: "podcast-drv", cell: "podcast", state: "active", last_seen: "2026-07-18T11:00:00Z", claimed_task: "the ep-9 mixdown" }];
    const out = detectWorthTriggers(reg, [], NOW, stubDeps());
    const stalled = out.find((c) => c.kind === "stalled-deliverable");
    expect(stalled?.source.derived_state).toBe("stalled");
    expect(stalled?.source.origin).toBe("derived");
  });

  it("runaway: burn > rate cap ⇒ runaway-cost (DISTINCT, never folded into stalled)", () => {
    const reg: DriverRow[] = [{ name: "research-drv", cell: "research", cost_rate_per_min: 50_000 }];
    const out = detectWorthTriggers(reg, [], NOW, stubDeps());
    expect(out.find((c) => c.kind === "runaway-cost")?.source.derived_state).toBe("runaway");
    expect(out.some((c) => c.kind === "stalled-deliverable")).toBe(false);
  });

  it("commitment-drop: open cross-tenure commitment > 24h ⇒ commitment-drop", () => {
    const reg: DriverRow[] = [{ name: "mig-drv", cell: "migration", open_commitment: { what: "the data-migration cleanup", since: "2026-07-16T00:00:00Z" } }];
    const out = detectWorthTriggers(reg, [], NOW, stubDeps());
    const drop = out.find((c) => c.kind === "commitment-drop");
    expect(drop?.input.ageDays).toBeGreaterThanOrEqual(2);
  });

  it("phantom-hold: claimed hold that never fired > 15min ⇒ phantom-hold", () => {
    const reg: DriverRow[] = [{ name: "gate-drv", cell: "release", claimed_hold: { what: "the release gate", since: "2026-07-18T11:00:00Z" } }];
    expect(detectWorthTriggers(reg, [], NOW, stubDeps()).some((c) => c.kind === "phantom-hold")).toBe(true);
  });

  it("idle-mid-task: bare shell + claimed task + idle > 20min ⇒ stalled-deliverable (derived/idle)", () => {
    const reg: DriverRow[] = [{ name: "x", cell: "cellx", claimed_task: "the build" }];
    const panes: PaneRow[] = [{ cell: "cellx", command: "bash", idle_seconds: 25 * 60 }];
    const out = detectWorthTriggers(reg, panes, NOW, stubDeps());
    expect(out.find((c) => c.source.derived_state === "idle")?.kind).toBe("stalled-deliverable");
  });

  it("all derived kinds together produce the 4 DISTINCT worth-signal kinds", () => {
    const reg: DriverRow[] = [
      { name: "a", cell: "a", state: "active", last_seen: "2026-07-18T10:00:00Z", claimed_task: "task-a" },
      { name: "b", cell: "b", cost_rate_per_min: 60_000 },
      { name: "c", cell: "c", open_commitment: { what: "cleanup-c", since: "2026-07-15T00:00:00Z" } },
      { name: "d", cell: "d", claimed_hold: { what: "hold-d", since: "2026-07-18T11:00:00Z" } },
    ];
    const kinds = new Set(detectWorthTriggers(reg, [], NOW, stubDeps()).map((c) => c.kind));
    expect(kinds).toContain("stalled-deliverable");
    expect(kinds).toContain("runaway-cost");
    expect(kinds).toContain("commitment-drop");
    expect(kinds).toContain("phantom-hold");
  });

  it("computeMustActSet threads derived items through label generation legibly", () => {
    const reg: DriverRow[] = [{ name: "b", cell: "b", cost_rate_per_min: 60_000 }];
    const items = computeMustActSet({ ...baseInputs([], []), driverRegistry: reg });
    const runaway = items.find((i) => i.kind === "runaway-cost");
    expect(runaway).toBeDefined();
    expect(isLegibleLabel(runaway!.label).ok).toBe(true);
    expect(runaway!.source.origin).toBe("derived");
  });
});
