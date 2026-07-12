/**
 * Deterministic-spawn A3 (design §9): spawn-fail is a DETECTED TERMINAL within
 * T — not a hang. The spawn-register-watchdog's timeout path flips the token's
 * pendingSpawnIntent to `failed{reason: register-timeout}` (design §6, the
 * model's `registering → dead`). Drives the REAL watchdog + REAL registry via
 * the injectable per-arm `onTimeout` callback + fake timers.
 *
 * Mirrors the disk-write safety of spawn-register-watchdog.test.ts: the
 * failure-log is mocked so the timeout never touches ~/.pi.
 *
 * See change: deterministic-spawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Silence appendSpawnFailure (no disk write on timeout). Same guard the
// existing watchdog test uses.
vi.mock("../spawn-failure-log.js", () => ({
  appendSpawnFailure: vi.fn(),
}));

import { SpawnRegisterWatchdog } from "../spawn-register-watchdog.js";
import { createPendingSpawnIntentRegistry } from "../pending-spawn-intent-registry.js";

describe("deterministic-spawn A3 — watchdog timeout → failed{register-timeout}", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a no-register within T flips the intent to failed{register-timeout}", () => {
    const registry = createPendingSpawnIntentRegistry();
    registry.record({
      spawnToken: "tok-timeout",
      name: "Driver-T",
      cwd: "/orch",
      flavor: "new",
      directive: { text: "kickoff" },
    });
    // Precondition: pending.
    expect(registry.get("tok-timeout")).toMatchObject({ status: "pending" });

    // Arm the REAL watchdog on the token, wiring onTimeout → registry.fail
    // exactly as server.ts does (no ws — the REST-poll path).
    const watchdog = new SpawnRegisterWatchdog(5_000);
    watchdog.arm({
      cwd: "/orch",
      mechanism: "tmux",
      spawnToken: "tok-timeout",
      onTimeout: (tok) => {
        if (tok) registry.fail(tok, "register-timeout");
      },
    });

    // Before T: still pending.
    vi.advanceTimersByTime(4_999);
    expect(registry.get("tok-timeout")).toMatchObject({ status: "pending" });

    // At/after T: the deterministic terminal.
    vi.advanceTimersByTime(2);
    expect(registry.get("tok-timeout")).toMatchObject({
      status: "failed",
      reason: "register-timeout",
    });
  });

  it("a register that arrives before T (clearByToken) is NOT failed", () => {
    const registry = createPendingSpawnIntentRegistry();
    registry.record({
      spawnToken: "tok-ok",
      name: "Driver-OK",
      cwd: "/orch",
      flavor: "crash-respawn",
      directive: { text: "light wake" },
    });

    const watchdog = new SpawnRegisterWatchdog(5_000);
    watchdog.arm({
      cwd: "/orch",
      mechanism: "tmux",
      spawnToken: "tok-ok",
      onTimeout: (tok) => {
        if (tok) registry.fail(tok, "register-timeout");
      },
    });

    // Session registers in time: the pi-gateway clears the watchdog by token,
    // AND the deliver-on-register hook resolves the intent to ok.
    watchdog.clearByToken("tok-ok");
    registry.resolveOnRegister("tok-ok", "sess-ok");

    // Advancing past T must NOT flip an already-ok intent to failed.
    vi.advanceTimersByTime(10_000);
    expect(registry.get("tok-ok")).toMatchObject({ status: "ok", sessionId: "sess-ok" });
  });

  it("onTimeout fires even with NO ws (the REST-poll spawn has no socket)", () => {
    // Regression guard for the additive `ws?` change: an arm with no socket
    // must still fire its onTimeout (the intent-fail path), never throw.
    const failed: string[] = [];
    const watchdog = new SpawnRegisterWatchdog(5_000);
    watchdog.arm({
      cwd: "/no-ws",
      mechanism: "tmux",
      spawnToken: "tok-no-ws",
      onTimeout: (tok) => { if (tok) failed.push(tok); },
    });
    expect(() => vi.advanceTimersByTime(5_001)).not.toThrow();
    expect(failed).toEqual(["tok-no-ws"]);
  });
});
