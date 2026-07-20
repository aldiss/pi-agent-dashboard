/**
 * B4 step 2 — the persistent terminalization listener (design v3.6 §C3.1 step 6).
 *
 * Proves the live-holder "stuck at accepted" gap is closed: an `accepted` row +
 * a `turn_end` carrying a persisted assistant child terminalizes to
 * `delivered`; a second `turn_end` is a `noop` (never double-terminalizes); a
 * live holder mid-turn (durable entry, NO assistant child yet) stays `accepted`
 * (no premature terminalize).
 *
 * The mock store reuses the REAL B1 `reconcileAccepted` pure decision (imported
 * from shared) so the reconcile logic is genuinely exercised; B2 separately
 * proves the per-row lock-safety of the concrete store.
 */
import { describe, expect, it } from "vitest";

import {
  reconcileAccepted as reconcileAcceptedPure,
  type AcceptanceFact,
  type DurableScanEvidence,
  type OriginalTuple,
  type OutboxEntry,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

import { SessionTerminalizer, type TerminalizeStore, type PiTurnEndHandle } from "../terminalize.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function acceptedRow(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    holder_identity: { pid: 42, session_id: "sess-A", start_epoch: 1000 },
    holder_epoch: 7,
    payload_hash: "hash-1",
    entry_id: "entry-1",
    state: "accepted",
    revision: 3,
    delivered: false,
    updated_at: 100,
    ...over,
  };
}

function evidence(over: Partial<DurableScanEvidence> = {}): DurableScanEvidence {
  return { entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false, conflict: null, ...over };
}

