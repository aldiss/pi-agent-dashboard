/**
 * Thread-durability — drain-loop tests (design v3.6 §C3.1, the B3→A4→inject
 * routing). Fixture-driven: every seam (store / B3 resolver / A4 epoch resolver
 * / inject) is stubbed. Real fs is NOT touched — the store seam is in-memory —
 * but HOME-isolation still applies via the server vitest globalSetup.
 *
 * Acceptance (brief R2):
 *  - route-happy-path: fresh holder → resolves epoch → stamps → inject once.
 *  - do-not-route → HOLD (row retained, inject NOT called).
 *  - stale-epoch → HOLD (inject NOT called).
 *  - never-drop: a held row is never removed.
 *  - (fail-loud) claim epoch AHEAD of the gate → throws, inject NOT called.
 */
import { describe, expect, it } from "vitest";

import {
  drainThread,
  type DrainInject,
  type DrainInjectResult,
  type DrainStore,
  type HolderStamp,
} from "../drain-loop.js";
import {
  B3_ABI_VERSION,
  failClosed,
  type HolderEpochResolver,
  type HolderResolution,
  type HolderResolver,
  type OutboxEntry,
  type ThreadHolderChangedEvent,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const THREAD = "thr-A";

function rowFixture(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: THREAD,
    holder_session_id: "sess-old",
    holder_identity: { pid: 4242, session_id: "sess-old", start_epoch: 1000 },
    holder_epoch: 0,
    payload_hash: "hash-1",
    state: "injecting",
    revision: 0,
    delivered: false,
    updated_at: 111,
    ...over,
  };
}

/** A single `thread-holder-changed` event at a gate-issued epoch (frozen shape). */
function change(epoch: number): ThreadHolderChangedEvent {
  return {
    thread_id: THREAD,
    payload: { holder_epoch: epoch },
    from_holder: `holder-${epoch - 1}`,
    to_holder: `holder-${epoch}`,
    actor: "gate",
  };
}

/** A conforming SUCCESS B3 verdict for a live/fresh/on holder. */
function okResolution(sessionId = "sess-new"): HolderResolution {
  return {
    ok: true,
    abi_version: B3_ABI_VERSION,
    thread_id: THREAD,
    authority_mode: "on",
    holder: { session_id: sessionId, name: "alice", last_seen: "2026-07-20T16:00:00Z", fresh: true },
    resolved_at: "2026-07-20T16:00:01Z",
  };
}

/** A recording in-memory {@link DrainStore} stub. */
function makeStore(rows: OutboxEntry[]): DrainStore & {
  removed: Set<string>;
  lockOrder: string[];
  stamps: Array<{ delivery_id: string; patch: HolderStamp }>;
  current(id: string): OutboxEntry | undefined;
} {
  const byId = new Map(rows.map((r) => [r.delivery_id, { ...r }]));
  const removed = new Set<string>();
  const lockOrder: string[] = [];
  const stamps: Array<{ delivery_id: string; patch: HolderStamp }> = [];
  return {
    removed,
    lockOrder,
    stamps,
    current: (id) => byId.get(id),
    readyRows: () => [...byId.values()].filter((r) => !removed.has(r.delivery_id)).map((r) => ({ ...r })),
    async withRowLock(delivery_id, fn) {
      lockOrder.push(`acquire:${delivery_id}`);
      try {
        return await fn();
      } finally {
        lockOrder.push(`release:${delivery_id}`);
      }
    },
    async stampHolder(delivery_id, patch) {
      stamps.push({ delivery_id, patch });
      const cur = byId.get(delivery_id)!;
      const next: OutboxEntry = { ...cur, holder_epoch: patch.holder_epoch, holder_session_id: patch.holder_session_id };
      byId.set(delivery_id, next);
      return { ...next };
    },
  };
}

/** A B3 resolver returning a fixed verdict, recording calls. */
function makeResolver(verdict: HolderResolution): HolderResolver & { calls: Array<[string, string | undefined]> } {
  const calls: Array<[string, string | undefined]> = [];
  return {
    calls,
    resolveHolder(threadId, name) {
      calls.push([threadId, name]);
      return verdict;
    },
  };
}

