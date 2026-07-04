/**
 * Track 4, Fix L — driver-liveness resolution tests.
 *
 * Proves the mechanism own-hand against a temp messenger-registry fixture
 * (PI_MESSENGER_REGISTRY_DIR override): UUID-join (sessionId === id) + kill -0,
 * with C2 (pid-reuse scoped by the sessionId match), C3 (heartbeat never gates),
 * and fail-safe-to-ended on every miss.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive, resolveDriverLiveness } from "../driver-liveness.js";

describe("driver-liveness (Fix L)", () => {
  let regDir: string;
  const ALIVE_PID = process.pid; // this test process is unquestionably kill-0 alive
  const DEAD_PID = 2147483646; // astronomically unlikely to exist

  beforeEach(() => {
    regDir = mkdtempSync(join(tmpdir(), "msgreg-"));
    process.env.PI_MESSENGER_REGISTRY_DIR = regDir;
  });
  afterEach(() => {
    delete process.env.PI_MESSENGER_REGISTRY_DIR;
    rmSync(regDir, { recursive: true, force: true });
  });

  const writeEntry = (file: string, obj: unknown) =>
    writeFileSync(join(regDir, `${file}.json`), JSON.stringify(obj));

  it("pidAlive: true for this process, false for a dead pid, false for garbage", () => {
    expect(pidAlive(ALIVE_PID)).toBe(true);
    expect(pidAlive(DEAD_PID)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(NaN as unknown as number)).toBe(false);
  });

  it("ALIVE: UUID-join hit + kill-0 alive → {alive:true, name, pid} (the false-ended driver, rescued)", () => {
    writeEntry("Don", { name: "Don", pid: ALIVE_PID, sessionId: "uuid-don-live" });
    expect(resolveDriverLiveness("uuid-don-live")).toEqual({ alive: true, name: "Don", pid: ALIVE_PID });
  });

  it("DEAD: UUID-join hit but pid dead → {alive:false} (genuinely ended, stays ended+hidden)", () => {
    writeEntry("Ghost", { name: "Ghost", pid: DEAD_PID, sessionId: "uuid-ghost-dead" });
    expect(resolveDriverLiveness("uuid-ghost-dead")).toEqual({ alive: false });
  });

  it("NO-MATCH: a live registry entry but a DIFFERENT sessionId → {alive:false} (UUID-keyed, not name-keyed)", () => {
    // The stale-tenure case: registry holds the LIVE session's uuid; the discovered
    // session is an OLDER tenure with a different id → must NOT bind to the live pid.
    writeEntry("Don", { name: "Don", pid: ALIVE_PID, sessionId: "uuid-don-tenure-4" });
    expect(resolveDriverLiveness("uuid-don-tenure-3-stale")).toEqual({ alive: false });
  });

  it("C2 pid-reuse guard: a recycled pid that is alive does NOT false-positive unless the sessionId also matches", () => {
    // Two entries share the live pid (reuse), but only one carries the queried sessionId.
    writeEntry("Reused", { name: "Reused", pid: ALIVE_PID, sessionId: "uuid-the-real-one" });
    // Querying a sessionId that no entry carries → no bind, even though the pid is alive.
    expect(resolveDriverLiveness("uuid-not-present").alive).toBe(false);
    // Querying the real one → binds.
    expect(resolveDriverLiveness("uuid-the-real-one")).toEqual({ alive: true, name: "Reused", pid: ALIVE_PID });
  });

  it("C3 heartbeat is display-only: a stale lastActivityAt does NOT make a kill-0-alive driver ended", () => {
    // Don's real case: alive pid, 2-day-stale heartbeat. Liveness is kill-0, not freshness.
    writeEntry("Quiet", {
      name: "Quiet",
      pid: ALIVE_PID,
      sessionId: "uuid-quiet",
      activity: { lastActivityAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(resolveDriverLiveness("uuid-quiet")).toEqual({ alive: true, name: "Quiet", pid: ALIVE_PID });
  });

  it("fail-safe: empty/absent registry dir → {alive:false} (keeps the ended default, never throws)", () => {
    process.env.PI_MESSENGER_REGISTRY_DIR = join(regDir, "does-not-exist");
    expect(resolveDriverLiveness("anything")).toEqual({ alive: false });
  });

  it("fail-safe: empty sessionId → {alive:false}", () => {
    expect(resolveDriverLiveness("")).toEqual({ alive: false });
  });

  it("robust: an unreadable/partial JSON registry file is skipped, not fatal", () => {
    writeFileSync(join(regDir, "Broken.json"), "{ this is not json");
    writeEntry("Good", { name: "Good", pid: ALIVE_PID, sessionId: "uuid-good" });
    expect(resolveDriverLiveness("uuid-good")).toEqual({ alive: true, name: "Good", pid: ALIVE_PID });
  });
});
