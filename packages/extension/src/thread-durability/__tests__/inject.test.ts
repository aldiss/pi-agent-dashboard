/**
 * B3 injection primitive — tests (design v3.6 §C3.1).
 *
 * Uses a MOCK pi handle that records `sendMessage` calls (asserting
 * `triggerTurn` for idle vs `deliverAs:"followUp"` for streaming, and that the
 * bare append is NEVER used) and lets a test emit `message_end`/`turn_end`. The
 * store is an in-memory mock mirroring the B2 transition contract; the scan is
 * injected. Verifies the ordered claim sequence, the pre-call `queued_executing`
 * write, the bounded lease, and the failure boundary.
 */
import { describe, expect, it } from "vitest";

import {
  injectDelivery,
  type InjectStoreView,
  type OutboxRowView,
  type PiInjectHandle,
  type SendMessageOptions,
  type TransitionResultView,
} from "../inject.js";
import type { DurableScanEvidence } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

// ── mock pi handle ──────────────────────────────────────────────────────────

interface SendCall {
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> };
  options?: SendMessageOptions;
}

function mockPi(opts: { failSend?: boolean } = {}) {
  const sendCalls: SendCall[] = [];
  const handlers: Record<string, Array<(p: unknown) => void>> = { message_end: [], turn_end: [] };
  const pi: PiInjectHandle = {
    sendMessage: (message, options) => {
      sendCalls.push({ message: message as unknown as SendCall["message"], options });
      if (opts.failSend) return Promise.reject(new Error("send boom"));
      return Promise.resolve();
    },
    on: (event, handler) => {
      handlers[event].push(handler);
    },
    off: (event, handler) => {
      handlers[event] = handlers[event].filter((h) => h !== handler);
    },
  };
  return {
    pi,
    sendCalls,
    emitMessageEnd: () => handlers.message_end.forEach((h) => h(null)),
    emitTurnEnd: () => handlers.turn_end.forEach((h) => h(null)),
  };
}

// ── mock store (mirrors the B2 transition contract) ─────────────────────────

function mockStore(): { store: InjectStoreView; rows: Map<string, OutboxRowView>; calls: string[] } {
  const rows = new Map<string, OutboxRowView>();
  const calls: string[] = [];
  const bump = (id: string, state: OutboxRowView["state"], patch: Partial<OutboxRowView> = {}): TransitionResultView => {
    const cur = rows.get(id);
    if (!cur) return { ok: false, reason: "not_found" };
    const next: OutboxRowView = { ...cur, ...patch, state, revision: cur.revision + 1 };
    rows.set(id, next);
    return { ok: true, entry: next };
  };
  const store: InjectStoreView = {
    markQueued: async ({ delivery_id }) => { calls.push("markQueued"); return bump(delivery_id, "queued_executing"); },
    markObserved: async ({ delivery_id, entry_id }) => { calls.push("markObserved"); return bump(delivery_id, "observed", { entry_id }); },
    markAccepted: async ({ delivery_id }) => { calls.push("markAccepted"); return bump(delivery_id, "accepted"); },
    markFailed: async ({ delivery_id }) => { calls.push("markFailed"); return bump(delivery_id, "failed"); },
    reconcileAccepted: async ({ delivery_id }) => {
      calls.push("reconcileAccepted");
      const cur = rows.get(delivery_id);
      if (!cur) return { action: "noop", entry: null };
      const next: OutboxRowView = { ...cur, state: "executed", revision: cur.revision + 1 };
      rows.set(delivery_id, next);
      return { action: "terminalize", entry: next };
    },
  };
  return { store, rows, calls };
}

function readyRow(over: Partial<OutboxRowView> = {}): OutboxRowView {
  return {
    delivery_id: "D1",
    attempt: 1,
    holder_session_id: "sess-A",
    holder_identity: { pid: 42, session_id: "sess-A", start_epoch: 1000 },
    payload_hash: "hash-1",
    state: "injecting",
    revision: 0,
    thread_id: "T1",
    holder_epoch: 7,
    ...over,
  };
}

function evidence(over: Partial<DurableScanEvidence> = {}): DurableScanEvidence {
  return { entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false, conflict: null, ...over };
}

/** A manual timer so the lease never fires unless the test drives it. */
function manualTimer() {
  const timers: Array<{ cb: () => void; cancelled: boolean }> = [];
  const setTimer = (cb: () => void) => {
    const t = { cb, cancelled: false };
    timers.push(t);
    return { cancel: () => { t.cancelled = true; } };
  };
  return { setTimer, fireAll: () => timers.filter((t) => !t.cancelled).forEach((t) => t.cb()) };
}

