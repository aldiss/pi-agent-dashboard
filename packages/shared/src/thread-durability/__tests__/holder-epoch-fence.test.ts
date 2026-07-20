/**
 * Thread-durability — A4 `holder_epoch` D3 fence read-side tests (design v3.6,
 * A4 fold; frozen shape Joan-163). PURE + fixture-driven: exercises
 * `resolveCurrentEpoch`, `isStaleEpoch`, and the injectable `HolderEpochResolver`
 * seam stubbed with fixtures. No I/O; HOME-isolation is handled by the shared
 * vitest globalSetup (`setup-home.ts`), same as the core suite.
 *
 * Acceptance (brief):
 *  - resolveCurrentEpoch: no-changes → 0; monotonic 0→1→2 → 2; non-monotonic /
 *    duplicate / gap → throws (fail loud).
 *  - isStaleEpoch: E<C → true; E==C → false; E>C → throws (fail loud).
 */
import { describe, expect, it } from "vitest";

import {
  DECLARED_HOLDER_EPOCH,
  isStaleEpoch,
  resolveCurrentEpoch,
  resolveCurrentEpochFor,
  type HolderEpochResolver,
  type ThreadHolderChangedEvent,
} from "../holder-epoch-fence.js";

// ── Builders / fixtures ──────────────────────────────────────────────────────

const THREAD = "thr-probe-A";

/** One `thread-holder-changed` event at a given gate-issued epoch. */
function change(epoch: number, over: Partial<ThreadHolderChangedEvent> = {}): ThreadHolderChangedEvent {
  return {
    thread_id: THREAD,
    payload: { holder_epoch: epoch },
    from_holder: `holder-${epoch - 1}`,
    to_holder: `holder-${epoch}`,
    actor: "gate",
    ...over,
  };
}

/** The frozen shape: a contiguous strictly-increasing sequence 1..n. */
function sequence(n: number): ThreadHolderChangedEvent[] {
  return Array.from({ length: n }, (_, i) => change(i + 1));
}

/** A fixture-backed `HolderEpochResolver` — the real ledger read is deferred. */
function stubResolver(map: Record<string, ThreadHolderChangedEvent[]>): HolderEpochResolver {
  return {
    holderChangedEvents(threadId: string): readonly ThreadHolderChangedEvent[] {
      return map[threadId] ?? [];
    },
  };
}

// ── resolveCurrentEpoch ──────────────────────────────────────────────────────

describe("resolveCurrentEpoch", () => {
  it("declared holder, no change events → epoch 0", () => {
    expect(resolveCurrentEpoch([])).toBe(0);
    expect(resolveCurrentEpoch([])).toBe(DECLARED_HOLDER_EPOCH);
  });

  it("monotonic 0→1→2 (two change events) → returns 2", () => {
    expect(resolveCurrentEpoch([change(1), change(2)])).toBe(2);
  });

  it("single change → returns 1", () => {
    expect(resolveCurrentEpoch([change(1)])).toBe(1);
  });

  it("long contiguous sequence 1..5 → returns 5", () => {
    expect(resolveCurrentEpoch(sequence(5))).toBe(5);
  });

  it("returns the ledger field value, not a derived count", () => {
    // A well-formed sequence: field value == length, both are 3.
    const evs = sequence(3);
    expect(resolveCurrentEpoch(evs)).toBe(evs[evs.length - 1].payload.holder_epoch);
  });

  // ── fail-loud: the gate guarantees monotonicity, a violation is corruption ──

  it("duplicate epoch → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([change(1), change(1)])).toThrow(/non-monotonic/);
  });

  it("regression (2 then 1) → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([change(1), change(2), change(1)])).toThrow(/non-monotonic/);
  });

  it("gap (1 then 3) → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([change(1), change(3)])).toThrow(/non-monotonic/);
  });

  it("does not start at 1 (first change epoch 0) → throws (fail loud)", () => {
    // Epoch 0 is the DECLARED holder and emits NO change event; a change event
    // at 0 is corruption.
    expect(() => resolveCurrentEpoch([change(0)])).toThrow(/non-monotonic/);
  });

  it("first change starts at 2 (skipped 1) → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([change(2)])).toThrow(/non-monotonic/);
  });

  it("non-integer epoch → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([change(1.5)])).toThrow(/non-negative integer/);
  });

  it("negative epoch → throws (fail loud)", () => {
    expect(() => resolveCurrentEpoch([{ ...change(1), payload: { holder_epoch: -1 } }])).toThrow(
      /non-negative integer/,
    );
  });

  it("mixed thread_id in the batch → throws (fail loud)", () => {
    const foreign = change(2, { thread_id: "thr-other-B" });
    expect(() => resolveCurrentEpoch([change(1), foreign])).toThrow(/mixed thread_id/);
  });
});

// ── isStaleEpoch ─────────────────────────────────────────────────────────────

describe("isStaleEpoch", () => {
  it("claimEpoch < currentEpoch → true (stale / superseded holder)", () => {
    expect(isStaleEpoch(1, 2)).toBe(true);
    expect(isStaleEpoch(0, 1)).toBe(true);
  });

  it("claimEpoch === currentEpoch → false (holder is current)", () => {
    expect(isStaleEpoch(2, 2)).toBe(false);
    expect(isStaleEpoch(0, 0)).toBe(false);
  });

  it("claimEpoch > currentEpoch → throws (ahead of the gate is impossible)", () => {
    expect(() => isStaleEpoch(3, 2)).toThrow(/ahead of/);
  });

  it("non-integer / negative operands → throw (contract conformance)", () => {
    expect(() => isStaleEpoch(1.5, 2)).toThrow(/non-negative integer/);
    expect(() => isStaleEpoch(1, -2)).toThrow(/non-negative integer/);
  });
});

// ── HolderEpochResolver seam (fixture-stubbed; real wiring deferred) ──────────

describe("HolderEpochResolver seam + resolveCurrentEpochFor", () => {
  it("resolves the current epoch for a thread with changes", () => {
    const resolver = stubResolver({ [THREAD]: [change(1), change(2)] });
    expect(resolveCurrentEpochFor(resolver, THREAD)).toBe(2);
  });

  it("a thread on its declared holder (no events) → 0", () => {
    const resolver = stubResolver({});
    expect(resolveCurrentEpochFor(resolver, THREAD)).toBe(DECLARED_HOLDER_EPOCH);
  });

  it("propagates the fail-loud throw on a corrupt fixture sequence", () => {
    const resolver = stubResolver({ [THREAD]: [change(1), change(3)] });
    expect(() => resolveCurrentEpochFor(resolver, THREAD)).toThrow(/non-monotonic/);
  });

  it("composes with isStaleEpoch: a claim under a superseded holder is stale", () => {
    const resolver = stubResolver({ [THREAD]: sequence(3) }); // current = 3
    const current = resolveCurrentEpochFor(resolver, THREAD);
    expect(isStaleEpoch(1, current)).toBe(true); // claim from epoch 1 → stale
    expect(isStaleEpoch(3, current)).toBe(false); // claim from the current holder
  });
});
