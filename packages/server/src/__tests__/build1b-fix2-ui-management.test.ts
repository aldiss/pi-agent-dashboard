/**
 * Build-1b PUSHBACK-2 FIX-P2-1 (BLOCKER-1) red-arm suite — `ui_management` is
 * fail-CLOSED, effect-aware, descriptor-validated.
 *
 * The dl-5825 re-review BLOCKER: `ui_management` was a blanket
 * WS_PASSTHROUGH_TYPES entry, so op-2 bypassed `authorizeSessionAction`. The
 * gateway forwards `{action, event, params}` unchanged and the bridge does
 * `events.emit(msg.event, data)` — a CALLER-SUPPLIED `event` string → an
 * arbitrary (destructive) extension side-effect (`judo:delete-row`). No
 * descriptor validation, forged event strings accepted.
 *
 * The fix (effect-aware, fail-closed, descriptor-validated):
 *   - a READ (`action:"list"` on an advertised `view.dataEvent`) → co-drive
 *     pass-through (op-2 allowed);
 *   - a MUTATION (an advertised `rowActions`/`actions` UiAction event) →
 *     operator-only (routes `ui_management` through `authorizeSessionAction`);
 *   - a FORGED `(event, action)` NOT in the session's advertised `uiModules`
 *     descriptor → REFUSED for EVERY actor.
 *
 * Every case is RED-ARM (plant instructions in each block header).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import type { ExtensionUiModule } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import { classifyUiManagement, authorizeWsMessage } from "../ws-session-gate.js";

// A representative advertised descriptor: a table with a `list` dataEvent, one
// row action (delete = mutation), one toolbar action (refresh = mutation).
const MODULE: ExtensionUiModule = {
  kind: "management-modal",
  id: "judo",
  command: "/judo",
  title: "Judo",
  view: {
    kind: "table",
    dataEvent: "judo:list-rows",
    rowActions: [{ id: "delete", label: "Delete", event: "judo:delete-row" }],
    actions: [{ id: "refresh", label: "Refresh", event: "judo:refresh" }],
  },
};

// ───────────────────────────────────────────────────────────────────────────
// classifyUiManagement — the pure descriptor-validation core
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-2 FIX-P2-1 — classifyUiManagement (descriptor-validated, fail-closed)", () => {
  it("action:'list' on an advertised dataEvent is a READ (co-drive)", () => {
    expect(classifyUiManagement({ action: "list", event: "judo:list-rows" }, [MODULE])).toBe("read");
  });

  it("an advertised rowAction/toolbar event is a MUTATION (operator-only)", () => {
    // Red-arm: remove the rowActions/actions scan in classifyUiManagement →
    // these fall through to `forged` and the operator-mutation test below breaks.
    expect(classifyUiManagement({ action: "delete", event: "judo:delete-row" }, [MODULE])).toBe("mutation");
    expect(classifyUiManagement({ action: "refresh", event: "judo:refresh" }, [MODULE])).toBe("mutation");
  });

  it("an event NOT in the descriptor is FORGED (refused for everyone)", () => {
    // Red-arm: make classifyUiManagement default to `read`/`mutation` on unknown
    // events → this forged event is accepted → RED. This is the arbitrary-emit
    // channel the BLOCKER cited (a forged `judo:delete-row` on a session that
    // never advertised it, or a `flow:role-preset-delete` internal event).
    expect(classifyUiManagement({ action: "delete", event: "judo:delete-row" }, [])).toBe("forged");
    expect(classifyUiManagement({ action: "list", event: "flow:role-preset-delete" }, [MODULE])).toBe("forged");
    expect(classifyUiManagement({ action: "delete", event: "not-advertised" }, [MODULE])).toBe("forged");
  });

  it("a missing/empty event is FORGED", () => {
    expect(classifyUiManagement({ action: "list" }, [MODULE])).toBe("forged");
    expect(classifyUiManagement({ action: "list", event: "" }, [MODULE])).toBe("forged");
  });

  it("action:'list' on an event that is only a MUTATION event (not the dataEvent) is a mutation, not a read", () => {
    // `list` verb but the event is the delete action's event → still classified
    // by the EVENT (the load-bearing emit token), so it is a mutation.
    expect(classifyUiManagement({ action: "list", event: "judo:delete-row" }, [MODULE])).toBe("mutation");
  });

  it("PUSHBACK-3 FIX-P3-3: an AMBIGUOUS event (both a dataEvent AND a rowAction) classifies MUTATION, not read", () => {
    // Red-arm: revert classifyUiManagement to the read-first ordering (the read
    // /dataEvent check before the mutation scan) → `action:"list"` on the
    // colliding event returns `read` (co-drive) → RED. Mutation-membership MUST
    // WIN over the read/dataEvent check (a read-that-mutates must not be admitted
    // co-drive). The SAME event `judo:same` is advertised as BOTH the table
    // dataEvent AND a rowAction mutation event.
    const AMBIGUOUS: ExtensionUiModule = {
      kind: "management-modal",
      id: "judo",
      command: "/judo",
      title: "Judo",
      view: {
        kind: "table",
        dataEvent: "judo:same",
        rowActions: [{ id: "del", label: "Delete", event: "judo:same" }],
        actions: [],
      },
    };
    expect(classifyUiManagement({ action: "list", event: "judo:same" }, [AMBIGUOUS])).toBe("mutation");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// authorizeWsMessage — the action-gated branch wiring
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-2 FIX-P2-1 — authorizeWsMessage action-gated ui_management", () => {
  const OP1 = { sub: "op1@example.com", name: "Op1", username: "op1", provider: "github", exp: 0 } as any;
  const OP2 = { sub: "op2@example.com", name: "Op2", username: "op2", provider: "github", exp: 0 } as any;

  /** A fake ctx whose sessionManager advertises MODULE for session "s". */
  function ctx(principal: any, requireBrowserAuth: boolean, operatorUsers?: string[]) {
    return {
      principal,
      requireBrowserAuth,
      ...(operatorUsers ? { operatorUsers } : {}),
      sessionManager: { get: (id: string) => (id === "s" ? { uiModules: [MODULE] } : undefined) },
    } as any;
  }
  const listMsg = { type: "ui_management", sessionId: "s", action: "list", event: "judo:list-rows" };
  const mutMsg = { type: "ui_management", sessionId: "s", action: "delete", event: "judo:delete-row" };
  const forgedMsg = { type: "ui_management", sessionId: "s", action: "delete", event: "judo:forged" };

  it("flag OFF → ui_management passes through unchanged (byte-unchanged)", () => {
    const d = authorizeWsMessage(mutMsg as any, ctx(null, false));
    expect(d.passThrough).toBe(true);
    expect(d.allowed).toBe(true);
  });

  it("flag ON: a validated READ passes through (co-drive; op-2 allowed)", () => {
    const d = authorizeWsMessage(listMsg as any, ctx(OP2, true, ["op1@example.com"]));
    expect(d.passThrough).toBe(true);
    expect(d.allowed).toBe(true);
  });

  it("flag ON: a validated MUTATION by op-2 (non-operator) is REFUSED (operator-only)", () => {
    // Red-arm: route the mutation branch to `{passThrough:true,allowed:true}`
    // instead of authorizeSessionAction → op-2's mutation is allowed → RED.
    const d = authorizeWsMessage(mutMsg as any, ctx(OP2, true, ["op1@example.com"]));
    expect(d.passThrough).toBe(false);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("operator-only");
    expect(d.action).toBe("ui_management");
  });

  it("flag ON: a validated MUTATION by op-1 (operator) is ALLOWED", () => {
    const d = authorizeWsMessage(mutMsg as any, ctx(OP1, true, ["op1@example.com"]));
    expect(d.allowed).toBe(true);
    expect(d.passThrough).toBe(false);
  });

  it("flag ON: a FORGED event is REFUSED for op-1 AND op-2 (every actor)", () => {
    // Red-arm: drop the `forged → refuse` branch → the forged emit reaches the
    // bridge → RED. Forged is refused REGARDLESS of operator status.
    for (const p of [OP1, OP2]) {
      const d = authorizeWsMessage(forgedMsg as any, ctx(p, true, ["op1@example.com"]));
      expect(d.passThrough).toBe(false);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("ui-management-forged");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Real WS seam — op-2 mutation/forged REFUSED (no forward); op-1/read allowed
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-2 FIX-P2-1 — real WS seam (op-2 ui_management bypass closed)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "b1b-fix2-uimgmt-secret";
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function tryOpen(ws: WebSocket, ms = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      if (ws.readyState === WebSocket.OPEN) return done(true);
      ws.on("open", () => done(true));
      ws.on("error", () => done(false));
      ws.on("unexpected-response", () => done(false));
      setTimeout(() => done(ws.readyState === WebSocket.OPEN), ms);
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-fix2-uim-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME!;
    process.env.HOME = testDir;
  });
  afterEach(async () => {
    if (handle) { await handle.stop(); handle = undefined; }
    process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function bootMultiOp(operatorUsers: string[]) {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: SECRET, requireBrowserAuth: true, operatorUsers } }));
    const loaded = loadConfig();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    return handle;
  }
  function cookie(sub: string) {
    return `${COOKIE_NAME}=${signToken({ sub, name: "N", username: sub.split("@")[0], provider: "github" }, SECRET)}`;
  }
  async function bridgeWithSession(h: TestServerHandle, sessionId: string) {
    h.server.sessionManager.register({ id: sessionId, cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    const bridge = new WebSocket(`ws://localhost:${h.piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId, cwd: "/tmp", source: "tui", name: sessionId }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId }));
    const inbox: any[] = [];
    bridge.on("message", (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    await delay(150);
    // Advertise the descriptor server-side (as a `ui_modules_list` from the
    // bridge would). MUST be AFTER the bridge's session_register — `register`
    // rebuilds the session object and does NOT carry over uiModules, so an
    // earlier update would be wiped by the re-register.
    h.server.sessionManager.update(sessionId, { uiModules: [MODULE] });
    return { bridge, inbox };
  }
  async function connectBrowser(h: TestServerHandle, sub: string) {
    const ws = new WebSocket(`ws://localhost:${h.httpPort}/ws`, { headers: { Cookie: cookie(sub) } });
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);
    return ws;
  }

  it("op-2 MUTATION ui_management is REFUSED (no forward); op-1 is ALLOWED; op-2 READ is ALLOWED", async () => {
    // Red-arm: re-add ui_management to WS_PASSTHROUGH_TYPES → op-2's mutation
    // forwards to the bridge ungated → the "must NOT reach the bridge" fails.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sUim");

    const op2 = await connectBrowser(h, "op2@example.com");
    // op-2 MUTATION → refused, no forward.
    op2.send(JSON.stringify({ type: "ui_management", sessionId: "sUim", action: "delete", event: "judo:delete-row" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "ui_management" && m.event === "judo:delete-row"),
      "op-2 mutating ui_management must NOT reach the bridge").toBeUndefined();

    // op-2 READ (action:list on the dataEvent) → co-drive, forwarded.
    op2.send(JSON.stringify({ type: "ui_management", sessionId: "sUim", action: "list", event: "judo:list-rows" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "ui_management" && m.event === "judo:list-rows"),
      "op-2 ui_management READ (co-drive) must reach the bridge").toBeDefined();

    // op-1 MUTATION → allowed, forwarded.
    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "ui_management", sessionId: "sUim", action: "delete", event: "judo:delete-row" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "ui_management" && m.event === "judo:delete-row"),
      "op-1 mutating ui_management must reach the bridge").toBeDefined();

    try { op1.close(); op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  it("op-2 FORGED ui_management (event not in descriptor) is REFUSED (no forward)", async () => {
    // Red-arm: drop the forged-refuse branch → the forged emit reaches the
    // bridge → RED. This is the arbitrary-extension-side-effect channel.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sForge");
    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "ui_management", sessionId: "sForge", action: "delete", event: "judo:not-advertised" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "ui_management"),
      "a forged ui_management event must NOT reach the bridge").toBeUndefined();
    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  it("flag-OFF: ui_management forwards unchanged (byte-unchanged single-op)", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ port: 8000 }));
    const loaded = loadConfig();
    expect(loaded.auth).toBeUndefined();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    const { bridge, inbox } = await bridgeWithSession(handle, "sUimOff");
    const ws = new WebSocket(`ws://localhost:${handle.httpPort}/ws`);
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);
    // Even a "mutating" shape forwards unchanged when the flag is OFF.
    ws.send(JSON.stringify({ type: "ui_management", sessionId: "sUimOff", action: "delete", event: "judo:delete-row" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "ui_management" && m.event === "judo:delete-row"),
      "flag-OFF ui_management must forward unchanged").toBeDefined();
    try { ws.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);
});
