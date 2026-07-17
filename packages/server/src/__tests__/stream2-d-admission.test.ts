/**
 * Stream-2 D red-arm suite — the bounded 2-operator cell (N=2 admission) +
 * intersection permission model + agent-as-presence + det-spawn-inherit.
 *
 * Every case is RED-ARM: it is GREEN on the shipped code, and the block header
 * names the exact one-line PLANT that turns it RED (a green-that-can't-go-red is
 * a vacuous pass). The plants were each run RED own-hand; the evidence paths are
 * in `_build/bastion-D-slice-cc-report-2026-07-09.md`.
 *
 * These drive the REAL production seams — no re-implemented logic:
 *   - `authorizeSessionAction`  (the ONE chokepoint — admission + per-action)
 *   - `authorizeWsMessage`      (the WS arm)
 *   - `makeRestSessionGate`     (the REST arm)
 *   - `createOperatorSetTracker`(the cell state)
 *   - `getAgentPresence` + `configureAgentPresence` (the presence D-filler)
 *
 * Pure / gate-level by design (deterministic — no real-server SIGTERM-timing
 * flakiness): the cell is a pure Set primitive, the chokepoint a pure function,
 * and both gate arms call the chokepoint with the SAME threaded cell, so a
 * gate-level drive exercises the identical production path a socket would.
 *
 * Contract-3: this file + the D authz/session-state hunks are the whole diff —
 * it touches NO message-flow / author / attribution / reconciliation code.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  authorizeSessionAction,
  type AuthorizeSessionActionInput,
} from "../session-authz.js";
import { authorizeWsMessage } from "../ws-session-gate.js";
import { makeRestSessionGate } from "../rest-session-gate.js";
import { createOperatorSetTracker, OPERATOR_CELL_LIMIT } from "../operator-set-tracker.js";
import {
  getAgentPresence,
  configureAgentPresence,
  resetAgentPresence,
} from "../agent-presence.js";
import { handleSendPrompt } from "../browser-handlers/session-action-handler.js";
import { createBrowserGateway } from "../browser-gateway.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createMemoryEventStore } from "../memory-event-store.js";
import type { PiGateway } from "../pi-gateway.js";
import type { TokenPayload } from "../auth.js";
import type { BrowserHandlerContext } from "../browser-handlers/handler-context.js";
import type { SessionStatus } from "@blackbelt-technology/pi-dashboard-shared/types.js";

// ── Principal fixtures (distinct sub A/B/C — NOT live identity values) ────────
const OP1 = { sub: "op1@example.com", name: "Op One", username: "op1", provider: "github", exp: 0 } as unknown as TokenPayload;
const OP2 = { sub: "op2@example.com", name: "Op Two", username: "op2", provider: "github", exp: 0 } as unknown as TokenPayload;
const OP3 = { sub: "op3@example.com", name: "Op Three", username: "op3", provider: "github", exp: 0 } as unknown as TokenPayload;

/** A fake WS handler-context threading a given cell + principal. */
function wsCtx(
  principal: TokenPayload | null,
  operatorSet: ReturnType<typeof createOperatorSetTracker>,
  operatorUsers?: string[],
): BrowserHandlerContext {
  return {
    principal,
    requireBrowserAuth: true,
    operatorSet,
    ...(operatorUsers ? { operatorUsers } : {}),
    sessionManager: { get: () => undefined },
  } as unknown as BrowserHandlerContext;
}

