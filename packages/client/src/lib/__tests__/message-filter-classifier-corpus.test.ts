/**
 * message-filter-classifier-corpus.test.ts — B2/M6 the LABELED classifier corpus.
 *
 * The ratified v3 floor (BUILD-PLAN-1 `6c2a0e34:46-47,60-65`) requires a LABELED
 * corpus from real session shapes as the shared classifier's OWN gate, enumerating
 * — across BOTH the visibility axis (shown vs hide-eligible) AND the toggle/PWA
 * projection — the producer-labeled cases the earlier corpus dropped:
 *
 *   operator pane · standing-crew (no evidence → unknown/shown) · worker (pre-stamp
 *   history) · cell-executor · named-miss · truly-unknown · partial/stale registry
 *   (a live `unknown` stamp) · and the Mesh-chatter TOGGLE hiding internal chatter
 *   while KEEPING operator-addressed replies (the same `filterMessages` path the
 *   desktop + PWA/mobile ChatView share — App.tsx renders ONE ChatView for both).
 *
 * Each row is LABELED with its expected `category` (visibility) + `shownWhenMeshOff`
 * (the toggle projection). B2: the PRE-STAMP retrospective reads persisted-at-the-
 * time POSITIVE evidence (sessionFile / cwd / source), never today's registry;
 * absent positive evidence → `unknown` (SHOWN + exempt), never hidden.
 */

import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  classifyMessage,
  filterMessages,
  deriveHistoricalEvidence,
  type AudienceSessionCtx,
  type MessageCategory,
} from "../message-filter-classifier.js";
import type { ChatMessage } from "../event-reducer.js";
import type { ChatItem } from "../group-tool-calls.js";

function session(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1", cwd: "/repo", source: "tui", status: "active",
    startedAt: 1_000, tokensIn: 0, tokensOut: 0, cost: 0, ...overrides,
  } as DashboardSession;
}
function ctxFor(overrides: Partial<DashboardSession>): AudienceSessionCtx {
  return { evidence: deriveHistoricalEvidence(session(overrides)) };
}
function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", role, content, timestamp: 1, ...extra };
}

const MESH_OFF = {
  tierA: true, tierB: true, tierC: true,
  meshChatter: false, toolCalls: true, systemNotifications: true,
};

/**
 * One labeled corpus row: a producer-labeled session shape + a row, with the
 * EXPECTED visibility category AND whether it survives the Mesh-chatter toggle.
 */
interface CorpusCase {
  label: string;
  ctx?: AudienceSessionCtx;
  row: ChatMessage;
  category: MessageCategory;
  /** Whether the row is still SHOWN with the Mesh-chatter toggle OFF. */
  shownWhenMeshOff: boolean;
}