/** A mock pi that lets a test fire turn_end. */
function mockPi(): { pi: PiTurnEndHandle; fireTurnEnd: () => void; handlerCount: () => number } {
  const handlers: Array<(p: unknown) => void> = [];
  return {
    pi: {
      on: (_e, h) => handlers.push(h),
      off: (_e, h) => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      },
    },
    fireTurnEnd: () => handlers.slice().forEach((h) => h(null)),
    handlerCount: () => handlers.length,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("SessionTerminalizer — closes the accepted-while-live gap", () => {
  it("accepted row + turn_end with a persisted assistant child → delivered", async () => {
    const initial = acceptedRow();
    let row = { ...initial };
    const store: TerminalizeStore = {
      read: () => ({ ...row }),
      reconcileAccepted: async (fact, original) => {
        const res = reconcileAcceptedPure(fact, original, row);
        if (res.action === "terminalize") {
          row = { ...row, state: "executed", delivered: true, revision: res.newRevision! };
          return { action: "terminalize", entry: { ...row } };
        }
        return { action: res.action, entry: { ...row } };
      },
    };
    const term = new SessionTerminalizer({
      store,
      scan: () => evidence({ entryDurable: true, hasPersistedAssistantChild: true }),
    });
    term.track(initial);
    await term.onTurnEnd();
    expect(row.delivered).toBe(true);
    expect(row.state).toBe("executed");
    expect(term.trackedIds()).toEqual([]); // dropped after terminal
  });

  it("second turn_end → noop (never double-terminalizes)", async () => {
    const initial = acceptedRow();
    let row = { ...initial };
    let reconcileCalls = 0;
    const store: TerminalizeStore = {
      read: () => ({ ...row }),
      reconcileAccepted: async (fact, original) => {
        reconcileCalls++;
        const res = reconcileAcceptedPure(fact, original, row);
        if (res.action === "terminalize") {
          row = { ...row, state: "executed", delivered: true, revision: res.newRevision! };
          return { action: "terminalize", entry: { ...row } };
        }
        return { action: res.action, entry: { ...row } };
      },
    };
    const term = new SessionTerminalizer({
      store,
      scan: () => evidence({ entryDurable: true, hasPersistedAssistantChild: true }),
    });
    term.track(initial);
    await term.onTurnEnd(); // terminalizes → delivered
    const callsAfterFirst = reconcileCalls;
    await term.onTurnEnd(); // row already delivered + untracked → NO reconcile
    expect(reconcileCalls).toBe(callsAfterFirst); // no second reconcile write
    expect(reconcileCalls).toBe(1);
    expect(row.revision).toBe(initial.revision + 1); // revision bumped exactly once
  });

  it("live holder mid-turn (durable entry, NO assistant child yet) → stays accepted, no premature terminalize", async () => {
    const initial = acceptedRow();
    let row = { ...initial };
    let reconcileCalls = 0;
    const store: TerminalizeStore = {
      read: () => ({ ...row }),
      reconcileAccepted: async () => { reconcileCalls++; return { action: "noop", entry: { ...row } }; },
    };
    const term = new SessionTerminalizer({
      store,
      // durable entry but the assistant child is NOT persisted yet (mid-turn).
      scan: () => evidence({ entryDurable: true, hasPersistedAssistantChild: false }),
    });
    term.track(initial);
    await term.onTurnEnd();
    expect(reconcileCalls).toBe(0); // never called reconcile — no durable execution
    expect(row.delivered).toBe(false);
    expect(row.state).toBe("accepted");
    expect(term.trackedIds()).toEqual(["D1"]); // still watching for the executing turn
  });

  it("conflict evidence → fail_loud, retained (not delivered), dropped from tracking", async () => {
    const initial = acceptedRow();
    let row = { ...initial };
    let reconcileCalls = 0;
    const store: TerminalizeStore = {
      read: () => ({ ...row }),
      reconcileAccepted: async () => { reconcileCalls++; return { action: "noop", entry: { ...row } }; },
    };
    const events: string[] = [];
    const term = new SessionTerminalizer({
      store,
      scan: () => evidence({ entryDurable: true, hasPersistedAssistantChild: true, conflict: "attempt" }),
      sink: (e) => events.push(e.kind),
    });
    term.track(initial);
    await term.onTurnEnd();
    expect(reconcileCalls).toBe(0); // conflict short-circuits BEFORE reconcile
    expect(row.delivered).toBe(false); // retained, never silently delivered
    expect(events).toContain("fail_loud");
    expect(term.trackedIds()).toEqual([]);
  });

  it("attach registers exactly ONE persistent turn_end handler (not per-injection)", () => {
    const initial = acceptedRow();
    const store: TerminalizeStore = { read: () => ({ ...initial }), reconcileAccepted: async () => ({ action: "noop", entry: null }) };
    const term = new SessionTerminalizer({ store, scan: () => evidence() });
    const { pi, handlerCount } = mockPi();
    term.attach(pi);
    term.attach(pi); // idempotent — never double-registers
    expect(handlerCount()).toBe(1);
    term.detach();
    expect(handlerCount()).toBe(0);
  });

  it("a fired turn_end drives the sweep end-to-end via the persistent handler", async () => {
    const initial = acceptedRow();
    let row = { ...initial };
    const store: TerminalizeStore = {
      read: () => ({ ...row }),
      reconcileAccepted: async (fact, original) => {
        const res = reconcileAcceptedPure(fact, original, row);
        if (res.action === "terminalize") { row = { ...row, state: "executed", delivered: true, revision: res.newRevision! }; return { action: "terminalize", entry: { ...row } }; }
        return { action: res.action, entry: { ...row } };
      },
    };
    const term = new SessionTerminalizer({ store, scan: () => evidence({ entryDurable: true, hasPersistedAssistantChild: true }) });
    const { pi, fireTurnEnd } = mockPi();
    term.attach(pi);
    term.track(initial);
    fireTurnEnd();
    // allow the async sweep to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(row.delivered).toBe(true);
  });
});

// ── direct proof: reconcile on an already-delivered row is a noop ───────────

describe("reconcileAccepted idempotency (the noop the terminalizer relies on)", () => {
  it("an already-delivered row → noop (no revision change)", () => {
    const delivered: OutboxEntry = acceptedRow({ state: "executed", delivered: true, revision: 4 });
    const fact: AcceptanceFact = {
      delivery_id: "D1", attempt: 1, thread_id: "T1", holder_session_id: "sess-A",
      entry_id: "entry-1", payload_hash: "hash-1", accepted_at: 100, executed_at: 200,
    };
    const original: OriginalTuple = { delivery_id: "D1", attempt: 1, holder_session_id: "sess-A", payload_hash: "hash-1" };
    const res = reconcileAcceptedPure(fact, original, delivered);
    expect(res.action).toBe("noop");
  });
});
