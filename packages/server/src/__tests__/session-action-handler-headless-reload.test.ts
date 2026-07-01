/**
 * Tests for server-side /reload handling on headless pi sessions.
 *
 * See change: headless-reload-via-respawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock spawnPiSession BEFORE importing the handler.
vi.mock("../process-manager.js", () => ({
  spawnPiSession: vi.fn(),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", () => ({
  loadConfig: () => ({ spawnStrategy: "headless" as const }),
}));

import {
  handleHeadlessReload,
  handleSendPrompt,
} from "../browser-handlers/session-action-handler.js";
import { spawnPiSession } from "../process-manager.js";

type SentMessage = { type: string; [k: string]: unknown };
type InsertedEvent = {
  sessionId: string;
  event: { eventType: string; data: Record<string, unknown>; timestamp: number };
};

function makeCtx(
  options: {
    pidBySession?: Record<string, number | undefined>;
    sessions?: Record<string, any>;
  } = {},
) {
  const broadcasts: SentMessage[] = [];
  const insertedEvents: InsertedEvent[] = [];
  const killCalls: string[] = [];
  const registerCalls: Array<{ pid: number; cwd: string; proc: unknown }> = [];
  const sessionUpdates: Array<{ id: string; updates: any }> = [];

  const pidBySession: Record<string, number | undefined> = {
    ...(options.pidBySession ?? {}),
  };
  const sessions: Record<string, any> = { ...(options.sessions ?? {}) };

  const ctx = {
    ws: { readyState: 1 } as any,
    sessionManager: {
      get: (sid: string) => sessions[sid],
      update: (sid: string, updates: any) => {
        sessionUpdates.push({ id: sid, updates });
        if (sessions[sid]) Object.assign(sessions[sid], updates);
      },
      unregister: vi.fn(),
    },
    piGateway: {
      sendToSession: vi.fn().mockReturnValue(true),
      // Fix-11 amend: handleHeadlessReload's §19 respawn resolves the anti-cross-
      // wire pin via resolvePinDashboardUrl(ctx.piGateway). A null address →
      // no pin (no serverPiPort here); the no-crash guard keeps it safe.
      address: () => null,
    },
    headlessPidRegistry: {
      getPid: (sid: string) => pidBySession[sid],
      killBySessionId: (sid: string) => {
        killCalls.push(sid);
        // Simulate immediate removal from registry on kill
        pidBySession[sid] = undefined;
        return true;
      },
      register: (pid: number, cwd: string, proc: unknown) => {
        registerCalls.push({ pid, cwd, proc });
        // Simulate the registry linking the session after re-register
        const existingSessionId = Object.keys(sessions).find(
          (id) => sessions[id]?.cwd === cwd,
        );
        if (existingSessionId) pidBySession[existingSessionId] = pid;
      },
    },
    pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() },
    pendingDashboardSpawns: new Map<string, number>(),
    eventStore: {
      insertEvent: (sid: string, event: any) => {
        insertedEvents.push({ sessionId: sid, event });
        return insertedEvents.length; // fake seq
      },
    },
    broadcast: (m: SentMessage) => {
      broadcasts.push(m);
    },
    sendTo: (_ws: unknown, m: SentMessage) => {
      broadcasts.push(m);
    },
  } as any;

  return {
    ctx,
    broadcasts,
    insertedEvents,
    killCalls,
    registerCalls,
    sessionUpdates,
    pidBySession,
    sessions,
  };
}

function findFeedback(events: InsertedEvent[]) {
  return events
    .filter((e) => e.event.eventType === "command_feedback")
    .map((e) => e.event.data);
}

describe("handleHeadlessReload — happy path (Fix-11 amend: §19 interactive resume)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("kills old pi, respawns via §19 interactive form (NOT headless), does NOT headless-register, emits started+completed", async () => {
    // A §19 interactive (tmux) respawn is detached — no pid/process.
    (spawnPiSession as any).mockResolvedValueOnce({
      success: true,
      message: "Pi session spawned in tmux (new window)",
      dashboardSpawned: true,
    });

    const { ctx, killCalls, registerCalls, insertedEvents } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          name: "Pete",
          cwd: "/home/u/proj",
          sessionFile: "/home/u/proj/.pi/sessions/abc.jsonl",
          status: "active",
        },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    // Kill came before spawn
    expect(killCalls).toEqual(["S1"]);
    expect(spawnPiSession).toHaveBeenCalledTimes(1);
    // Fix-11 amend: the sessionFile-replay MUST use the §19 interactive form —
    // strategy:"tmux" + requireInteractive:true, NEVER hardcoded "headless".
    const spawnArgs = (spawnPiSession as any).mock.calls[0][1];
    expect(spawnArgs.strategy).toBe("tmux");
    expect(spawnArgs.requireInteractive).toBe(true);
    expect(spawnArgs.sessionFile).toBe("/home/u/proj/.pi/sessions/abc.jsonl");
    expect(spawnArgs.mode).toBe("continue");
    expect(spawnArgs.agentName).toBe("Pete"); // §19 identity from the session name
    // Falsifiable: the crash-class strategy must NOT appear.
    expect(spawnArgs.strategy).not.toBe("headless");

    // EXPLICIT no-headless-register: the interactive session is NOT tracked in
    // the headless-pid registry (that's the routing key for shouldInterceptReload;
    // a future /reload must route to the TUI path, not back here).
    expect(registerCalls).toHaveLength(0);

    // Feedback sequence: started → completed
    const feedback = findFeedback(insertedEvents);
    expect(feedback.map((f) => f.status)).toEqual(["started", "completed"]);
  });
});

describe("handleHeadlessReload — streaming session", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("rejects reload when session is streaming; no kill, no spawn", async () => {
    const { ctx, killCalls, insertedEvents } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "streaming",
        },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(killCalls).toEqual([]);
    expect(spawnPiSession).not.toHaveBeenCalled();

    const feedback = findFeedback(insertedEvents);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].status).toBe("error");
    expect(String(feedback[0].message)).toMatch(/response/i);
  });
});

describe("handleHeadlessReload — spawn failure", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("broadcasts session_updated{status:ended} and error feedback when spawnPiSession returns failure", async () => {
    (spawnPiSession as any).mockResolvedValueOnce({
      success: false,
      message: "tmux unavailable, headless failed",
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { ctx, broadcasts, sessionUpdates, insertedEvents } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("headless reload spawn failed"),
    );

    // Session marked ended
    expect(
      sessionUpdates.some(
        (u) => u.id === "S1" && u.updates.status === "ended",
      ),
    ).toBe(true);
    // session_updated broadcast
    expect(
      broadcasts.some(
        (m) =>
          m.type === "session_updated" &&
          (m as any).sessionId === "S1" &&
          ((m as any).updates as any).status === "ended",
      ),
    ).toBe(true);

    // Final feedback is error
    const feedback = findFeedback(insertedEvents);
    expect(feedback[feedback.length - 1].status).toBe("error");
    expect(String(feedback[feedback.length - 1].message)).toContain(
      "tmux unavailable",
    );

    errSpy.mockRestore();
  });

  it("handles spawnPiSession throwing", async () => {
    (spawnPiSession as any).mockRejectedValueOnce(new Error("ENOENT: pi not found"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { ctx, sessionUpdates, insertedEvents } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: { id: "S1", cwd: "/p", sessionFile: "/p/s.jsonl", status: "active" },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(
      sessionUpdates.some((u) => u.updates.status === "ended"),
    ).toBe(true);
    const feedback = findFeedback(insertedEvents);
    expect(feedback[feedback.length - 1].status).toBe("error");
    expect(String(feedback[feedback.length - 1].message)).toMatch(/ENOENT/);

    errSpy.mockRestore();
  });
});

describe("handleHeadlessReload — missing session file", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("errors when the session has no sessionFile", async () => {
    const { ctx, insertedEvents, killCalls } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: { id: "S1", cwd: "/p", status: "active" },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(killCalls).toEqual([]);
    expect(spawnPiSession).not.toHaveBeenCalled();

    const feedback = findFeedback(insertedEvents);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].status).toBe("error");
  });
});

describe("handleHeadlessReload — concurrent calls (Fix-11 amend)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("two back-to-back /reload calls both respawn interactive; neither headless-registers", async () => {
    // Interactive respawns are detached (no pid/process).
    (spawnPiSession as any).mockImplementation(async () => ({
      success: true,
      message: "Pi session spawned in tmux (new window)",
      dashboardSpawned: true,
    }));

    const { ctx, killCalls, registerCalls, pidBySession } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          name: "Pete",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    // Fire two concurrent reloads.
    const [r1, r2] = await Promise.all([
      handleHeadlessReload(
        { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
        ctx,
      ),
      handleHeadlessReload(
        { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
        ctx,
      ),
    ]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    // First call kills the original; second call observes no PID and kills noop.
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(killCalls.length).toBeLessThanOrEqual(2);

    // Both calls spawned interactive, but NEITHER headless-registered — and the
    // headless pid mapping ends CLEARED (killBySessionId nulled it; no re-add),
    // so a subsequent /reload routes to the TUI path, not back here.
    expect(spawnPiSession).toHaveBeenCalledTimes(2);
    expect(registerCalls).toHaveLength(0);
    expect(pidBySession.S1).toBeUndefined();
  });
});

describe("handleHeadlessReload — fail-loud when tmux unavailable (Fix-11 amend)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("surfaces INTERACTIVE_UNAVAILABLE as error feedback + ends the session (no silent headless degrade)", async () => {
    // Compose with Fix-10: the §19 form fails loud when no interactive terminal
    // can be resolved — spawnPiSession returns the INTERACTIVE_UNAVAILABLE code.
    (spawnPiSession as any).mockResolvedValueOnce({
      success: false,
      code: "INTERACTIVE_UNAVAILABLE",
      message:
        "interactive session-resume required but no interactive terminal " +
        "(tmux / Windows Terminal / WSL-tmux) could be resolved on this host.",
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { ctx, registerCalls, sessionUpdates, insertedEvents } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: { id: "S1", name: "Pete", cwd: "/p", sessionFile: "/p/s.jsonl", status: "active" },
      },
    });

    await handleHeadlessReload(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    // Never headless-registered on the fail-loud path either.
    expect(registerCalls).toHaveLength(0);
    // Session marked ended + error feedback carries the loud message.
    expect(sessionUpdates.some((u) => u.id === "S1" && u.updates.status === "ended")).toBe(true);
    const feedback = findFeedback(insertedEvents);
    expect(feedback[feedback.length - 1].status).toBe("error");
    expect(String(feedback[feedback.length - 1].message)).toMatch(/interactive session-resume required|tmux/i);

    errSpy.mockRestore();
  });
});

describe("handleSendPrompt — interception wiring", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("/reload on a headless session triggers respawn, NOT bridge forward", async () => {
    (spawnPiSession as any).mockResolvedValueOnce({
      success: true,
      pid: 4242,
      process: { _fake: true },
    });

    const { ctx } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    await handleSendPrompt(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(spawnPiSession).toHaveBeenCalledTimes(1);
    expect(ctx.piGateway.sendToSession).not.toHaveBeenCalled();
  });

  it("/reload on a non-headless (tmux) session forwards to the bridge unchanged", async () => {
    const { ctx } = makeCtx({
      pidBySession: { S1: undefined }, // no PID → non-headless
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    await handleSendPrompt(
      { type: "send_prompt", sessionId: "S1", text: "/reload" } as any,
      ctx,
    );

    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(ctx.piGateway.sendToSession).toHaveBeenCalledWith(
      "S1",
      expect.objectContaining({
        type: "send_prompt",
        text: "/reload",
      }),
    );
  });

  it("non-/reload prompt on a headless session still forwards to the bridge", async () => {
    const { ctx } = makeCtx({
      pidBySession: { S1: 1234 }, // headless
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    await handleSendPrompt(
      {
        type: "send_prompt",
        sessionId: "S1",
        text: "please do the thing",
      } as any,
      ctx,
    );

    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(ctx.piGateway.sendToSession).toHaveBeenCalledWith(
      "S1",
      expect.objectContaining({ text: "please do the thing" }),
    );
  });

  it("/reload with images on a headless session is NOT intercepted (falls through to bridge)", async () => {
    const { ctx } = makeCtx({
      pidBySession: { S1: 1234 },
      sessions: {
        S1: {
          id: "S1",
          cwd: "/p",
          sessionFile: "/p/s.jsonl",
          status: "active",
        },
      },
    });

    await handleSendPrompt(
      {
        type: "send_prompt",
        sessionId: "S1",
        text: "/reload",
        images: [{ type: "image", data: "x" }],
      } as any,
      ctx,
    );

    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(ctx.piGateway.sendToSession).toHaveBeenCalled();
  });
});
