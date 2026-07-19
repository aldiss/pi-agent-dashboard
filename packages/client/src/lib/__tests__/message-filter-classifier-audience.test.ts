/**
 * message-filter-classifier — the operator-addressed audience seam (:83 fix + B2).
 *
 * Coverage-contract #1 (the shared operator-addressed classifier). B2 rebases the
 * PRE-STAMP retrospective on POSITIVE persisted-at-the-time evidence
 * (`deriveHistoricalEvidence`: sessionFile / cwd / source) — NOT `classifyTier`
 * (which reads today's registry + the standing-crew NAME regex, the Sol F4/G3
 * leak). These assertions run a real `DashboardSession` fixture through
 * `deriveHistoricalEvidence` (exactly as App.tsx does) so a regression in the
 * evidence projection breaks them too. Absent positive evidence → `unknown`
 * (SHOWN + exempt), never a registry guess and never hidden.
 *
 * The :83 bug being fixed: `classifyMessage` returned `meshChatter` for EVERY
 * plain user/assistant row, so an agent's reply *to the operator* AND the
 * operator's own typed prompts were both mislabeled chatter (the "Mesh chatter"
 * toggle hid both). Now operator-addressed rows → `tierB` (visible + linted);
 * only genuinely agent-addressed (mesh-dispatched) rows → `meshChatter`.
 */

import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  classifyMessage,
  filterMessages,
  countMessagesByCategory,
  readAudienceStamp,
  deriveHistoricalEvidence,
  historicalAudience,
  type AudienceSessionCtx,
} from "../message-filter-classifier.js";
import type { ChatMessage } from "../event-reducer.js";
import type { ChatItem } from "../group-tool-calls.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Build a DashboardSession fixture (drives the REAL evidence projection). */
function session(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1",
    cwd: "/repo",
    source: "tui",
    status: "active",
    startedAt: 1_000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  } as DashboardSession;
}

/** Derive sessionCtx exactly as App.tsx does: positive evidence off a real session (B2). */
function ctxFor(overrides: Partial<DashboardSession>): AudienceSessionCtx {
  return { evidence: deriveHistoricalEvidence(session(overrides)) };
}

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", role, content, timestamp: 1, ...extra };
}

// ── the real seam: sessionCtx.evidence comes THROUGH deriveHistoricalEvidence ──

describe("classifyMessage audience seam — via the REAL positive-evidence projection (B2)", () => {
  it("operator pane (source=tui): assistant reply → tierB (NOT meshChatter)", () => {
    const ctx = ctxFor({ source: "tui" });
    expect(historicalAudience(ctx.evidence)).toBe("operator"); // proves the seam
    expect(classifyMessage(msg("assistant", "here is the status"), ctx)).toBe("tierB");
  });

  it("operator pane: the operator's own user prompt → tierB (NOT meshChatter)", () => {
    const ctx = ctxFor({ source: "tui" });
    // The second half of the :83 bug: the operator's typed prompts were chatter.
    expect(classifyMessage(msg("user", "ship it"), ctx)).toBe("tierB");
  });

  it("a non-tui session with NO worker/cell evidence → unknown → tierB (SHOWN, not a name guess)", () => {
    // B2: a tmux session named `Joan` is NOT retro-classified operator by a NAME
    // regory (that would be today's registry leaking in). No positive evidence →
    // `unknown` → SHOWN (tierB), never hidden. The FORWARD stamp (B3) handles the
    // live operator/agent decision going forward.
    const ctx = ctxFor({ source: "tmux", name: "Joan" });
    expect(historicalAudience(ctx.evidence)).toBe("unknown");
    expect(classifyMessage(msg("assistant", "the gate is green 4/4"), ctx)).toBe("tierB");
  });

  it("worker session (sessionFile …/run-N/session.jsonl): assistant reply → meshChatter (positive evidence)", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/home/x/.pi/agent/sessions/run-7/session.jsonl" });
    expect(historicalAudience(ctx.evidence)).toBe("agent");
    expect(classifyMessage(msg("assistant", "landing dl-8567"), ctx)).toBe("meshChatter");
  });

  it("cell-executor session (cwd …/.pi/cells/…): assistant reply → meshChatter (positive evidence)", () => {
    const ctx = ctxFor({ source: "tmux", cwd: "/home/x/.pi/cells/foo/v1" });
    expect(historicalAudience(ctx.evidence)).toBe("agent");
    expect(classifyMessage(msg("assistant", "internal mesh note"), ctx)).toBe("meshChatter");
  });
});

// ── stamp-at-emit wins (source of truth) over the retrospective heuristic ────

describe("stamp-at-emit is the source of truth", () => {
  it("a stamped audience:operator row → tierB even in a worker session", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-3/session.jsonl" }); // evidence=worker
    const stamped = msg("assistant", "operator-addressed", { audience: "operator" });
    // The stamp overrides the retrospective evidence→agent mapping.
    expect(classifyMessage(stamped, ctx)).toBe("tierB");
  });

  it("a stamped audience:agent row → meshChatter even in an operator pane session", () => {
    const ctx = ctxFor({ source: "tui" }); // evidence=operator
    const stamped = msg("assistant", "mesh note", { audience: "agent" });
    expect(classifyMessage(stamped, ctx)).toBe("meshChatter");
  });
});

