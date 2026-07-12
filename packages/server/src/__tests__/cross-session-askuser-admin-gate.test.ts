/**
 * Empirical-cycle-pass for the cross-session operator-input surface
 * (NOS cell cross-session-askuser-surface).
 *
 * Drives the REAL production seam — createBrowserGateway + trackPromptRequest /
 * clearPromptRequest + the deployed cell-access role gate — to prove, end to
 * end, the operator-required multi-op behaviour:
 *   1. a pending capsule (the prompt_request the bridge forwards for a ctx.ui /
 *      ask_user prompt) raised in session A is broadcast to an OPERATOR (admin)
 *      browser as `pending_operator_inputs`, carrying the session name, question
 *      preview, the [DEFAULT-marked default action, and an accurate deadline
 *      (firstSeenAt + the server-enforced askUserPromptTimeoutSeconds);
 *   2. a GUEST browser NEVER receives it (the admin-only delivery gate — no
 *      cross-operator leak);
 *   3. it clears (empty broadcast to the operator) when the capsule resolves.
 *
 * The off-default feature flag is enabled via a temp-HOME config.json so the
 * live machine config is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrowserGateway } from "../browser-gateway.js";
import { createCellAccessController } from "../cell-access.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createMemoryEventStore } from "../memory-event-store.js";
import type { PiGateway } from "../pi-gateway.js";
import type { TokenPayload } from "../auth.js";

const OP = { sub: "op@example.com", name: "Operator", username: "op", provider: "github", exp: 0 } as unknown as TokenPayload;
const GUEST = { sub: "guest@example.com", name: "Guest", username: "guest", provider: "github", exp: 0 } as unknown as TokenPayload;

function makeFakeWs() {
  const ws = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number; OPEN: number;
  };
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.readyState = 1;
  ws.OPEN = 1;
  return ws;
}
function makeStubPiGateway(): PiGateway {
  return {
    start: vi.fn(), stop: vi.fn(), sendToSession: vi.fn(),
    getConnectedSessionIds: vi.fn(() => []), hasSession: vi.fn(() => false), onEvent: vi.fn(),
  } as unknown as PiGateway;
}
function pendingMsgs(ws: ReturnType<typeof makeFakeWs>) {
  return ws.send.mock.calls
    .map((a) => { try { return JSON.parse(String(a[0])); } catch { return null; } })
    .filter((m): m is { type: string; items: Array<Record<string, unknown>> } => !!m && m.type === "pending_operator_inputs");
}

let prevHome: string | undefined;
beforeAll(() => {
  prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xsession-gate-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "dashboard", "config.json"),
    JSON.stringify({ crossSessionOperatorInput: { enabled: true }, askUserPromptTimeoutSeconds: 300 }),
  );
});
afterAll(() => { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; });

describe("cross-session-askuser admin-gate (empirical-cycle-pass)", () => {
  it("delivers a pending capsule to an OPERATOR, NOT to a guest, and clears on resolve", () => {
    const sessionManager = createMemorySessionManager();
    sessionManager.restore({ id: "A", cwd: "/repo/a", name: "session-A", source: "tui", status: "active", startedAt: 1, hidden: false, dataUnavailable: false } as never);

    const cellAccess = createCellAccessController({ authConfig: { operatorUsers: ["op@example.com"], guestCellGrants: {} } as never });
    // Sanity: the deployed authz roles our principals as expected.
    expect(cellAccess.enabled).toBe(true);
    expect(cellAccess.roleForPrincipal(OP)).toBe("operator");
    expect(cellAccess.roleForPrincipal(GUEST)).toBe("guest");
    expect(cellAccess.roleForPrincipal(null)).toBe("anonymous");

    const gateway = createBrowserGateway(
      sessionManager,
      createMemoryEventStore(() => false),
      makeStubPiGateway(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, // params 4..16
      undefined,        // 17 requireBrowserAuth
      undefined,        // 18 operatorUsers
      undefined,        // 19 operatorSet
      cellAccess,       // 20 cellAccess
    );

    const opWs = makeFakeWs();
    const guestWs = makeFakeWs();
    gateway.wss.emit("connection", opWs, { wsPrincipal: OP });
    gateway.wss.emit("connection", guestWs, { wsPrincipal: GUEST });

    // Raise a capsule in session A — the prompt_request the bridge forwards for
    // a ctx.ui.select capsule (bash-security / skill-mandate / cell-done-gate) or
    // the real ask_user tool — via the real registry seam.
    gateway.trackPromptRequest("A", {
      promptId: "p1",
      sessionId: "A",
      prompt: {
        question: "Run flagged command? Default in 30 minutes: Cancel + revert (safety-first).",
        type: "select",
        options: [
          "(1) Proceed [requires explicit ratify]",
          "(3) Cancel + revert [DEFAULT - default-fire 30min safety-first canonical]",
        ],
      },
    } as never);

    // (1) OPERATOR received it, with the right shape + accurate deadline.
    const opAfter = pendingMsgs(opWs);
    const opLast = opAfter[opAfter.length - 1];
    expect(opLast).toBeTruthy();
    expect(opLast.items).toHaveLength(1);
    const item = opLast.items[0] as Record<string, any>;
    expect(item.sessionId).toBe("A");
    expect(item.sessionName).toBe("session-A");
    expect(item.promptId).toBe("p1");
    expect(String(item.questionPreview)).toContain("Run flagged command?");
    expect(String(item.defaultLabel)).toContain("[DEFAULT");
    expect(typeof item.firstSeenAt).toBe("number");
    expect(item.deadlineAt).toBe(item.firstSeenAt + 300 * 1000); // server-enforced 300s

    // (2) GUEST received NOTHING — the admin-only gate (no cross-operator leak).
    expect(pendingMsgs(guestWs)).toHaveLength(0);

    // (3) resolve → cleared broadcast to the operator (empty items); guest still nothing.
    gateway.clearPromptRequest("A", "p1");
    const opFinal = pendingMsgs(opWs);
    expect(opFinal[opFinal.length - 1].items).toHaveLength(0);
    expect(pendingMsgs(guestWs)).toHaveLength(0);
  });
});