/** Drive the REST session-gate preHandler; return the reply code (undefined = allowed). */
async function restVerdict(
  gateAction: string,
  principal: TokenPayload | null,
  sessionId: string,
  operatorSet: ReturnType<typeof createOperatorSetTracker>,
  operatorUsers?: string[],
): Promise<number | undefined> {
  const gate = makeRestSessionGate({
    requireBrowserAuth: true,
    operatorSet,
    ...(operatorUsers ? { operatorUsers } : {}),
  });
  const preHandler = gate(gateAction as any);
  let code: number | undefined;
  const request = {
    params: { id: sessionId },
    // The REST arm derives the actor from restActorKind/restPrincipal (never the body).
    restActorKind: principal ? "human" : null,
    restPrincipal: principal,
  } as any;
  const reply = {
    code(c: number) { code = c; return this; },
    send() { return this; },
  } as any;
  await preHandler(request, reply);
  return code;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1 — N=2 admission (WS): 2 distinct subs admitted; 3rd REFUSED; two TABS
// of the SAME sub do NOT trip the cap (distinct-sub dedup, NOT per-connection).
//
// RED-ARM: in `operator-set-tracker.ts#commit`, count by connection instead of
// sub — make `commit` add a per-connection-unique key (drop the Set-by-`sub`
// dedup). Then op1's 2nd tab fills the cell and op2 is REFUSED → assertions bite.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 1 — N=2 admission over the WS arm (distinct-sub, tabs deduped)", () => {
  const SID = "sWs1";
  const abortMsg = (sessionId: string) => ({ type: "abort", sessionId }) as any;

  it("admits 2 distinct subs, REFUSES the 3rd distinct sub (session-full)", () => {
    const cell = createOperatorSetTracker();
    // op1 admitted (co-drive `abort` → admission runs, per-action passes)
    expect(authorizeWsMessage(abortMsg(SID), wsCtx(OP1, cell)).allowed).toBe(true);
    // op2 admitted (2nd distinct sub, slot free)
    expect(authorizeWsMessage(abortMsg(SID), wsCtx(OP2, cell)).allowed).toBe(true);
    // op3 = 3rd distinct sub → REFUSED at admission
    const d3 = authorizeWsMessage(abortMsg(SID), wsCtx(OP3, cell));
    expect(d3.allowed).toBe(false);
    expect(d3.reason).toBe("session-full");
    expect(cell.count(SID)).toBe(OPERATOR_CELL_LIMIT);
  });

  it("two TABS of the SAME sub are ONE operator (dedup — does NOT exhaust the cell)", () => {
    const cell = createOperatorSetTracker();
    // op1 drives from TWO tabs (two calls, same sub) — must consume ONE slot.
    expect(authorizeWsMessage(abortMsg(SID), wsCtx(OP1, cell)).allowed).toBe(true);
    expect(authorizeWsMessage(abortMsg(SID), wsCtx(OP1, cell)).allowed).toBe(true);
    expect(cell.count(SID)).toBe(1); // ← RED under per-connection counting (would be 2)
    // A DISTINCT 2nd human still fits (cell not exhausted by op1's 2nd tab).
    expect(authorizeWsMessage(abortMsg(SID), wsCtx(OP2, cell)).allowed).toBe(true);
    expect(cell.count(SID)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2 — N=2 admission (REST): the 3rd distinct sub is refused via the REST
// path too (a 3rd user who learned a sessionId cannot drive via REST).
//
// RED-ARM: enforce N=2 only on the WS connection — pass NO `operatorSet` into
// `makeRestSessionGate` (drop `operatorSet` from the RestGatePolicy wiring). The
// REST gate then skips admission → the 3rd user's REST co-drive is ALLOWED (403
// expectation fails).
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 2 — N=2 admission over the REST arm (no connection-only bypass)", () => {
  const SID = "sRest2";

  it("REFUSES the 3rd distinct sub on the REST co-drive path (403 session-full)", async () => {
    const cell = createOperatorSetTracker();
    // op1 + op2 admitted via REST co-drive (`abort`).
    expect(await restVerdict("abort", OP1, SID, cell)).toBeUndefined();
    expect(await restVerdict("abort", OP2, SID, cell)).toBeUndefined();
    // op3 = 3rd distinct sub over REST → 403 (session-full), same cell.
    expect(await restVerdict("abort", OP3, SID, cell)).toBe(403);
    expect(cell.count(SID)).toBe(OPERATOR_CELL_LIMIT);
  });

  it("the SAME cell binds WS + REST (a WS-admitted pair refuses a REST 3rd)", async () => {
    const cell = createOperatorSetTracker();
    // Two distinct humans admitted over WS…
    expect(authorizeWsMessage({ type: "abort", sessionId: SID } as any, wsCtx(OP1, cell)).allowed).toBe(true);
    expect(authorizeWsMessage({ type: "abort", sessionId: SID } as any, wsCtx(OP2, cell)).allowed).toBe(true);
    // …the 3rd, arriving over REST, is refused by the SHARED cell.
    expect(await restVerdict("abort", OP3, SID, cell)).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3 — Composition order: a 3rd user is refused at ADMISSION *before* any
// per-action check; a MEMBER op-2 is refused an operator-only action but ALLOWED
// a co-drive action.
//
// RED-ARM: in `authorizeSessionAction`, move the admission block to AFTER the
// operator-only enforcement. Then a NON-MEMBER 3rd user attempting an
// operator-only action gets the per-action verdict (`operator-only`) instead of
// the admission verdict (`session-full`) → the reason assertion bites.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 3 — composition order (admission FIRST, then per-action)", () => {
  const SID = "sComp3";
  const OPS = ["op1@example.com"]; // op-1 is THE operator; op-2 is a bounded member.

  it("a 3rd NON-MEMBER is refused at ADMISSION (session-full), not per-action", () => {
    const cell = createOperatorSetTracker();
    // Fill the cell with op1 + op2 (both members).
    authorizeSessionAction({ actor: { kind: "human", principal: OP1 }, action: "abort", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell });
    authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "abort", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell });
    // op3 attempts an OPERATOR-ONLY action. Admission-first ⇒ session-full
    // (NOT operator-only — they never reach the per-action check).
    const d = authorizeSessionAction({ actor: { kind: "human", principal: OP3 }, action: "shutdown", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("session-full"); // ← RED if per-action runs first (would be "operator-only")
  });

  it("a MEMBER op-2 passes admission, then is refused operator-only but ALLOWED co-drive", () => {
    const cell = createOperatorSetTracker();
    const base = (action: string, principal: TokenPayload): AuthorizeSessionActionInput => ({
      actor: { kind: "human", principal }, action, requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell,
    });
    // op1 (operator) + op2 (member) both admitted.
    expect(authorizeSessionAction(base("abort", OP1)).allowed).toBe(true);
    // op2 co-drive → ALLOWED (member, co-drive class).
    expect(authorizeSessionAction(base("abort", OP2)).allowed).toBe(true);
    // op2 operator-only → REFUSED at the per-action check (member, but not operator).
    const opOnly = authorizeSessionAction(base("shutdown", OP2));
    expect(opOnly.allowed).toBe(false);
    expect(opOnly.reason).toBe("operator-only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4 — Intersection (vs union): the shared agent / op-2 acts with the
// INTERSECTION = an action permitted for op-1 but NOT op-2 is REFUSED for op-2.
// C's model reduces intersection to "op-2 bounded to co-drive"; the guard is
// that this stays intersection, never union.
//
// RED-ARM: flip the resolution to UNION — in `authorizeSessionAction`, let a
// member human satisfy operator-only when ANY operator is configured (e.g. skip
// the `isOperator(actor.principal,…)` check for an admitted member). Then op-2's
// operator-only action PASSES → the refusal assertion bites (a security
// regression: union would REVERSE C's op-2 enforcement).
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 4 — intersection permission (LOCKED to intersection, never union)", () => {
  const SID = "sInt4";
  const OPS = ["op1@example.com"];

  it("op-2 (member) is REFUSED an op-1-only action (intersection, not union)", () => {
    const cell = createOperatorSetTracker();
    const input = (action: string, principal: TokenPayload): AuthorizeSessionActionInput => ({
      actor: { kind: "human", principal }, action, requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell,
    });
    // op-1 CAN shutdown (operator).
    expect(authorizeSessionAction(input("shutdown", OP1)).allowed).toBe(true);
    // op-2 becomes a genuine COMMITTED member via a prior co-drive (send_prompt
    // allowed → committed). This makes the union red-arm faithful under
    // check-then-commit: op-2 IS a cell member when it then attempts
    // operator-only, so a union bug (`isMember` ⇒ inherit operator-only) WOULD
    // leak — intersection must still REFUSE.
    expect(authorizeSessionAction(input("send_prompt", OP2)).allowed).toBe(true);
    expect(cell.isMember(SID, OP2.sub)).toBe(true);
    // op-2 (admitted member) CANNOT shutdown — intersection bounds them to co-drive.
    const d = authorizeSessionAction(input("shutdown", OP2));
    expect(d.allowed).toBe(false); // ← RED under union (op-2 would inherit op-1's operator-only)
    expect(d.reason).toBe("operator-only");
    // …but op-2 CAN co-drive (the intersection floor).
    expect(authorizeSessionAction(input("send_prompt", OP2)).allowed).toBe(true);
  });

  it("the shared AGENT (a service actor) likewise cannot exceed co-drive", () => {
    const cell = createOperatorSetTracker();
    // A service actor (the agent / a future det-spawn producer) on operator-only.
    const d = authorizeSessionAction({ actor: { kind: "service", id: "agent" }, action: "shutdown", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("operator-only");
    // …but co-drive is fine (the agent can drive prompts).
    expect(authorizeSessionAction({ actor: { kind: "service", id: "agent" }, action: "send_prompt", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell }).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5 — det-spawn-inherit NOT foreclosed: a `service{id}` actor rides the
// SAME chokepoint, (correctly) cannot satisfy operator-only, and N=2 admission
// does NOT break the service path (service is NOT admission-counted).
//
// RED-ARM: special-case the service actor OUT of the chokepoint — in
// `authorizeSessionAction`, `if (actor.kind === "service") return {allowed:true}`
// at the top. Then a service actor PASSES an operator-only action → the refusal
// assertion bites (the inherit path diverges: infra could satisfy operator-only).
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 5 — det-spawn-inherit (service rides the chokepoint, not admission-counted)", () => {
  const SID = "sDet5";
  const OPS = ["op1@example.com"];
  const svc = (action: string): AuthorizeSessionActionInput => ({
    actor: { kind: "service", id: "det-spawn" }, action, requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID,
  });

  it("a service actor CANNOT satisfy operator-only (infra, not an operator)", () => {
    const cell = createOperatorSetTracker();
    const d = authorizeSessionAction({ ...svc("shutdown"), operatorSet: cell });
    expect(d.allowed).toBe(false); // ← RED if service is short-circuited allowed
    expect(d.reason).toBe("operator-only");
  });

  it("a service actor is NOT admission-counted (bypasses N=2; humans keep both slots)", () => {
    const cell = createOperatorSetTracker();
    // A service co-drive does NOT consume a human slot.
    expect(authorizeSessionAction({ ...svc("send_prompt"), operatorSet: cell }).allowed).toBe(true);
    expect(cell.count(SID)).toBe(0); // service never entered the cell
    // BOTH human slots remain available after the service action.
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP1 }, action: "abort", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell }).allowed).toBe(true);
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "abort", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell }).allowed).toBe(true);
    expect(cell.count(SID)).toBe(2);
    // The 3rd distinct human is still the one refused (service didn't take a slot).
    const d3 = authorizeSessionAction({ actor: { kind: "human", principal: OP3 }, action: "abort", requireBrowserAuth: true, operatorUsers: OPS, sessionId: SID, operatorSet: cell });
    expect(d3.reason).toBe("session-full");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 6 — Flag-OFF byte-unchanged: with the flag OFF, N=2 + operatorSet +
// intersection are all INERT → the single-op path is identical (allow).
//
// RED-ARM: make admission fire while the flag is off — in
// `authorizeSessionAction`, move the admission block ABOVE the
// `if (!requireBrowserAuth) return {allowed:true}` early-return. Then a
// single-operator 3rd write is refused session-full → the flag-off allow bites.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 6 — flag-OFF byte-unchanged (admission/cell/intersection inert)", () => {
  const SID = "sOff6";

  it("flag OFF → every actor is allowed, the cell is NEVER touched (no admission)", () => {
    const cell = createOperatorSetTracker();
    // Three distinct humans + an operator-only action, flag OFF → all allowed.
    for (const p of [OP1, OP2, OP3]) {
      const d = authorizeSessionAction({ actor: { kind: "human", principal: p }, action: "shutdown", requireBrowserAuth: false, sessionId: SID, operatorSet: cell });
      expect(d.allowed).toBe(true);
    }
    // The cell was never consulted/mutated while the flag is off.
    expect(cell.count(SID)).toBe(0); // ← RED if admission fires flag-off (would be 2)
  });

  it("flag OFF → the WS arm passes co-drive through with the cell untouched", () => {
    const cell = createOperatorSetTracker();
    const offCtx = { principal: OP1, requireBrowserAuth: false, operatorSet: cell, sessionManager: { get: () => undefined } } as unknown as BrowserHandlerContext;
    const d = authorizeWsMessage({ type: "abort", sessionId: SID } as any, offCtx);
    expect(d.allowed).toBe(true);
    expect(cell.count(SID)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 7 (3.3) — Agent-as-presence: getAgentPresence resolves a live agent
// participant, null for an ended/unknown session, and stays the B-era NO-OP when
// unconfigured (flag-off byte-unchanged).
//
// RED-ARM: make `getAgentPresence` ignore the `status === "ended"` guard (return
// a participant for any known session). Then the ended-session case yields a
// participant → the `toBeNull()` assertion bites (a dead agent shown present).
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 7 — agent-as-presence (live-agent signal, flag-gated NO-OP)", () => {
  afterEach(() => resetAgentPresence());

  it("unconfigured (flag off) → NO-OP null for every session (byte-unchanged)", () => {
    resetAgentPresence();
    expect(getAgentPresence("anything")).toBeNull();
  });

  it("configured → a LIVE session yields an agent participant; ENDED/unknown → null", () => {
    const sessions: Record<string, { status: SessionStatus; name?: string }> = {
      live: { status: "active", name: "Athena" },
      quiet: { status: "idle" },
      dead: { status: "ended", name: "Zombie" },
    };
    configureAgentPresence((id) => sessions[id] ?? null);
    // Live agent → participant, kind:"agent", namespaced id, display = name.
    expect(getAgentPresence("live")).toEqual({ id: "agent:live", kind: "agent", display: "Athena" });
    // Live but unnamed → stable generic display.
    expect(getAgentPresence("quiet")).toEqual({ id: "agent:quiet", kind: "agent", display: "agent" });
    // ENDED session → no live agent → null (← RED if the ended-guard is dropped).
    expect(getAgentPresence("dead")).toBeNull();
    // Unknown session → null.
    expect(getAgentPresence("ghost")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 8 (fix-1 BLOCKER-1) — N=2 admission on the SELF-GATED `send_prompt`
// co-drive path, driven THROUGH the real `handleSendPrompt` seam (NOT `abort`).
// This is the coverage gap that hid the blocker: `send_prompt` bypasses the
// central `authorizeWsMessage`, so the admission threading lives at
// `session-action-handler.ts:236` — this exercises THAT call.
//
// RED-ARM: revert the :236 threading (drop `sessionId`/`operatorSet` from the
// send_prompt `authorizeSessionAction`). Then co-drive send_prompts never
// populate the cell AND a 3rd sub's send_prompt reaches the bridge → the
// "cell fills to 2" + "3rd refused, no forward" assertions bite.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 8 — N=2 admission on the send_prompt co-drive path (handleSendPrompt seam)", () => {
  const SID = "sSend8";

  /** Drive the REAL handleSendPrompt with a shared cell; capture forward + reply. */
  async function sendPrompt(
    principal: TokenPayload,
    operatorSet: ReturnType<typeof createOperatorSetTracker>,
    opts?: { queueNonce?: string },
  ): Promise<{ forwarded: any[]; sent: any[] }> {
    const forwarded: any[] = [];
    const sent: any[] = [];
    const ctx = {
      ws: { readyState: 1, OPEN: 1, bufferedAmount: 0 } as any,
      // A LIVE session (status:"streaming") so the ended→resume branch is not taken.
      sessionManager: { get: vi.fn(() => ({ sessionId: SID, status: "streaming", cwd: "/tmp", sessionFile: "/tmp/s.jsonl" })), update: vi.fn() } as any,
      eventStore: {} as any,
      piGateway: { sendToSession: vi.fn((_s: string, o: any) => { forwarded.push(o); return true; }), isSessionConnected: vi.fn(() => false) } as any,
      headlessPidRegistry: { getPid: vi.fn(() => undefined) } as any,
      pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() } as any,
      principal,
      requireBrowserAuth: true,
      operatorSet,
      sendTo: vi.fn((_ws: any, m: any) => { sent.push(m); }),
      broadcast: vi.fn(),
      getSubscribers: () => [],
      trackUiRequest: vi.fn(),
      replayPendingUiRequests: vi.fn(),
      markReplaying: vi.fn(),
      clearReplaying: vi.fn(),
    } as unknown as BrowserHandlerContext;
    // A RAW prompt (not a `/command`) → co-drive send_prompt path.
    await handleSendPrompt({ type: "send_prompt", sessionId: SID, text: "hello agent", ...(opts?.queueNonce ? { queueNonce: opts.queueNonce } : {}) } as any, ctx);
    return { forwarded, sent };
  }

  it("op1 + op2 send_prompts POPULATE the cell (co-drive admission on the primary path)", async () => {
    const cell = createOperatorSetTracker();
    const r1 = await sendPrompt(OP1, cell);
    const r2 = await sendPrompt(OP2, cell);
    // Both co-drive prompts reach the bridge (members) AND fill the cell.
    expect(r1.forwarded).toHaveLength(1);
    expect(r2.forwarded).toHaveLength(1);
    expect(cell.count(SID)).toBe(OPERATOR_CELL_LIMIT); // ← RED if :236 admission reverted (would be 0)
  });

  it("a 3rd DISTINCT sub's send_prompt to a FULL session is REFUSED (bridge NOT reached)", async () => {
    const cell = createOperatorSetTracker();
    await sendPrompt(OP1, cell);
    await sendPrompt(OP2, cell);
    // op3 = 3rd distinct human on the co-drive path → refused session-full.
    const r3 = await sendPrompt(OP3, cell, { queueNonce: "n3" });
    expect(r3.forwarded).toHaveLength(0); // ← RED if admission skipped (prompt would reach bridge)
    const failure = r3.sent.find((m) => m.type === "send_prompt_failed");
    expect(failure).toBeDefined();
    expect(failure.reason).toBe("unauthorized"); // session-full surfaces as unauthorized to the client
    expect(failure.queueNonce).toBe("n3");
    expect(cell.count(SID)).toBe(OPERATOR_CELL_LIMIT); // op3 never took a slot
  });

  it("two TABS of the SAME sub via send_prompt = ONE slot (co-drive dedup)", async () => {
    const cell = createOperatorSetTracker();
    await sendPrompt(OP1, cell); // tab 1
    await sendPrompt(OP1, cell); // tab 2 (same sub)
    expect(cell.count(SID)).toBe(1); // ← RED under per-connection counting
    // A DISTINCT 2nd human still fits.
    const r2 = await sendPrompt(OP2, cell);
    expect(r2.forwarded).toHaveLength(1);
    expect(cell.count(SID)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 9 (fix-1 MAJOR-1) — slot-release on LAST-socket-close, INDEPENDENT of the
// presence-view path. A human admitted by a WRITE without ever `session_view`-ing
// is invisible to the presence tracker; the close handler frees the slot via the
// tracker's `sessionsAdmitted(sub)` reverse-lookup + a last-socket guard.
//
// This drives the EXACT release mechanism the `ws.on("close")` handler runs
// (`sessionsAdmitted` → `release`, guarded by "no other live socket of this
// sub"). RED-ARM: neuter `sessionsAdmitted` to return [] (the reverse lookup the
// fix added) → the write-admitted-never-viewed slot leaks → the fresh 3rd human
// is refused → the "fresh human admitted after close" assertion bites.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 9 — slot-release on last-socket-close, presence-independent (MAJOR-1)", () => {
  const SID = "sClose9";

  /** The release mechanism the ws.close handler runs: free `sub` from every
   *  admitted session IFF it has no other live socket (scan `principals`). */
  function releaseOnClose(
    closingSub: string,
    principals: Map<object, TokenPayload | null>,
    operatorSet: ReturnType<typeof createOperatorSetTracker>,
  ): void {
    let hasOtherSocket = false;
    for (const p of principals.values()) {
      if (p?.sub === closingSub) { hasOtherSocket = true; break; }
    }
    if (!hasOtherSocket) {
      for (const sessionId of operatorSet.sessionsAdmitted(closingSub)) {
        operatorSet.release(sessionId, closingSub);
      }
    }
  }

  it("a WRITE-admitted-but-never-VIEWED human's socket close FREES the slot", () => {
    const cell = createOperatorSetTracker();
    const wsA = {}, wsB = {};
    const principals = new Map<object, TokenPayload | null>([[wsA, OP1], [wsB, OP2]]);
    // op1 + op2 admitted by a WRITE (send_prompt/abort) — NEVER session_view'd, so
    // the presence tracker has NO record of them (releasing off presence alone
    // would leak). Fill the cell directly (models the write-admission commit).
    cell.commit(SID, OP1.sub);
    cell.commit(SID, OP2.sub);
    expect(cell.count(SID)).toBe(2);
    // A fresh 3rd human is (correctly) refused while the cell is full.
    expect(cell.canAdmit(SID, OP3.sub).admissible).toBe(false);
    // op2's LAST socket closes → drop from principals, run the release mechanism.
    principals.delete(wsB);
    releaseOnClose(OP2.sub, principals, cell);
    // ← RED if sessionsAdmitted is neutered: slot leaks, count stays 2.
    expect(cell.count(SID)).toBe(1);
    expect(cell.isMember(SID, OP2.sub)).toBe(false);
    // …the freed slot now admits a fresh 3rd distinct human.
    expect(cell.canAdmit(SID, OP3.sub).admissible).toBe(true);
    cell.commit(SID, OP3.sub);
    expect(cell.count(SID)).toBe(2);
  });

  it("ONE of TWO tabs closing does NOT free the slot (last-socket guard)", () => {
    const cell = createOperatorSetTracker();
    const wsA1 = {}, wsA2 = {}; // two tabs of op1
    const principals = new Map<object, TokenPayload | null>([[wsA1, OP1], [wsA2, OP1]]);
    cell.commit(SID, OP1.sub);
    // One tab closes — op1 still has another live socket → slot must NOT free.
    principals.delete(wsA1);
    releaseOnClose(OP1.sub, principals, cell);
    expect(cell.isMember(SID, OP1.sub)).toBe(true); // still admitted
    // The last tab closes → now the slot frees.
    principals.delete(wsA2);
    releaseOnClose(OP1.sub, principals, cell);
    expect(cell.isMember(SID, OP1.sub)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 10 (fix-2 MAJOR-2) — check-then-commit: a REFUSED action strands NO slot.
// A non-operator op-3's operator-only REST action (shutdown) is 403'd AND
// consumes NO slot → the intended 2nd human op-2 is STILL admittable (not locked
// out by a stranded slot). Drives the REAL REST gate → `authorizeSessionAction`
// with a shared cell.
//
// RED-ARM: revert `authorizeSessionAction` to mutate-at-admission (call a
// mutating admit at the admission-first point instead of `canAdmit`+deferred
// `commit`). Then op-3's refused shutdown STRANDS a slot → op-1 + op-3's strand
// fill the cell → op-2 is refused `session-full` → the "op-2 still admittable"
// + "refused action grows no count" assertions bite.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 10 — check-then-commit: a refused REST action strands NO slot (MAJOR-2)", () => {
  const SID = "sStrand10";
  const OPS = ["op1@example.com"]; // op-1 is THE operator; op-2/op-3 are non-operators.

  it("op-3's 403'd operator-only REST consumes NO slot → op-2 still admittable", async () => {
    const cell = createOperatorSetTracker();
    // op-1 (operator) takes a co-drive slot over REST (admitted + committed).
    expect(await restVerdict("abort", OP1, SID, cell, OPS)).toBeUndefined();
    expect(cell.count(SID)).toBe(1);
    // op-3 (non-operator) fires an OPERATOR-ONLY REST action → 403…
    expect(await restVerdict("shutdown", OP3, SID, cell, OPS)).toBe(403);
    // …and consumes NO slot (check-then-commit: the refusal committed nothing).
    expect(cell.count(SID)).toBe(1); // ← RED under mutate-at-admission (would be 2)
    expect(cell.isMember(SID, OP3.sub)).toBe(false);
    // …so the intended 2nd human op-2 is STILL admittable (co-drive), NOT
    // locked out by a stranded op-3 slot.
    expect(await restVerdict("abort", OP2, SID, cell, OPS)).toBeUndefined(); // ← RED: would be 403 session-full
    expect(cell.count(SID)).toBe(2);
    expect(cell.isMember(SID, OP2.sub)).toBe(true);
  });

  it("a REFUSED action never grows the cell count (multiple refusals strand nothing)", async () => {
    const cell = createOperatorSetTracker();
    // Repeated refused operator-only REST from distinct non-operators — the cell
    // must stay EMPTY (no strand accumulates).
    expect(await restVerdict("shutdown", OP2, SID, cell, OPS)).toBe(403);
    expect(await restVerdict("shutdown", OP3, SID, cell, OPS)).toBe(403);
    expect(cell.count(SID)).toBe(0); // ← RED under mutate-at-admission (each strands a slot)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 11 (fix-2 MINOR-3) — fail-closed when admission engaged but sessionId
// absent. A caller that threads `operatorSet` for a `human` (flag-ON) is opting
// into admission; a MISSING sessionId is an inconsistency → REFUSE (session-full)
// rather than skip (which would let a 3rd human learn operator-only / bypass the
// cap). The fully-opt-out path (NO operatorSet) is UNCHANGED — still skipped.
//
// RED-ARM: revert to skip — change the `if (actor.kind==="human" && operatorSet)`
// / `if (!sessionId) return session-full` back to `&& sessionId` (skip when
// absent). Then the admission-engaged-but-no-sessionId human is ALLOWED (skips)
// → the `session-full` assertion bites.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 11 — fail-closed on absent sessionId when admission engaged (MINOR-3)", () => {
  const OPS = ["op1@example.com"];

  it("flag-ON + operatorSet threaded + human + NO sessionId → REFUSED (fail-closed)", () => {
    const cell = createOperatorSetTracker();
    // A co-drive action, human, cell threaded, but sessionId omitted.
    const d = authorizeSessionAction({
      actor: { kind: "human", principal: OP2 },
      action: "send_prompt",
      requireBrowserAuth: true,
      operatorUsers: OPS,
      operatorSet: cell,
      // sessionId ABSENT
    });
    expect(d.allowed).toBe(false); // ← RED under skip-when-absent (would be allowed)
    expect(d.reason).toBe("session-full");
  });

  it("session-CREATING `spawn` (no sessionId, operatorSet threaded) is EXEMPT from fail-closed", () => {
    // fix-2 MINOR-3 exemption (Bastion-gated): `spawn` legitimately has no
    // sessionId (it CREATES a session), so it must NOT fail-closed `session-full`
    // — it falls through to the per-action operator-only rule. This pins the
    // landed `build1b-rest-coverage` behavior: op-2 spawn → operator-only, op-1
    // (operator) spawn → allowed.
    // RED-ARM: drop `spawn` from SESSION_CREATING_ACTIONS → op-2 spawn becomes
    // `session-full` + op-1 spawn is refused → the reasons below bite.
    const cell = createOperatorSetTracker();
    const op2Spawn = authorizeSessionAction({
      actor: { kind: "human", principal: OP2 },
      action: "spawn",
      requireBrowserAuth: true,
      operatorUsers: OPS,
      operatorSet: cell,
      // sessionId ABSENT (spawn creates a new session)
    });
    expect(op2Spawn.allowed).toBe(false);
    expect(op2Spawn.reason).toBe("operator-only"); // NOT session-full (exempt from fail-closed)
    // op-1 (the operator) is allowed to spawn — admission does not block it.
    const op1Spawn = authorizeSessionAction({
      actor: { kind: "human", principal: OP1 },
      action: "spawn",
      requireBrowserAuth: true,
      operatorUsers: OPS,
      operatorSet: cell,
    });
    expect(op1Spawn.allowed).toBe(true);
    // The exemption SKIPS admission (no session to bound) → the cell is untouched.
    expect(cell.count("")).toBe(0);
  });

  it("the fully-opt-out path (NO operatorSet threaded) is UNCHANGED — admission skipped", () => {
    // No operatorSet → the caller did not opt into admission → skip (byte-
    // unchanged for the send-seam's in-handler gate + unit tests). A co-drive
    // action with no cell + no sessionId is allowed.
    const d = authorizeSessionAction({
      actor: { kind: "human", principal: OP2 },
      action: "send_prompt",
      requireBrowserAuth: true,
      operatorUsers: OPS,
      // NO operatorSet, NO sessionId
    });
    expect(d.allowed).toBe(true);
  });

  it("service actor with operatorSet but no sessionId is NOT admission-refused (not counted)", () => {
    // A service actor is never admission-counted, so the MINOR-3 fail-closed
    // (a human-only guard) must NOT fire for it — it proceeds to the per-action
    // rule (co-drive allowed, operator-only refused).
    const cell = createOperatorSetTracker();
    expect(authorizeSessionAction({ actor: { kind: "service", id: "svc" }, action: "send_prompt", requireBrowserAuth: true, operatorUsers: OPS, operatorSet: cell }).allowed).toBe(true);
    const opOnly = authorizeSessionAction({ actor: { kind: "service", id: "svc" }, action: "shutdown", requireBrowserAuth: true, operatorUsers: OPS, operatorSet: cell });
    expect(opOnly.allowed).toBe(false);
    expect(opOnly.reason).toBe("operator-only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 12 (fix-3 NIT close) — REAL-SEAM integration: the ACTUAL browser-gateway
// `ws.on("close")` handler frees the operator-cell slot (MAJOR-1). Test 9 above
// drives a LOCAL copy of the close logic (`releaseOnClose`) — it does NOT
// exercise the real `browser-gateway.ts:781-820` wiring, so a regression THERE
// (the release loop at :809-819) would not bite. THIS test stands up a real
// `createBrowserGateway` with a real `operatorSet`, admits op-2 through the real
// `send_prompt` handler (so the cell actually contains op-2), then fires the
// ACTUAL gateway close event and asserts the real seam freed the slot.
//
// RED-ARM (the whole point): neuter the REAL gateway release loop
// (`browser-gateway.ts` ws.close, :809-819 `operatorSet.release`) → THIS test
// goes RED (op-2's slot leaks; the fresh 3rd is refused `session-full`). Test 9
// (the helper) stays GREEN under that neuter — that is exactly the gap this
// closes. Restore the gateway byte-identical → GREEN.
// ═══════════════════════════════════════════════════════════════════════════
describe("D · Test 12 — REAL gateway ws.close → operatorSet.release (MAJOR-1 real seam)", () => {
  const SID = "sReal12";

  /** A fake browser WS: an EventEmitter so `ws.emit("close")` fires the REAL
   *  gateway close handler, plus the send/readyState/terminate surface the
   *  gateway touches. */
  function makeWs() {
    const ws = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      readyState: number;
      OPEN: number;
      bufferedAmount: number;
    };
    ws.send = vi.fn();
    ws.close = vi.fn();
    ws.terminate = vi.fn();
    ws.readyState = 1;
    ws.OPEN = 1;
    ws.bufferedAmount = 0;
    return ws;
  }

  function stubPiGateway(): PiGateway {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      sendToSession: vi.fn(() => true), // forward "succeeds" (commit at :236 precedes this anyway)
      isSessionConnected: vi.fn(() => false),
      getConnectedSessionIds: vi.fn(() => []),
      hasSession: vi.fn(() => false),
      onEvent: vi.fn(),
    } as unknown as PiGateway;
  }

  /** Stand up a real gateway wired to a real operatorSet (flag-ON), with one
   *  LIVE session so `send_prompt` co-drive admits (not the ended→resume path). */
  function realGateway() {
    const sessionManager = createMemorySessionManager();
    sessionManager.register({ id: SID, cwd: "/tmp", source: "tui" }); // status:"active" (live)
    const eventStore = createMemoryEventStore(() => false);
    const operatorSet = createOperatorSetTracker();
    const gateway = createBrowserGateway(
      sessionManager, eventStore, stubPiGateway(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      true,        // requireBrowserAuth (flag ON)
      undefined,   // operatorUsers (unset → operator-only inert; send_prompt is co-drive so admission still commits)
      operatorSet, // the SAME instance the gateway consults + this test asserts on
    );
    return { gateway, operatorSet };
  }

  /** Connect a fake WS to the REAL gateway, binding `principal` at the real
   *  connection seam (`req.wsPrincipal`), exactly as the /ws upgrade does. */
  function connect(gateway: ReturnType<typeof realGateway>["gateway"], principal: TokenPayload) {
    const ws = makeWs();
    gateway.wss.emit("connection", ws, { wsPrincipal: principal, socket: {}, headers: {} });
    return ws;
  }

  /** Drive a real co-drive `send_prompt` through the gateway message seam so the
   *  actual admission path commits `principal` to the cell. Awaits the async
   *  handler. */
  async function sendPrompt(ws: ReturnType<typeof makeWs>) {
    ws.emit("message", JSON.stringify({ type: "send_prompt", sessionId: SID, text: "hi" }));
    // The gateway's message listener is async — flush the microtask/timer queue
    // so handleSendPrompt (→ authorizeSessionAction → commit) completes.
    await new Promise((r) => setTimeout(r, 0));
  }

  it("op-2 admitted via the real send_prompt seam; the ACTUAL ws.close frees the slot", async () => {
    const { gateway, operatorSet } = realGateway();
    // op-2 connects (principal bound at the real seam) + co-drives → committed.
    const ws2 = connect(gateway, OP2);
    await sendPrompt(ws2);
    expect(operatorSet.count(SID)).toBe(1);
    expect(operatorSet.isMember(SID, OP2.sub)).toBe(true);
    // Fill the 2nd slot with op-1 so the cell is FULL (a fresh 3rd is refused).
    const ws1 = connect(gateway, OP1);
    await sendPrompt(ws1);
    expect(operatorSet.count(SID)).toBe(2);
    expect(operatorSet.canAdmit(SID, OP3.sub).admissible).toBe(false);
    // ── Fire the ACTUAL gateway close handler for op-2's socket ──────────────
    ws2.emit("close");
    // The REAL :809-819 release loop must have freed op-2's slot.
    expect(operatorSet.count(SID)).toBe(1);                       // ← RED if the real release is neutered
    expect(operatorSet.isMember(SID, OP2.sub)).toBe(false);
    // …so a fresh 3rd distinct human is now admittable through the real cell.
    expect(operatorSet.canAdmit(SID, OP3.sub).admissible).toBe(true);
  });

  it("last-socket guard over the REAL seam: closing ONE of two same-sub tabs does NOT free; the LAST does", async () => {
    const { gateway, operatorSet } = realGateway();
    // Two tabs (two sockets) of the SAME human op-2 — both bind op-2's principal.
    const tabA = connect(gateway, OP2);
    const tabB = connect(gateway, OP2);
    await sendPrompt(tabA); // admit op-2 (either tab commits the one slot)
    expect(operatorSet.count(SID)).toBe(1);
    // Close tab A — op-2 still has tab B live → the real hasOtherSocket scan
    // keeps the slot.
    tabA.emit("close");
    expect(operatorSet.isMember(SID, OP2.sub)).toBe(true);        // ← RED if the guard is broken
    expect(operatorSet.count(SID)).toBe(1);
    // Close the LAST tab (B) → now the real seam frees the slot.
    tabB.emit("close");
    expect(operatorSet.isMember(SID, OP2.sub)).toBe(false);
    expect(operatorSet.count(SID)).toBe(0);
  });
});
