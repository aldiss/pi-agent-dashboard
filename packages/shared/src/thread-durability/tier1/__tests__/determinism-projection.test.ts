/**
 * Determinism-model wire-contract tests — the FIXTURE-BOUND bind (dl-13481).
 *
 * These tests bind against the FROZEN extracted fixture
 * (`_fixture/fixture-c23c8d47.json`, sha256 `c23c8d47…`, 1911 bytes, from frozen
 * commit `6d4b412c`) — the immutable bind target — and NOTHING else (never the
 * `_model/` source, never a live/working-tree copy).
 *
 * They assert SHAPE, not mutable values. The fixture is a SHAPE snapshot of 3
 * LIVE ledger threads whose stage/pending WILL diverge over time — that
 * divergence is CORRECT. So we assert: the 5 contract fields present;
 * deterministic/judgment tagging; terminal (empty pending) handling; unmapped
 * (`stage:null` / `degrade:"unmapped"`) handling; and — the load-bearing render
 * invariant — that a sample with two pending edges sharing a `to` but differing
 * on `via_event` keeps BOTH as distinct edges. We do NOT pin any thread to a
 * momentary stage, and we do NOT "fix" any fold to the snapshot.
 */
import { describe, it, expect } from "vitest";
import {
  loadDeterminismFixture,
  loadDeterminismProjectionMap,
  makeFixtureDeterminismFetcher,
  readFixtureProvenance,
  FIXTURE_SHA256,
  FIXTURE_BYTES,
} from "../determinism-fixture.js";
import {
  pendingKey,
  isDeterministic,
  isJudgment,
  unmappedProjection,
  type DeterminismProjection,
  type PendingTransition,
} from "../determinism-projection.js";

// The frozen sample this suite uses as its REPRESENTATIVE multi-edge example.
// Loaded by thread_id (stable identity) — never by a mutable stage value.
const MULTI_EDGE_THREAD = "peggy+attention-app";

function projectionOf(threadId: string): DeterminismProjection {
  const p = loadDeterminismProjectionMap().get(threadId);
  if (!p) throw new Error(`fixture missing sample ${threadId}`);
  return p;
}

describe("determinism fixture — provenance (immutable bind target)", () => {
  it("reads the frozen fixture bytes: sha256 == c23c8d47… and 1911 bytes", () => {
    const { sha256, bytes } = readFixtureProvenance();
    expect(sha256).toBe(FIXTURE_SHA256);
    expect(sha256.startsWith("c23c8d47")).toBe(true);
    expect(bytes).toBe(FIXTURE_BYTES);
    expect(bytes).toBe(1911);
  });

  it("carries the frozen metadata envelope + exactly the 3 sample projections", () => {
    const file = loadDeterminismFixture();
    expect(file.samples).toHaveLength(3);
    // The machine gloss names the cell-lifecycle spine-fold posture.
    expect(file._machine).toContain("cell-lifecycle");
  });
});

describe("determinism projection — the 5 contract fields (shape, not values)", () => {
  it("every sample carries {thread_id, machine, stage, pending, degrade}", () => {
    for (const p of loadDeterminismFixture().samples) {
      expect(typeof p.thread_id).toBe("string");
      expect(p.thread_id.length).toBeGreaterThan(0);
      expect(typeof p.machine).toBe("string");
      expect("stage" in p).toBe(true); // string | null — presence, not value
      expect(Array.isArray(p.pending)).toBe(true);
      expect("degrade" in p).toBe(true); // "unmapped" | "spine-only" | null
    }
  });

  it("stage is a string or null; degrade is one of the frozen degrade kinds", () => {
    for (const p of loadDeterminismFixture().samples) {
      expect(p.stage === null || typeof p.stage === "string").toBe(true);
      expect([null, "unmapped", "spine-only"]).toContain(p.degrade);
    }
  });
});

describe("determinism projection — deterministic/judgment tagging", () => {
  it("every deterministic edge carries a gate; every judgment edge carries a who", () => {
    // Scan ALL pending across ALL samples — a tagging bug anywhere fails loud.
    let deterministicSeen = 0;
    let judgmentSeen = 0;
    for (const p of loadDeterminismFixture().samples) {
      for (const edge of p.pending) {
        if (isDeterministic(edge)) {
          deterministicSeen++;
          expect(typeof edge.gate).toBe("string");
          expect(edge.gate.length).toBeGreaterThan(0);
          // A deterministic edge must NOT carry a judgment-only `who`.
          expect("who" in edge).toBe(false);
        } else if (isJudgment(edge)) {
          judgmentSeen++;
          expect(typeof edge.who).toBe("string");
          expect(edge.who.length).toBeGreaterThan(0);
          expect("gate" in edge).toBe(false);
        } else {
          throw new Error(`edge with unknown kind: ${JSON.stringify(edge)}`);
        }
      }
    }
    // The representative snapshot exercises BOTH tags (so both render paths bind).
    expect(deterministicSeen).toBeGreaterThan(0);
    expect(judgmentSeen).toBeGreaterThan(0);
  });
});

