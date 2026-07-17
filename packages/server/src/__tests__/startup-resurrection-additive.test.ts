/**
 * Regression item 2 (session-resurrection brief) — STARTUP-resurrection (Fix L)
 * still works AND the Component-A sweep is ADDITIVE, not a replacement.
 *
 * Proves both independently against ONE real messenger-registry fixture
 * (PI_MESSENGER_REGISTRY_DIR), the same ground-truth the two startup call-sites
 * (`session-bootstrap.ts:58` discovery + `server.ts:319` scan) use:
 *
 *   1. `discoverAndBroadcastSessions` (the startup discovery site) restores a
 *      registry-live driver as idle+visible — UNCHANGED by this build.
 *   2. The sweep resurrects a DIFFERENT session that went ended AFTER startup —
 *      the coverage gap the startup-only wiring leaves. Additive: both fire.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { discoverAndBroadcastSessions } from "../session-bootstrap.js";
import { createResurrectionSweep } from "../resurrection-sweep.js";
import type { DiscoveredSession } from "../session-discovery.js";

describe("startup-resurrection (Fix L) + sweep are additive", () => {
  let regDir: string;
  const ALIVE_PID = process.pid; // unquestionably kill-0 alive

  beforeEach(() => {
    regDir = mkdtempSync(join(tmpdir(), "msgreg-additive-"));
    process.env.PI_MESSENGER_REGISTRY_DIR = regDir;
  });
  afterEach(() => {
    delete process.env.PI_MESSENGER_REGISTRY_DIR;
    rmSync(regDir, { recursive: true, force: true });
  });

  const writeEntry = (file: string, obj: unknown) =>
    writeFileSync(join(regDir, `${file}.json`), JSON.stringify(obj));

  /** Minimal DirectoryService stub exposing only what discoverAndBroadcastSessions touches. */
  function stubDirectoryService(discovered: DiscoveredSession[]) {
    return {
      knownDirectories: () => ["/proj"],
      discoverSessions: (_cwd: string) => discovered,
      startPolling: (_cb: any) => {},
      getOpenSpecData: (_cwd: string) => undefined,
      refreshOpenSpec: async (_cwd: string) => undefined,
    } as any;
  }

  it("startup site: discoverAndBroadcastSessions restores a registry-live driver as idle+visible", async () => {
    const sessionManager = createMemorySessionManager();
    const added: string[] = [];
    const browserGateway = {
      broadcastSessionAdded: (s: any) => added.push(s.id),
      broadcastToAll: (_m: any) => {},
    } as any;
    // Registry binds the live driver by UUID.
    writeEntry("Lane", { name: "Lane", pid: ALIVE_PID, sessionId: "uuid-startup-live" });

    const discovered: DiscoveredSession[] = [{
      id: "uuid-startup-live",
      cwd: "/proj",
      startedAt: 1000,
      modifiedAt: 2000,
      sessionFile: "/sessions/uuid-startup-live.jsonl",
      sessionDir: "/sessions",
    }];

    await discoverAndBroadcastSessions({
      sessionManager,
      browserGateway,
      directoryService: stubDirectoryService(discovered),
    });

    const s = sessionManager.get("uuid-startup-live")!;
    // Fix L: live driver → idle + visible + registry name (NOT ended+hidden).
    expect(s.status).toBe("idle");
    expect(s.hidden).toBe(false);
    expect(s.name).toBe("Lane");
    expect(added).toContain("uuid-startup-live");
  });

  it("sweep site: a session that ends AFTER startup (registry still live) is resurrected by the sweep", () => {
    // Models the exact coverage gap: server has been up, bootstrap already ran,
    // then the session died+resumed → endedAt set, pid null, but the registry
    // entry is still live. The startup sites never re-run; the sweep does.
    const sessionManager = createMemorySessionManager();
    const broadcasts: string[] = [];
    const browserGateway = { broadcastSessionUpdated: (id: string, _u: any) => broadcasts.push(id) } as any;

    sessionManager.restore({
      id: "uuid-postboot",
      cwd: "/proj",
      source: "tui",
      status: "ended",
      startedAt: 1000,
      endedAt: 2000,
      hidden: true,
      sessionFile: "/sessions/uuid-postboot.jsonl",
    });
    writeEntry("Rusty", { name: "Rusty", pid: ALIVE_PID, sessionId: "uuid-postboot" });

    const sweep = createResurrectionSweep({ sessionManager, browserGateway, intervalMs: 0 });
    const count = sweep.sweepOnce();

    expect(count).toBe(1);
    const s = sessionManager.get("uuid-postboot")!;
    expect(s.status).toBe("idle");
    expect(s.endedAt).toBeNull(); // null = wire-safe tombstone-clear (survives JSON)
    expect(s.pid).toBe(ALIVE_PID); // pid rebound from the registry
    expect(broadcasts).toContain("uuid-postboot");
  });
});
