/**
 * Component B — `forceTakeover` double-writer-guard ordering tests.
 *
 * The load-bearing invariant (design-pass §6, regression item 5): force-resurrect
 * NEVER spawns a 2nd pi over a live writer. Sequence is SIGTERM → confirm clean
 * exit → respawn. Tested with injected kill/isAlive/respawn so the ordering is
 * provable without real processes.
 */
import { describe, it, expect, vi } from "vitest";
import { forceTakeover } from "../session-api.js";
import type { SpawnResult } from "../process-manager.js";

const okSpawn: SpawnResult = { success: true, message: "spawned", pid: 1234 };

describe("forceTakeover (double-writer guard)", () => {
  it("happy path: kill → confirm-dead → respawn, in that exact order", async () => {
    const order: string[] = [];
    const kill = vi.fn(async (_pid: number) => { order.push("kill"); return { ok: true, forced: false }; });
    const isProcessAlive = vi.fn((_pid: number) => { order.push("isAlive"); return false; }); // dead after kill
    const respawn = vi.fn(async () => { order.push("respawn"); return okSpawn; });

    const res = await forceTakeover(9963, { killProcess: kill, isProcessAlive, respawn });

    expect(res.ok).toBe(true);
    expect(res.spawnResult).toEqual(okSpawn);
    // Ordering is the guarantee: kill BEFORE the liveness gate BEFORE respawn.
    expect(order).toEqual(["kill", "isAlive", "respawn"]);
    expect(kill).toHaveBeenCalledWith(9963);
  });

  it("GUARD: old pid still alive after kill → REFUSE to respawn (no double-writer)", async () => {
    const kill = vi.fn(async () => ({ ok: true, forced: true }));
    const isProcessAlive = vi.fn(() => true); // still alive — kill failed to reap it
    const respawn = vi.fn(async () => okSpawn);

    const res = await forceTakeover(9963, { killProcess: kill, isProcessAlive, respawn });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("kill_failed");
    // The whole point: respawn MUST NOT have been called over the live writer.
    expect(respawn).not.toHaveBeenCalled();
  });

  it("respawn failure is surfaced (and only happens after confirmed clean exit)", async () => {
    const kill = vi.fn(async () => ({ ok: true, forced: false }));
    const isProcessAlive = vi.fn(() => false);
    const failSpawn: SpawnResult = { success: false, message: "pi binary not found" };
    const respawn = vi.fn(async () => failSpawn);

    const res = await forceTakeover(9963, { killProcess: kill, isProcessAlive, respawn });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("respawn_failed");
    expect(res.spawnResult).toEqual(failSpawn);
    expect(respawn).toHaveBeenCalledOnce();
  });

  it("kill is awaited before the liveness gate is read (no race on a still-dying pid)", async () => {
    // Model a pid that is alive UNTIL kill resolves, then dead. If forceTakeover
    // read isAlive before awaiting kill, it would see 'alive' and refuse.
    let killed = false;
    const kill = vi.fn(async (_pid: number) => {
      await new Promise((r) => setTimeout(r, 5));
      killed = true;
      return { ok: true, forced: false };
    });
    const isProcessAlive = vi.fn((_pid: number) => !killed);
    const respawn = vi.fn(async () => okSpawn);

    const res = await forceTakeover(1, { killProcess: kill, isProcessAlive, respawn });

    expect(res.ok).toBe(true);
    expect(respawn).toHaveBeenCalledOnce();
  });
});