describe("determinism projection — terminal (empty pending → no edges)", () => {
  it("a terminal sample renders NO edges (pending is empty)", () => {
    // Find the terminal sample by its SHAPE (non-null stage, empty pending) —
    // not by pinning a particular stage string. In the frozen snapshot this is
    // the `done` sample, but the ASSERTION is the shape invariant: a stage with
    // no pending transitions has nowhere to go, so the overlay draws no edges.
    const terminal = loadDeterminismFixture().samples.find(
      (p) => p.stage !== null && p.degrade !== "unmapped" && p.pending.length === 0,
    );
    expect(terminal).toBeDefined();
    expect(terminal!.pending).toHaveLength(0);
  });
});

describe("determinism projection — unmapped (stage:null / degrade:unmapped)", () => {
  it("an unmapped sample has stage:null, degrade:'unmapped', and no edges", () => {
    const unmapped = loadDeterminismFixture().samples.find((p) => p.degrade === "unmapped");
    expect(unmapped).toBeDefined();
    expect(unmapped!.stage).toBeNull();
    expect(unmapped!.pending).toHaveLength(0);
  });

  it("unmappedProjection() produces the same honest shape for any thread id", () => {
    const u = unmappedProjection("some-unknown-thread");
    expect(u.stage).toBeNull();
    expect(u.degrade).toBe("unmapped");
    expect(u.pending).toHaveLength(0);
    expect(u.thread_id).toBe("some-unknown-thread");
  });
});

// ── THE load-bearing render invariant ──────────────────────────────────────
describe("determinism projection — pending keyed by via_event, NEVER de-duped on `to`", () => {
  it("the multi-edge sample keeps 7 pending / 2 DISTINCT reaped edges", () => {
    const p = projectionOf(MULTI_EDGE_THREAD);

    // 7 pending total (the frozen snapshot's representative fan-out).
    expect(p.pending).toHaveLength(7);

    // Build the DISTINCT-edge set with the PRODUCTION keyer (`pendingKey`, keyed
    // on via_event / the full tuple). If `pendingKey` ever regresses to keying
    // on `to` alone, this set collapses below 7 and this assertion fails LOUD.
    const distinctEdges = new Set(p.pending.map(pendingKey));
    expect(distinctEdges.size).toBe(7);

    // The two `to:"reaped"` edges differ ONLY by via_event (operator-reap vs
    // sweep-reap) — both MUST survive as distinct edges.
    const reaped = p.pending.filter((e) => e.to === "reaped");
    expect(reaped).toHaveLength(2);
    const reapedViaEvents = reaped.map((e) => e.via_event).sort();
    expect(reapedViaEvents).toEqual(["operator-reap", "sweep-reap"]);
    const reapedKeys = new Set(reaped.map(pendingKey));
    expect(reapedKeys.size).toBe(2); // 2 distinct reaped edges, not de-duped to 1
  });

  it("GUARD: a de-dupe-on-`to` keyer provably collapses the reaped edges (regression is detectable)", () => {
    const p = projectionOf(MULTI_EDGE_THREAD);

    // The CORRECT keyer (production) → 7 distinct edges.
    const byViaEvent = new Set(p.pending.map(pendingKey));
    // The WRONG keyer (de-dupe on `to` alone) → strictly fewer.
    const byToAlone = new Set(p.pending.map((e) => e.to));

    // Proof the invariant is testable: the two keyers DISAGREE, and specifically
    // the reaped pair collapses 2 → 1 under to-alone. A test built on the
    // production keyer therefore fails the instant someone de-dupes on `to`.
    expect(byViaEvent.size).toBe(7);
    expect(byToAlone.size).toBeLessThan(byViaEvent.size); // 5 < 7
    const reapedUnderToAlone = [...byToAlone].filter((to) => to === "reaped");
    expect(reapedUnderToAlone).toHaveLength(1); // both reaped edges collapse to one
  });
});

// ── the fixture-backed fetcher (injectable, sister to handoffFetcher) ───────
describe("determinism fixture fetcher — resolve by thread_id, unknown → unmapped", () => {
  it("resolves a known thread to its projection", async () => {
    const fetch = makeFixtureDeterminismFetcher();
    const p = await fetch(MULTI_EDGE_THREAD);
    expect(p.thread_id).toBe(MULTI_EDGE_THREAD);
    expect(p.pending).toHaveLength(7);
  });

  it("resolves an unknown thread to a degrade:'unmapped' projection (never throws, never null)", async () => {
    const fetch = makeFixtureDeterminismFetcher();
    const p = await fetch("no-such-thread-anywhere");
    expect(p).not.toBeNull();
    expect(p.stage).toBeNull();
    expect(p.degrade).toBe("unmapped");
    expect(p.pending).toHaveLength(0);
  });

  it("resolves every frozen sample id (all 3 bind)", async () => {
    const fetch = makeFixtureDeterminismFetcher();
    const ids = loadDeterminismFixture().samples.map((s) => s.thread_id);
    for (const id of ids) {
      const p: DeterminismProjection = await fetch(id);
      expect(p.thread_id).toBe(id);
    }
  });
});

// A tiny compile-time + runtime guard that the discriminated union narrows.
describe("determinism projection — union narrowing", () => {
  it("isDeterministic / isJudgment partition the union", () => {
    const det: PendingTransition = { to: "x", kind: "deterministic", via_event: "e", gate: "g" };
    const jud: PendingTransition = { to: "y", kind: "judgment", via_event: "f", who: "operator" };
    expect(isDeterministic(det)).toBe(true);
    expect(isJudgment(det)).toBe(false);
    expect(isJudgment(jud)).toBe(true);
    expect(isDeterministic(jud)).toBe(false);
  });
});