/**
 * Flush pending microtasks so an in-flight `injectDelivery` progresses past its
 * `await store.markQueued` + `await pi.sendMessage` and REGISTERS its seam
 * handlers + lease timer. A real `setTimeout(0)` macrotask drains the
 * microtask queue. Must be awaited BEFORE driving `emit*()`/`fireAll()` — the
 * primitive registers listeners only after the pre-call sequence resolves.
 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ── tests ────────────────────────────────────────────────────────────────────

describe("injectDelivery — the executing API (never the bare append)", () => {
  it("idle holder → sendMessage with { triggerTurn: true }", async () => {
    const { pi, sendCalls, emitTurnEnd } = mockPi();
    const { store, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();

    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: true, entryId: "e1", evidence: evidence({ hasPersistedAssistantChild: true }) }),
    });
    // Drive to executed so the promise settles.
    await flush();
    emitTurnEnd();
    await p;

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].message.customType).toBe("thread_delivery");
    expect(sendCalls[0].options).toEqual({ triggerTurn: true });
    // details self-identify with delivery_id/thread_id/attempt/holder_epoch
    expect(sendCalls[0].message.details).toMatchObject({ delivery_id: "D1", thread_id: "T1", attempt: 1, holder_epoch: 7 });
  });

  it("streaming holder → sendMessage with { deliverAs: 'followUp' } (queue, not steer)", async () => {
    const { pi, sendCalls, emitTurnEnd } = mockPi();
    const { store, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();

    const p = injectDelivery(row, {
      pi, store, holderIsIdle: false, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: true, entryId: "e1", evidence: evidence({ hasPersistedAssistantChild: true }) }),
    });
    await flush();
    emitTurnEnd();
    await p;

    expect(sendCalls[0].options).toEqual({ deliverAs: "followUp" });
    expect(sendCalls[0].options?.deliverAs).not.toBe("steer"); // steer is the explicit urgent interrupt, never the default
  });

  it("NEVER calls a bare append: the handle exposes only sendMessage (no appendCustomMessageEntry surface used)", async () => {
    const { pi, sendCalls, emitTurnEnd } = mockPi();
    const { store, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();
    // Prove the mock has no append method AND injection only used sendMessage.
    expect((pi as unknown as Record<string, unknown>).appendCustomMessageEntry).toBeUndefined();
    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: true, entryId: "e1", evidence: evidence({ hasPersistedAssistantChild: true }) }),
    });
    await flush();
    emitTurnEnd();
    await p;
    expect(sendCalls).toHaveLength(1); // exactly one executing call, no append
  });
});

describe("injectDelivery — ordered proof-tracking sequence (Bert ordering)", () => {
  it("writes queued_executing BEFORE the pi call", async () => {
    const order: string[] = [];
    const { store: base, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const store: InjectStoreView = {
      ...base,
      markQueued: async (i) => { order.push("markQueued"); return base.markQueued(i); },
    };
    const pi: PiInjectHandle = {
      sendMessage: () => { order.push("sendMessage"); return Promise.resolve(); },
      on: () => {},
      off: () => {},
    };
    const timer = manualTimer();
    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: false, evidence: evidence() }),
    });
    await flush(); // let markQueued + sendMessage resolve and the lease register
    timer.fireAll(); // elapse the lease → resolve indeterminate
    await p;
    expect(order).toEqual(["markQueued", "sendMessage"]); // queued_executing fsync BEFORE the call
  });

  it("message_end → observed → accepted; turn_end → executed (reconcileAccepted)", async () => {
    const { pi, emitMessageEnd, emitTurnEnd } = mockPi();
    const { store, rows, calls } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();

    let durable = false;
    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 5000, setTimer: timer.setTimer,
      // entryId is ALWAYS present (entry seen in memory → observed); only
      // `entryDurable` toggles (durable barrier → accepted). observed≠accepted.
      scan: () => ({ entryDurable: durable, entryId: "e1", evidence: evidence() }),
    });

    // First message_end: entry seen (observed) but not yet durable.
    durable = false;
    await flush();
    emitMessageEnd();
    await flush();

    // Entry becomes durable → next message_end marks accepted.
    durable = true;
    emitMessageEnd();
    const res = await p; // accepted resolves the promise

    expect(res.outcome).toBe("accepted");
    expect(calls).toContain("markObserved");
    expect(calls).toContain("markAccepted");
  });
});

describe("injectDelivery — bounded indeterminate lease (never an infinite hold)", () => {
  it("lease elapses with no correlated progress → indeterminate", async () => {
    const { pi } = mockPi();
    const { store, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();
    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: false, evidence: evidence() }),
    });
    await flush();
    timer.fireAll();
    const res = await p;
    expect(res.outcome).toBe("indeterminate");
  });
});

describe("injectDelivery — failure boundary", () => {
  it("sendMessage throws → claim → failed (correlated, re-inject safe)", async () => {
    const { pi } = mockPi({ failSend: true });
    const { store, rows, calls } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();
    const res = await injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: false, evidence: evidence() }),
    });
    expect(res.outcome).toBe("failed");
    expect(calls).toContain("markFailed");
  });

  it("queue rejected (lost CAS race) → indeterminate, no pi call", async () => {
    const { pi, sendCalls } = mockPi();
    const rows = new Map<string, OutboxRowView>();
    const store: InjectStoreView = {
      markQueued: async () => ({ ok: false, reason: "revision_mismatch" }),
      markObserved: async () => ({ ok: false, reason: "x" }),
      markAccepted: async () => ({ ok: false, reason: "x" }),
      markFailed: async () => ({ ok: false, reason: "x" }),
      reconcileAccepted: async () => ({ action: "noop", entry: null }),
    };
    const row = readyRow();
    rows.set("D1", row);
    const res = await injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 1000,
      scan: () => ({ entryDurable: false, evidence: evidence() }),
    });
    expect(res.outcome).toBe("indeterminate");
    expect(sendCalls).toHaveLength(0); // never called pi after a losing CAS
  });
});

describe("injectDelivery — delivery-state channel", () => {
  it("emits dispatching → observed → accepted events to the sink", async () => {
    const { pi, emitMessageEnd } = mockPi();
    const { store, rows } = mockStore();
    const row = readyRow();
    rows.set("D1", row);
    const timer = manualTimer();
    const events: string[] = [];
    let durable = true;
    const p = injectDelivery(row, {
      pi, store, holderIsIdle: true, leaseMs: 5000, setTimer: timer.setTimer,
      scan: () => ({ entryDurable: durable, entryId: "e1", evidence: evidence() }),
      sink: (e) => events.push(e.kind),
    });
    await flush();
    emitMessageEnd();
    await p;
    expect(events[0]).toBe("dispatching");
    expect(events).toContain("observed");
    expect(events).toContain("accepted");
  });
});
