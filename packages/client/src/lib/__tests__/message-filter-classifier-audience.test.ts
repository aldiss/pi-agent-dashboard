/**
 * message-filter-classifier — the operator-addressed audience seam (:83 fix).
 *
 * Coverage-contract #1 (the shared operator-addressed classifier). These are
 * the REAL-SEAM assertions Joan pinned: the `sessionCtx.tier` is derived by
 * running a real `DashboardSession` fixture through the ACTUAL `classifyTier`
 * (session-grouping.ts) — NOT a hand-set tier that bypasses the seam. So a
 * regression in classifyTier's spawn-source/canonical-name logic would break
 * these too.
 *
 * The :83 bug being fixed: `classifyMessage` returned `meshChatter` for EVERY
 * plain user/assistant row, so an agent's reply *to the operator* AND the
 * operator's own typed prompts were both mislabeled chatter (the "Mesh chatter"
 * toggle hid both). Now operator-addressed rows → `tierB` (visible + linted);
 * only genuinely agent-addressed (mesh-dispatched) rows → `meshChatter`.
 */

import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { classifyTier } from "../session-grouping.js";
import {
  classifyMessage,
  filterMessages,
  countMessagesByCategory,
  readAudienceStamp,
  type AudienceSessionCtx,
} from "../message-filter-classifier.js";
import type { ChatMessage } from "../event-reducer.js";
import type { ChatItem } from "../group-tool-calls.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Build a DashboardSession fixture (drives the REAL classifyTier). */
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

/** Derive sessionCtx exactly as App.tsx does: classifyTier over a real session. */
function ctxFor(overrides: Partial<DashboardSession>): AudienceSessionCtx {
  return { tier: classifyTier(session(overrides)) };
}

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", role, content, timestamp: 1, ...extra };
}

// ── the real seam: sessionCtx.tier comes THROUGH classifyTier ────────────────

describe("classifyMessage audience seam — via the REAL classifyTier", () => {
  it("operator-chat-pane session (source=tui): assistant reply → tierB (NOT meshChatter)", () => {
    const ctx = ctxFor({ source: "tui" });
    expect(ctx.tier).toBe("operator-chat-pane"); // proves the seam, not a hand-set tier
    expect(classifyMessage(msg("assistant", "here is the status"), ctx)).toBe("tierB");
  });

  it("operator-chat-pane session: the operator's own user prompt → tierB (NOT meshChatter)", () => {
    const ctx = ctxFor({ source: "tui" });
    // The second half of the :83 bug: the operator's typed prompts were chatter.
    expect(classifyMessage(msg("user", "ship it"), ctx)).toBe("tierB");
  });

  it("standing-crew session (name=Joan): assistant reply → tierB (operator-facing)", () => {
    const ctx = ctxFor({ source: "tmux", name: "Joan" });
    expect(ctx.tier).toBe("standing-crew");
    expect(classifyMessage(msg("assistant", "the gate is green 4/4"), ctx)).toBe("tierB");
  });

  it("worker session (name=subagent-worker-…): assistant reply → meshChatter (agent-addressed)", () => {
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-3f4a1b" });
    expect(ctx.tier).toBe("worker");
    expect(classifyMessage(msg("assistant", "landing dl-8567"), ctx)).toBe("meshChatter");
  });

  it("cell-executor session: assistant reply → meshChatter (mesh-dispatched)", () => {
    const ctx = ctxFor({ source: "tmux", name: "OakHawk-cell", cwd: "/home/x/.pi/cells/foo/v1" });
    expect(ctx.tier).toBe("cell-executor");
    expect(classifyMessage(msg("assistant", "internal mesh note"), ctx)).toBe("meshChatter");
  });
});

// ── stamp-at-emit wins (source of truth) over the retrospective heuristic ────

describe("stamp-at-emit is the source of truth", () => {
  it("a stamped audience:operator row → tierB even in a worker session", () => {
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-abc123" }); // tier=worker
    const stamped = msg("assistant", "operator-addressed", { audience: "operator" });
    // The stamp overrides the retrospective tier→agent mapping.
    expect(classifyMessage(stamped, ctx)).toBe("tierB");
  });

  it("a stamped audience:agent row → meshChatter even in an operator-chat-pane session", () => {
    const ctx = ctxFor({ source: "tui" }); // tier=operator-chat-pane
    const stamped = msg("assistant", "mesh note", { audience: "agent" });
    expect(classifyMessage(stamped, ctx)).toBe("meshChatter");
  });
});

// ── fail-open (§1.9): unknown / no ctx → operator-addressed (shown + linted) ──

describe("fail-open — unclassifiable rows are SHOWN, never hidden-and-unlinted", () => {
  it("no sessionCtx → operator-addressed (tierB)", () => {
    expect(classifyMessage(msg("assistant", "unknown origin"))).toBe("tierB");
    expect(classifyMessage(msg("user", "operator prompt"))).toBe("tierB");
  });

  it("tier=other (unknown source) → fail-open operator (tierB)", () => {
    const ctx = ctxFor({ source: "unknown", name: "mystery" });
    expect(ctx.tier).toBe("other");
    expect(classifyMessage(msg("assistant", "?"), ctx)).toBe("tierB");
  });

  // ── M1: a corrupt PRESENT stamp fails OPEN, even in a worker ctx ──
  it("corrupt-present stamp in a WORKER ctx → tierB (M1: fail-OPEN, not hidden)", () => {
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-abc123" }); // tier=worker
    // A corrupt present value must NOT be treated as absent (which would run the
    // worker retrospective → agent → meshChatter/hidden). It fails OPEN to shown.
    const corrupt = msg("assistant", "bad stamp", { audience: "corrupt-wire-value" as never });
    expect(classifyMessage(corrupt, ctx)).toBe("tierB");
  });

  it("absent stamp in a WORKER ctx → meshChatter (retrospective, distinct from corrupt)", () => {
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-abc123" });
    // No stamp → the retrospective worker tier applies → agent → meshChatter.
    expect(classifyMessage(msg("assistant", "no stamp"), ctx)).toBe("meshChatter");
  });
});

// ── ratified 3-state: `unknown` is SHOWN but exempt (the two axes, independent) ──

describe("ratified 3-state audience — unknown is SHOWN (visibility axis), decoupled from lint", () => {
  it("an `unknown` stamp → tierB (SHOWN), even in a worker ctx (NOT hidden as meshChatter)", () => {
    // The re-gate checks the axes INDEPENDENTLY: an unknown row must be SHOWN
    // (visibility) regardless of tier. The LINT axis (exempt) is the extension
    // Door-3's job, asserted at that seam — here we prove the classifier SHOWS it.
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-abc123" }); // tier=worker
    const unknown = msg("assistant", "headless no-name reply", { audience: "unknown" });
    expect(classifyMessage(unknown, ctx)).toBe("tierB");
  });

  it("an `unknown` user row → tierB (SHOWN) in a worker ctx", () => {
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-abc123" });
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

  it("operator-chat-pane: with meshChatter OFF, operator rows still show (the :83 fix)", () => {
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
    const ctx = ctxFor({ source: "tmux", name: "subagent-worker-deadbe" });
    const counts = countMessagesByCategory(items, ctx);
    expect(counts.meshChatter).toBe(2);
    expect(counts.tierB).toBe(0);
  });

  it("operator-chat-pane: the same rows count as tierB, not meshChatter", () => {
    const ctx = ctxFor({ source: "tui" });
    const counts = countMessagesByCategory(items, ctx);
    expect(counts.tierB).toBe(2);
    expect(counts.meshChatter).toBe(0);
  });
});
