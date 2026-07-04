/**
 * Reclaim-on-start INTEGRATION (Stage-2 (a)) — REAL processes, REAL lsof/kill.
 *
 * The unit test (reclaim-ports.test.ts) injects deps; this proves the actual
 * mechanism end-to-end against a real orphan port-holder:
 *   - POSITIVE: a real detached process holds a real port; reclaimPorts() finds
 *     it via lsof, kills it BY GROUP (real pgid resolution), and the port is
 *     verifiably free afterwards. This is the D6-style own-hand proof that the
 *     wedge-fix works on real OS facts, not mocks.
 *   - NEGATIVE (discriminator): with the orphan still holding the port, a plain
 *     bind throws EADDRINUSE — proving the orphan genuinely blocks (the exact
 *     wedge condition reclaim exists to clear). Isolated to a single free port;
 *     never touches :8000/:9999.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import { reclaimPorts } from "../reclaim-ports.js";
import { findPortHolders } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Spawn a DETACHED node process that binds `port` and stays alive (an orphan
 * with its OWN process group — the clean case for kill-by-group). */
function spawnOrphan(port: number): Promise<number> {
  const src = `require("net").createServer().listen(${port},"0.0.0.0",()=>{process.stdout.write("READY")});setInterval(()=>{},1e9);`;
  const child = spawn(process.execPath, ["-e", src], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("orphan did not bind in time")), 4000);
    child.stdout!.on("data", () => {
      clearTimeout(t);
      resolve(child.pid!);
    });
    child.on("error", reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reclaim-on-start INTEGRATION (real processes)", () => {
  it("POSITIVE — reclaims a REAL orphan holding the port (real lsof + kill-by-group), verifies free", async () => {
    const port = await getFreePort();
    const orphanPid = await spawnOrphan(port);
    try {
      // Sanity: the orphan really holds the port (external OS fact).
      expect(findPortHolders(port)).toContain(orphanPid);

      // THE FIX, for real: reclaim resolves the holder + its pgid and group-kills it.
      await reclaimPorts([port]);

      // Verify free (poll briefly for the OS to release the socket).
      let holders = findPortHolders(port);
      for (let i = 0; i < 20 && holders.length; i++) {
        await wait(100);
        holders = findPortHolders(port);
      }
      expect(holders).toEqual([]); // port reclaimed
      expect(isAlive(orphanPid)).toBe(false); // orphan reaped
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("NEGATIVE CONTROL — without reclaim, binding the occupied port throws EADDRINUSE (the wedge condition)", async () => {
    const port = await getFreePort();
    const orphanPid = await spawnOrphan(port);
    try {
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const s = net.createServer();
        s.on("error", (e) => resolve(e as NodeJS.ErrnoException));
        s.listen(port, "0.0.0.0");
      });
      expect(err.code).toBe("EADDRINUSE"); // the orphan genuinely blocks — reclaim is what clears it
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });
});