const CORPUS: CorpusCase[] = [
  // ── operator pane (source=tui) — SHOWN, kept when mesh is off ──────────────
  {
    label: "operator pane · assistant reply (pre-stamp) → tierB, kept",
    ctx: ctxFor({ source: "tui" }),
    row: msg("assistant", "here is the status"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  {
    label: "operator pane · operator's own user prompt (pre-stamp) → tierB, kept",
    ctx: ctxFor({ source: "tui" }),
    row: msg("user", "ship it"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  // ── standing-crew by NAME but tmux, no positive evidence → unknown/SHOWN ────
  {
    label: "standing-crew name (tmux, no evidence) pre-stamp → unknown → tierB, kept (no registry guess)",
    ctx: ctxFor({ source: "tmux", name: "Joan" }),
    row: msg("assistant", "the gate is green 4/4"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  // ── worker (pre-stamp history) — positive evidence → meshChatter, hidden ───
  {
    label: "worker session path (…/run-N/session.jsonl) pre-stamp → meshChatter, hidden",
    ctx: ctxFor({ source: "tmux", sessionFile: "/home/x/.pi/agent/sessions/run-7/session.jsonl" }),
    row: msg("assistant", "landing dl-8567"),
    category: "meshChatter",
    shownWhenMeshOff: false,
  },
  {
    label: "worker session · injected user dispatch brief (pre-stamp) → meshChatter, hidden",
    ctx: ctxFor({ source: "tmux", sessionFile: "/home/x/.pi/agent/sessions/run-7/session.jsonl" }),
    row: msg("user", "dispatch brief dl-1"),
    category: "meshChatter",
    shownWhenMeshOff: false,
  },
  // ── cell-executor — positive evidence (cwd) → meshChatter, hidden ──────────
  {
    label: "cell-executor cwd (…/.pi/cells/…) pre-stamp → meshChatter, hidden",
    ctx: ctxFor({ source: "tmux", cwd: "/home/x/.pi/cells/foo/v1" }),
    row: msg("assistant", "internal mesh note"),
    category: "meshChatter",
    shownWhenMeshOff: false,
  },
  // ── named-miss / truly-unknown — no positive evidence → unknown/SHOWN ──────
  {
    label: "named-miss (tmux, arbitrary name, no evidence) → unknown → tierB, kept",
    ctx: ctxFor({ source: "tmux", name: "someRandomSpawn" }),
    row: msg("assistant", "who am I"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  {
    label: "truly-unknown (source=unknown, no evidence) → unknown → tierB, kept",
    ctx: ctxFor({ source: "unknown", name: "mystery" }),
    row: msg("assistant", "?"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  {
    label: "no sessionCtx at all → unknown → tierB, kept",
    ctx: undefined,
    row: msg("assistant", "no context"),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  // ── live STAMP is authoritative (source of truth), overrides evidence ──────
  {
    label: "LIVE operator stamp in a worker ctx → tierB, kept (stamp wins)",
    ctx: ctxFor({ source: "tmux", sessionFile: "/x/run-3/session.jsonl" }),
    row: msg("assistant", "operator-addressed", { audience: "operator" }),
    category: "tierB",
    shownWhenMeshOff: true,
  },
  {
    label: "LIVE agent stamp in an operator pane → meshChatter, hidden (stamp wins)",
    ctx: ctxFor({ source: "tui" }),
    row: msg("assistant", "mesh note", { audience: "agent" }),
    category: "meshChatter",
    shownWhenMeshOff: false,
  },
  // ── partial/stale registry surfaces as a live `unknown` stamp → SHOWN ──────
  {
    label: "partial/stale registry → live `unknown` stamp → tierB, kept (SHOWN + exempt, never hidden)",
    ctx: ctxFor({ source: "tmux", sessionFile: "/x/run-3/session.jsonl" }), // worker evidence…
    row: msg("assistant", "text under a partial registry", { audience: "unknown" }), // …but stamp=unknown wins → shown
    category: "tierB",
    shownWhenMeshOff: true,
  },
];

describe("B2/M6 — the labeled classifier corpus (visibility axis)", () => {
  for (const c of CORPUS) {
    it(`${c.label}`, () => {
      expect(classifyMessage(c.row, c.ctx)).toBe(c.category);
    });
  }
});

describe("B2/M6 — Mesh-chatter TOGGLE + PWA acceptance (shared desktop/PWA filterMessages path)", () => {
  for (const c of CORPUS) {
    it(`toggle OFF keeps=${c.shownWhenMeshOff}: ${c.label}`, () => {
      const items: ChatItem[] = [c.row];
      const visible = filterMessages(items, MESH_OFF, c.ctx ? { sessionCtx: c.ctx } : undefined);
      expect(visible.length === 1).toBe(c.shownWhenMeshOff);
    });
  }

  it("the toggle KEEPS operator-addressed replies while HIDING mesh chatter in a mixed feed", () => {
    // The ratified acceptance (`6c2a0e34:60-65`): meshChatter OFF hides internal
    // chatter but retains the operator-addressed conversation. This is the SAME
    // `filterMessages` path App.tsx renders for BOTH desktop and PWA/mobile (one
    // ChatView instance), so the acceptance holds on both form factors.
    const opCtx = ctxFor({ source: "tui" });
    const feed: ChatItem[] = [
      msg("user", "operator prompt", { id: "u1" }), // operator pane → tierB
      msg("assistant", "operator reply", { id: "a1" }), // operator pane → tierB
      msg("assistant", "mesh dispatch note", { id: "a2", audience: "agent" }), // stamped agent → meshChatter
    ];
    const visible = filterMessages(feed, MESH_OFF, { sessionCtx: opCtx });
    const ids = visible.map((v) => (v as ChatMessage).id);
    expect(ids).toContain("u1"); // operator prompt kept
    expect(ids).toContain("a1"); // operator reply kept
    expect(ids).not.toContain("a2"); // mesh chatter hidden
  });
});