// ── ratified 3-state (§1.9): unknown / no evidence → SHOWN, never hidden ──────

describe("absent-evidence + unclassifiable rows are SHOWN, never hidden", () => {
  it("no sessionCtx → unknown → tierB (SHOWN)", () => {
    expect(classifyMessage(msg("assistant", "unknown origin"))).toBe("tierB");
    expect(classifyMessage(msg("user", "operator prompt"))).toBe("tierB");
  });

  it("evidence present but no positive signal (source=unknown) → unknown → tierB (SHOWN)", () => {
    const ctx = ctxFor({ source: "unknown", name: "mystery" });
    expect(historicalAudience(ctx.evidence)).toBe("unknown");
    expect(classifyMessage(msg("assistant", "?"), ctx)).toBe("tierB");
  });

  // ── M1: a corrupt PRESENT stamp fails OPEN, even in a worker ctx ──
  it("corrupt-present stamp in a WORKER ctx → tierB (M1: fail-OPEN, not hidden)", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-9/session.jsonl" }); // evidence=worker
    // A corrupt present value must NOT be treated as absent (which would run the
    // worker retrospective → agent → meshChatter/hidden). It fails OPEN to shown.
    const corrupt = msg("assistant", "bad stamp", { audience: "corrupt-wire-value" as never });
    expect(classifyMessage(corrupt, ctx)).toBe("tierB");
  });

  it("absent stamp in a WORKER ctx → meshChatter (retrospective positive evidence)", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-9/session.jsonl" });
    // No stamp → the worker positive evidence applies → agent → meshChatter.
    expect(classifyMessage(msg("assistant", "no stamp"), ctx)).toBe("meshChatter");
  });
});

// ── ratified 3-state: `unknown` is SHOWN but exempt (the two axes, independent) ──

describe("ratified 3-state audience — unknown is SHOWN (visibility axis), decoupled from lint", () => {
  it("an `unknown` stamp → tierB (SHOWN), even in a worker ctx (NOT hidden as meshChatter)", () => {
    // The re-gate checks the axes INDEPENDENTLY: an unknown row must be SHOWN
    // (visibility) regardless of evidence. The LINT axis (exempt) is the extension
    // Door-3's job, asserted at that seam — here we prove the classifier SHOWS it.
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-9/session.jsonl" }); // evidence=worker
    const unknown = msg("assistant", "headless no-name reply", { audience: "unknown" });
    expect(classifyMessage(unknown, ctx)).toBe("tierB");
  });

  it("an `unknown` user row → tierB (SHOWN) in a worker ctx", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-9/session.jsonl" });
    expect(classifyMessage(msg("user", "unknown-origin prompt", { audience: "unknown" }), ctx)).toBe("tierB");
  });

  it("a null (corrupt-present) stamp read → SHOWN, distinct from absent (readAudienceStamp)", () => {
    // Sol F2: `null` is a present wire value → corrupt (shown), NOT absent (which
    // would hide in a worker ctx). readAudienceStamp splits them: only `undefined`
    // is absent.
    expect(readAudienceStamp(null).state).toBe("corrupt");
    expect(readAudienceStamp(undefined).state).toBe("absent");
    expect(readAudienceStamp("unknown").state).toBe("unknown");
    expect(readAudienceStamp("operator")).toEqual({ state: "valid", value: "operator" });
  });
});

// ── projection: the toggle keeps the operator conversation; hides mesh ───────

describe("filterMessages / countMessagesByCategory thread sessionCtx", () => {
  const items: ChatItem[] = [
    msg("user", "operator prompt", { id: "u1" }),
    msg("assistant", "operator reply", { id: "a1" }),
  ];

  it("operator pane: with meshChatter OFF, operator rows still show (the :83 fix)", () => {
    const ctx = ctxFor({ source: "tui" });
    const filter = {
      tierA: true, tierB: true, tierC: true,
      meshChatter: false, toolCalls: true, systemNotifications: true,
    };
    const visible = filterMessages(items, filter, { sessionCtx: ctx });
    // Both operator rows survive a meshChatter:false toggle (they are tierB now).
    expect(visible).toHaveLength(2);
  });

  it("worker session: the same rows count as meshChatter (hidden when toggled off)", () => {
    const ctx = ctxFor({ source: "tmux", sessionFile: "/x/run-2/session.jsonl" });
    const counts = countMessagesByCategory(items, ctx);
    expect(counts.meshChatter).toBe(2);
    expect(counts.tierB).toBe(0);
  });

  it("operator pane: the same rows count as tierB, not meshChatter", () => {
    const ctx = ctxFor({ source: "tui" });
    const counts = countMessagesByCategory(items, ctx);
    expect(counts.tierB).toBe(2);
    expect(counts.meshChatter).toBe(0);
  });
});
