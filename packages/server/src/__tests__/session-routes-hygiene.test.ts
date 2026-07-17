/**
 * HTTP-level tests for the session read-path hygiene + retire endpoint
 * (dashboard-session-row-hygiene — LOCKED dl-3397). Drives the real Fastify
 * routes via `inject`, with an in-memory sessionManager + injected probes.
 *
 * Covers:
 *   - GET  /api/sessions runs F1/F2/F4 reconcile + broadcasts (read-path reap).
 *   - POST /api/sessions/retire multi-key, verify-dead, anomaly contract.
 *   - ★ the cross-cell integration case (design §Build plan): retire a
 *     throwaway → THAT row retires AND a concurrently-live same-name does NOT.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSessionRoutes } from "../routes/session-routes.js";
import type { HygieneProbes } from "../session-hygiene.js";
import type { ClaudePane } from "../cc-pane-liveness.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const PASSTHRU_GUARD = async () => {};
const ALIVE = 4242;
const DEAD = 2147483646;

/** Minimal in-memory sessionManager fake (only what the routes touch). */
function makeSessionManager(initial: DashboardSession[]) {
  const map = new Map(initial.map((s) => [s.id, { ...s }]));
  return {
    listAll: () => Array.from(map.values()),
    get: (id: string) => map.get(id),
    update: (id: string, updates: Partial<DashboardSession>) => {
      const s = map.get(id);
      if (s) Object.assign(s, updates);
    },
  } as any;
}

function makeProbes(opts: { alivePids?: number[]; registryLive?: Record<string, string>; panes?: ClaudePane[] }): HygieneProbes {
  const alive = new Set(opts.alivePids ?? []);
  const reg = opts.registryLive ?? {};
  const panes = opts.panes ?? [];
  return {
    isSessionConnected: () => false,
    resolveDriverLiveness: (id) => (reg[id] ? { alive: true, name: reg[id] } : { alive: false }),
    pidAlive: (pid) => alive.has(pid),
    listClaudePanes: () => panes,
  };
}

function sess(p: Partial<DashboardSession> & Pick<DashboardSession, "id">): DashboardSession {
  return { cwd: "/w", source: "tmux", status: "ended", startedAt: 1000, ...p } as DashboardSession;
}

async function buildApp(
  sessions: DashboardSession[],
  probes: HygieneProbes,
  broadcasts: Array<{ id: string; updates: Record<string, unknown> }>,
  graceMs = 0,
): Promise<{ app: FastifyInstance; sm: any }> {
  const app = Fastify();
  const sm = makeSessionManager(sessions);
  registerSessionRoutes(app, {
    sessionManager: sm,
    eventStore: { getEvent: () => undefined, getEvents: () => [] } as any,
    networkGuard: PASSTHRU_GUARD,
    hygieneProbes: probes,
    broadcastSessionUpdated: (id, updates) => broadcasts.push({ id, updates }),
    hygieneGraceMs: graceMs,
    now: () => 1_000_000,
  });
  await app.ready();
  return { app, sm };
}

describe("GET /api/sessions — read-path hygiene", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it("reaps a dead ghost (hidden:true) and broadcasts it", async () => {
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp([sess({ id: "ghost", status: "ended" })], makeProbes({}), broadcasts);
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.find((s: DashboardSession) => s.id === "ghost").hidden).toBe(true);
    expect(broadcasts).toContainEqual({ id: "ghost", updates: { hidden: true } });
  });

  it("★ does NOT reap a live-no-bridge false-ended row — rescues it visible (no-regress)", async () => {
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp(
      [sess({ id: "live", status: "ended", hidden: true, pid: ALIVE })],
      makeProbes({ alivePids: [ALIVE] }),
      broadcasts,
    );
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = res.json().data.find((s: DashboardSession) => s.id === "live");
    expect(row.hidden).toBe(false);
    expect(row.status).toBe("idle");
  });

  it("applies the registry clean name (F2) on a ∅-named live driver", async () => {
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp(
      [sess({ id: "j", name: "∅", status: "idle", hidden: false })],
      makeProbes({ registryLive: { j: "Joan" } }),
      broadcasts,
    );
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.json().data.find((s: DashboardSession) => s.id === "j").name).toBe("Joan");
  });
});

describe("POST /api/sessions/retire", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it("retires a confirmed-dead ghost by tmuxName", async () => {
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp([sess({ id: "d", name: "Joan", status: "ended" })], makeProbes({}), broadcasts);
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/api/sessions/retire", payload: { tmuxName: "Joan" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ retired: ["d"], anomaly: false });
    expect(built.sm.get("d").hidden).toBe(true);
  });

  it("★ REFUSES to retire a LIVE pid and surfaces anomaly (Joan invariant #1) — HTTP still 200", async () => {
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp([sess({ id: "live", name: "Joan", pid: ALIVE, status: "idle" })], makeProbes({ alivePids: [ALIVE] }), broadcasts);
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/api/sessions/retire", payload: { pid: ALIVE } });
    expect(res.statusCode).toBe(200); // best-effort, non-fatal
    const body = res.json().data;
    expect(body.retired).toEqual([]);
    expect(body.anomaly).toBe(true);
    expect(built.sm.get("live").hidden).toBeUndefined(); // NEVER hidden
  });

  it("rejects an empty body (no key)", async () => {
    const built = await buildApp([], makeProbes({}), []);
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/api/sessions/retire", payload: {} });
    expect(res.json().success).toBe(false);
  });

  it("★ cross-cell integration: retire a throwaway → THAT row retires; a concurrently-live same-name does NOT", async () => {
    // Directly exercises invariant #1 across the rotate→retire seam: a tmuxName
    // matching BOTH a dead throwaway and a live same-name row retires only the dead.
    const broadcasts: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const built = await buildApp(
      [
        sess({ id: "throwaway", name: "Bert", status: "ended", pid: DEAD }),
        sess({ id: "bert-live", name: "Bert", status: "idle", pid: ALIVE }),
      ],
      makeProbes({ alivePids: [ALIVE] }),
      broadcasts,
    );
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/api/sessions/retire", payload: { tmuxName: "Bert" } });
    const body = res.json().data;
    expect(body.retired).toEqual(["throwaway"]);
    expect(body.refusedLive.map((r: any) => r.sessionId)).toEqual(["bert-live"]);
    expect(body.anomaly).toBe(true);
    expect(built.sm.get("throwaway").hidden).toBe(true);   // the dead one retired
    expect(built.sm.get("bert-live").hidden).toBeUndefined(); // the live one untouched
  });
});