/** An A4 epoch resolver over fixed change events. */
function makeEpochResolver(events: ThreadHolderChangedEvent[]): HolderEpochResolver {
  return { holderChangedEvents: () => events };
}

/** A recording inject seam. */
function makeInject(outcome: DrainInjectResult["outcome"] = "accepted"): DrainInject & { calls: OutboxEntry[] } {
  const calls: OutboxEntry[] = [];
  const fn = (async (entry: OutboxEntry) => {
    calls.push(entry);
    return { outcome, row: entry };
  }) as DrainInject & { calls: OutboxEntry[] };
  fn.calls = calls;
  return fn;
}

// ── route-happy-path ─────────────────────────────────────────────────────────

describe("drainThread — route happy path", () => {
  it("fresh holder → resolves epoch → stamps → inject called once", async () => {
    // current epoch = 2 (changes 1,2); row already at epoch 2 → not stale.
    const store = makeStore([rowFixture({ holder_epoch: 2 })]);
    const inject = makeInject("accepted");
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(okResolution("sess-new")),
      epochResolver: makeEpochResolver([change(1), change(2)]),
      inject,
    });

    expect(res.dispositions).toHaveLength(1);
    const d = res.dispositions[0];
    expect(d.action).toBe("routed");
    if (d.action === "routed") {
      expect(d.holder_session_id).toBe("sess-new");
      expect(d.holder_epoch).toBe(2);
      expect(d.inject.outcome).toBe("accepted");
    }
    // inject called exactly once, with the STAMPED row.
    expect(inject.calls).toHaveLength(1);
    expect(inject.calls[0].holder_session_id).toBe("sess-new");
    expect(inject.calls[0].holder_epoch).toBe(2);
    // stamp applied once; lock acquired + released.
    expect(store.stamps).toEqual([{ delivery_id: "D1", patch: { holder_epoch: 2, holder_session_id: "sess-new" } }]);
    expect(store.lockOrder).toEqual(["acquire:D1", "release:D1"]);
  });

  it("declared-holder thread (no changes) with a row at epoch 0 routes", async () => {
    const store = makeStore([rowFixture({ holder_epoch: 0 })]);
    const inject = makeInject();
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(okResolution()),
      epochResolver: makeEpochResolver([]), // no changes → current epoch 0
      inject,
    });
    expect(res.dispositions[0].action).toBe("routed");
    expect(inject.calls).toHaveLength(1);
  });

  it("passes the holderName through to B3 --name when provided", async () => {
    const store = makeStore([rowFixture({ holder_epoch: 0 })]);
    const resolver = makeResolver(okResolution());
    await drainThread(THREAD, {
      store,
      resolveHolder: resolver,
      epochResolver: makeEpochResolver([]),
      inject: makeInject(),
      holderName: () => "alice",
    });
    expect(resolver.calls).toEqual([[THREAD, "alice"]]);
  });
});

// ── do-not-route → HOLD (never-drop) ─────────────────────────────────────────

describe("drainThread — do-not-route HOLDs (never-drop)", () => {
  it("fail-closed verdict → HOLD, inject NOT called, row retained untouched", async () => {
    const store = makeStore([rowFixture({ holder_epoch: 0 })]);
    const inject = makeInject();
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(failClosed("mode-mismatch")),
      epochResolver: makeEpochResolver([]),
      inject,
    });

    const d = res.dispositions[0];
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toBe("do-not-route");
      expect(d.detail).toContain("mode-mismatch");
    }
    // NEVER-DROP: inject not called, no stamp, row still present + untouched.
    expect(inject.calls).toHaveLength(0);
    expect(store.stamps).toHaveLength(0);
    expect(store.current("D1")).toBeDefined();
    expect(store.current("D1")!.holder_session_id).toBe("sess-old");
    expect(store.removed.has("D1")).toBe(false);
    // The lock WAS taken + released even on a hold.
    expect(store.lockOrder).toEqual(["acquire:D1", "release:D1"]);
  });

  it("version-mismatch success → HOLD (do-not-route)", async () => {
    const store = makeStore([rowFixture({ holder_epoch: 0 })]);
    const inject = makeInject();
    const badVersion: HolderResolution = { ...(okResolution() as Extract<HolderResolution, { ok: true }>), abi_version: "b3/0.2" };
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(badVersion),
      epochResolver: makeEpochResolver([]),
      inject,
    });
    expect(res.dispositions[0].action).toBe("hold");
    expect(inject.calls).toHaveLength(0);
  });
});

