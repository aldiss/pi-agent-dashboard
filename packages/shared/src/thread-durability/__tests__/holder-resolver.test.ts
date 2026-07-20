/**
 * Thread-durability — B3 holder-resolution seam tests (ABI `b3/0.1`). PURE +
 * fixture-driven: exercises `shouldRoute` (the fail-closed route gate), the
 * reason↔exit-code table, `failClosed`, and `doNotRouteReason`. No I/O;
 * HOME-isolation via the shared vitest globalSetup, same as the core suite.
 *
 * Acceptance (brief R1): success→true; each of the 9 fail-closed reasons→false;
 * version-mismatch→false; `fresh:false`→false; `authority_mode≠"on"`→false.
 */
import { describe, expect, it } from "vitest";

import {
  B3_ABI_VERSION,
  HOLDER_RESOLVE_EXIT_CODE,
  doNotRouteReason,
  failClosed,
  shouldRoute,
  type HolderResolution,
  type HolderResolutionOk,
  type HolderResolveReason,
} from "../holder-resolver.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const THREAD = "thr-probe-A";

/** A conforming SUCCESS verdict (live, fresh, on-mode, right ABI). */
function ok(over: Partial<HolderResolutionOk> = {}): HolderResolutionOk {
  return {
    ok: true,
    abi_version: B3_ABI_VERSION,
    thread_id: THREAD,
    authority_mode: "on",
    holder: { session_id: "sess-holder-1", name: "alice", last_seen: "2026-07-20T16:00:00Z", fresh: true },
    resolved_at: "2026-07-20T16:00:01Z",
    ...over,
  };
}

const ALL_REASONS: HolderResolveReason[] = [
  "usage",
  "stale",
  "mode-mismatch",
  "path-unresolvable",
  "version-mismatch",
  "holder-not-found",
  "holder-ambiguous",
  "holder-unreachable",
  "transport-timeout",
];

// ── shouldRoute — the fail-closed route gate ─────────────────────────────────

describe("shouldRoute", () => {
  it("conforming success (ok + abi + on + fresh) → true", () => {
    expect(shouldRoute(ok())).toBe(true);
  });

  it("each of the 9 fail-closed reasons → false", () => {
    for (const reason of ALL_REASONS) {
      expect(shouldRoute(failClosed(reason))).toBe(false);
    }
  });

  it("version mismatch → false (the version pin)", () => {
    expect(shouldRoute(ok({ abi_version: "b3/0.2" }))).toBe(false);
    // Also false when the caller pins a different expected ABI.
    expect(shouldRoute(ok(), "b3/1.0")).toBe(false);
  });

  it("holder.fresh === false → false", () => {
    expect(shouldRoute(ok({ holder: { session_id: "s", name: "n", last_seen: "t", fresh: false } }))).toBe(false);
  });

  it("authority_mode ≠ \"on\" (shadow / off) → false", () => {
    expect(shouldRoute(ok({ authority_mode: "shadow" }))).toBe(false);
    expect(shouldRoute(ok({ authority_mode: "off" }))).toBe(false);
  });

  it("fail-closed by default: a malformed success missing holder → false", () => {
    // The seam parses untrusted bin JSON — a success label without a holder is
    // NOT route-eligible (defense-in-depth).
    const malformed = { ok: true, abi_version: B3_ABI_VERSION, thread_id: THREAD, authority_mode: "on", resolved_at: "t" } as unknown as HolderResolution;
    expect(shouldRoute(malformed)).toBe(false);
  });
});

// ── the reason ↔ exit-code table ─────────────────────────────────────────────

describe("HOLDER_RESOLVE_EXIT_CODE + failClosed", () => {
  it("maps every reason to its frozen §4 exit code 1..9", () => {
    expect(HOLDER_RESOLVE_EXIT_CODE).toMatchObject({
      usage: 1,
      stale: 2,
      "mode-mismatch": 3,
      "path-unresolvable": 4,
      "version-mismatch": 5,
      "holder-not-found": 6,
      "holder-ambiguous": 7,
      "holder-unreachable": 8,
      "transport-timeout": 9,
    });
  });

  it("failClosed stamps the exit code from the table (no drift)", () => {
    for (const reason of ALL_REASONS) {
      const f = failClosed(reason, "detail text");
      expect(f.ok).toBe(false);
      expect(f.reason).toBe(reason);
      expect(f.exit_code).toBe(HOLDER_RESOLVE_EXIT_CODE[reason]);
      expect(f.abi_version).toBe(B3_ABI_VERSION);
      expect(f.detail).toBe("detail text");
    }
  });

  it("every fail-closed exit code is non-zero (0 is reserved for success)", () => {
    for (const reason of ALL_REASONS) {
      expect(HOLDER_RESOLVE_EXIT_CODE[reason]).toBeGreaterThan(0);
    }
  });
});

// ── doNotRouteReason — the observability sibling ─────────────────────────────

describe("doNotRouteReason", () => {
  it("returns null for a conforming success (route-eligible)", () => {
    expect(doNotRouteReason(ok())).toBeNull();
  });

  it("agrees with shouldRoute on every case (null ⟺ shouldRoute true)", () => {
    const cases: HolderResolution[] = [
      ok(),
      ok({ abi_version: "b3/0.2" }),
      ok({ authority_mode: "shadow" }),
      ok({ holder: { session_id: "s", name: "n", last_seen: "t", fresh: false } }),
      ...ALL_REASONS.map((r) => failClosed(r)),
    ];
    for (const c of cases) {
      expect(doNotRouteReason(c) === null).toBe(shouldRoute(c));
    }
  });

  it("surfaces the fail-closed reason + exit code", () => {
    expect(doNotRouteReason(failClosed("mode-mismatch"))).toBe("fail-closed:mode-mismatch(exit 3)");
  });

  it("surfaces a version mismatch on a success verdict", () => {
    expect(doNotRouteReason(ok({ abi_version: "b3/0.2" }))).toContain("version-mismatch");
  });
});
