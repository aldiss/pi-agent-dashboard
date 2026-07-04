/**
 * Reclaim-on-start (Stage-2 (a)/(d)) — own-hand verification.
 *
 * Proves the single-identity port guard that makes every future restart wedge-
 * proof: kill the orphan LISTEN-holder + its process group, verify free, and
 * FAIL LOUD if a port stays held. Negative control: never signal our own pid /
 * our own process group.
 */
import { describe, it, expect } from "vitest";
import { reclaimPorts } from "../reclaim-ports.js";

describe("reclaimPorts — single-identity port guard", () => {
  it("kills the orphan holder BY GROUP (kill-by-PGID) then verifies the port free", async () => {
    let holders = [4242];
    const killedGroups: number[] = [];
    const res = await reclaimPorts([9999], {
      self: 1,
      // pgid of 4242 = 5000; pgid of self(1) = 1
      exec: (cmd) => (cmd.includes(" 4242") ? "5000\n" : "1\n"),
      findHolders: () => holders,
      killGroup: (pgid) => {
        killedGroups.push(pgid);
        holders = []; // the group kill freed the port
      },
      killPid: async () => {},
      isAlive: () => false,
      sleep: async () => {},
      log: () => {},
    });
    expect(killedGroups).toContain(5000); // reaped the orphan's GROUP, not just the pid
    expect(res[0].freed).toBe(true);
    expect(res[0].reclaimed).toEqual([4242]);
  });

  it("FAILS LOUD (throws) if the port is STILL held after reclaim", async () => {
    await expect(
      reclaimPorts([9999], {
        self: 1,
        exec: () => "5000\n",
        findHolders: () => [4242], // never frees — the reclaim did not work
        killGroup: () => {},
        killPid: async () => {},
        isAlive: () => false,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/STILL held/);
  });

  it("NEGATIVE CONTROL — never reclaims our OWN pid", async () => {
    let killed = false;
    const res = await reclaimPorts([9999], {
      self: 4242, // the only holder IS us
      exec: () => "1\n",
      findHolders: () => [4242],
      killGroup: () => {
        killed = true;
      },
      killPid: async () => {
        killed = true;
      },
      isAlive: () => true,
      sleep: async () => {},
      log: () => {},
    });
    expect(killed).toBe(false); // we never signal ourselves
    expect(res[0].reclaimed).toEqual([]);
    expect(res[0].freed).toBe(true);
  });

  it("NEGATIVE CONTROL — a holder sharing OUR process group is direct-killed, never group-killed", async () => {
    let holders = [4242];
    let groupKilled = false;
    let pidKilled = false;
    await reclaimPorts([9999], {
      self: 100,
      exec: () => "77\n", // holder pgid == our pgid == 77
      findHolders: () => holders,
      killGroup: () => {
        groupKilled = true;
      },
      killPid: async () => {
        pidKilled = true;
        holders = [];
      },
      isAlive: () => false,
      sleep: async () => {},
      log: () => {},
    });
    expect(groupKilled).toBe(false); // MUST NOT group-kill our own tree
    expect(pidKilled).toBe(true); // direct single-pid kill of just the holder
  });
});