// ── stale-epoch → HOLD ───────────────────────────────────────────────────────

describe("drainThread — stale-epoch HOLDs", () => {
  it("row epoch < current epoch → HOLD, inject NOT called (superseded holder)", async () => {
    // current epoch = 2; row at epoch 1 → stale.
    const store = makeStore([rowFixture({ holder_epoch: 1 })]);
    const inject = makeInject();
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(okResolution()),
      epochResolver: makeEpochResolver([change(1), change(2)]),
      inject,
    });

    const d = res.dispositions[0];
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toBe("stale-epoch");
      expect(d.detail).toContain("superseded");
    }
    expect(inject.calls).toHaveLength(0);
    expect(store.stamps).toHaveLength(0);
    expect(store.current("D1")).toBeDefined(); // never-drop
  });
});

// ── fail-loud: claim epoch AHEAD of the gate (corruption) ────────────────────

describe("drainThread — fail-loud on impossible epoch", () => {
  it("row epoch > current epoch → throws (fail loud), inject NOT called, row retained", async () => {
    // current epoch = 1; row claims epoch 2 → ahead of the gate = corruption.
    const store = makeStore([rowFixture({ holder_epoch: 2 })]);
    const inject = makeInject();
    await expect(
      drainThread(THREAD, {
        store,
        resolveHolder: makeResolver(okResolution()),
        epochResolver: makeEpochResolver([change(1)]),
        inject,
      }),
    ).rejects.toThrow(/ahead of/);

    // Fail-loud: never injected, never stamped, row retained (lock released).
    expect(inject.calls).toHaveLength(0);
    expect(store.stamps).toHaveLength(0);
    expect(store.current("D1")).toBeDefined();
    expect(store.lockOrder).toEqual(["acquire:D1", "release:D1"]);
  });
});

// ── never-drop across a mixed batch ──────────────────────────────────────────

describe("drainThread — never-drop across a mixed batch", () => {
  it("routes the fresh row, HOLDs the held row; neither is removed", async () => {
    const store = makeStore([
      rowFixture({ delivery_id: "D-route", holder_epoch: 0 }),
      rowFixture({ delivery_id: "D-hold", holder_epoch: 0 }),
    ]);
    const inject = makeInject();
    // First row routes (ok), second HOLDs (fail-closed) — distinct per-row verdicts.
    let n = 0;
    const resolver: HolderResolver = {
      resolveHolder: () => (n++ === 0 ? okResolution("sess-new") : failClosed("holder-not-found")),
    };
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: resolver,
      epochResolver: makeEpochResolver([]),
      inject,
    });

    expect(res.dispositions.map((d) => d.action)).toEqual(["routed", "hold"]);
    expect(inject.calls).toHaveLength(1);
    expect(inject.calls[0].delivery_id).toBe("D-route");
    // BOTH rows still present — never-drop.
    expect(store.current("D-route")).toBeDefined();
    expect(store.current("D-hold")).toBeDefined();
    expect(store.removed.size).toBe(0);
  });

  it("empty ready set → no dispositions, no inject", async () => {
    const store = makeStore([]);
    const inject = makeInject();
    const res = await drainThread(THREAD, {
      store,
      resolveHolder: makeResolver(okResolution()),
      epochResolver: makeEpochResolver([]),
      inject,
    });
    expect(res.dispositions).toHaveLength(0);
    expect(inject.calls).toHaveLength(0);
  });
});
