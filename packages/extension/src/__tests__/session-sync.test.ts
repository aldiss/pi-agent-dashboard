/**
 * Tests for session-sync: sendStateSync and handleSessionSwitch.
 */
import { describe, it, expect, vi } from "vitest";
import { sendStateSync, handleSessionChange, replaySessionEntries } from "../session-sync.js";
import type { BridgeContext } from "../bridge-context.js";

function createMockBridgeContext(overrides?: Partial<BridgeContext>): BridgeContext {
  const sent: any[] = [];
  return {
    pi: {
      getSessionName: () => "test-session",
      getCommands: () => [],
    } as any,
    connection: {
      send: (msg: any) => sent.push(msg),
    } as any,
    sessionId: "sess-123",
    cachedCtx: {
      sessionManager: {
        getSessionFile: () => "/path/to/session.json",
        getSessionDir: () => "/path/to/session",
        getBranch: () => [{ role: "user", content: "hello" }],
        getEntries: () => [{ role: "user", content: "hello" }],
      },
    },
    cachedModelRegistry: null,
    cachedHasUI: true,
    lastModel: undefined,
    lastThinkingLevel: undefined,
    lastSessionFile: undefined,
    lastSessionDir: undefined,
    lastFirstMessage: undefined,
    lastGitBranch: undefined,
    lastGitPrNumber: undefined,
    lastSessionName: undefined,
    hasRegisteredOnce: false,
    ...overrides,
    // Expose sent messages for assertions
    _sent: sent,
  } as any;
}

describe("sendStateSync", () => {
  it("should include pid in session_register message", () => {
    const bc = createMockBridgeContext();
    sendStateSync(bc, () => []);

    const sent = (bc as any)._sent;
    const registerMsg = sent.find((m: any) => m.type === "session_register");
    expect(registerMsg).toBeDefined();
    expect(registerMsg.pid).toBe(process.pid);
    expect(typeof registerMsg.pid).toBe("number");
    expect(registerMsg.pid).toBeGreaterThan(0);
  });

  // ── reattach-move-to-front ──

  it("first sendStateSync after boot tags registerReason: spawn", () => {
    const bc = createMockBridgeContext();
    expect(bc.hasRegisteredOnce).toBe(false);

    sendStateSync(bc, () => []);

    const sent = (bc as any)._sent;
    const registerMsg = sent.find((m: any) => m.type === "session_register");
    expect(registerMsg.registerReason).toBe("spawn");
    expect(bc.hasRegisteredOnce).toBe(true);
  });

  it("second sendStateSync (reconnect) tags registerReason: reattach", () => {
    const bc = createMockBridgeContext();

    sendStateSync(bc, () => []);
    // Clear sent, simulate reconnect
    (bc as any)._sent.length = 0;
    sendStateSync(bc, () => []);

    const sent = (bc as any)._sent;
    const registerMsg = sent.find((m: any) => m.type === "session_register");
    expect(registerMsg.registerReason).toBe("reattach");
    expect(bc.hasRegisteredOnce).toBe(true);
  });

  it("hasRegisteredOnce flips exactly once and stays true", () => {
    const bc = createMockBridgeContext();

    sendStateSync(bc, () => []);
    expect(bc.hasRegisteredOnce).toBe(true);

    sendStateSync(bc, () => []);
    expect(bc.hasRegisteredOnce).toBe(true);

    sendStateSync(bc, () => []);
    expect(bc.hasRegisteredOnce).toBe(true);
  });

  it("third+ sendStateSync continues to tag reattach", () => {
    const bc = createMockBridgeContext();

    sendStateSync(bc, () => []);
    sendStateSync(bc, () => []);
    (bc as any)._sent.length = 0;
    sendStateSync(bc, () => []);

    const sent = (bc as any)._sent;
    const registerMsg = sent.find((m: any) => m.type === "session_register");
    expect(registerMsg.registerReason).toBe("reattach");
  });
});

describe("replaySessionEntries persisted assets", () => {
  it("re-registers asset bytes before the referencing message events", () => {
    const hash = "0123456789abcdef";
    const entry = {
      id: "entry-1",
      type: "message",
      timestamp: new Date(1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "source" }],
        audience: "agent",
        dashboardAssets: [{ hash, mimeType: "image/png", data: "AAAA" }],
      },
    };
    const bc = createMockBridgeContext({
      cachedCtx: { sessionManager: { getBranch: () => [entry] } } as any,
    });

    replaySessionEntries(bc);

    const sent = (bc as any)._sent;
    expect(sent[0]).toEqual({
      type: "asset_register",
      sessionId: "sess-123",
      hash,
      mimeType: "image/png",
      data: "AAAA",
    });
    const forwarded = sent.filter((message: any) => message.type === "event_forward");
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded.every((message: any) =>
      !("dashboardAssets" in (message.event.data.message ?? {})),
    )).toBe(true);
  });
});

describe("handleSessionChange", () => {
  it("always tags registerReason: spawn even after reattach", () => {
    const bc = createMockBridgeContext({ hasRegisteredOnce: true } as any);

    const ctx = {
      cwd: "/proj",
      sessionManager: {
        getSessionId: () => "sess-new",
        getSessionFile: () => "/path/new.json",
        getSessionDir: () => "/path",
        getBranch: () => [],
        getEntries: () => [],
      },
    };

    handleSessionChange(bc, ctx as any, () => []);

    const sent = (bc as any)._sent;
    const registerMsg = sent.find((m: any) => m.type === "session_register");
    expect(registerMsg).toBeDefined();
    expect(registerMsg.sessionId).toBe("sess-new");
    expect(registerMsg.registerReason).toBe("spawn");
  });
});

// See change: dashboard-session-naming-clarity-fix Bug B-1.
// PI_AGENT_NAME env-var fallback when pi.getSessionName() is unset/empty,
// so standing-crew + cell-executor sessions spawned via tmux+`PI_AGENT_NAME=...`
// surface a canonical-meaningful name in the dashboard sidebar without the
// operator needing to manually `/name` every session. Sister to AGENTS.md
// § Graceful-restart discipline v0.2 Fix 4 + standing-crew v1.3.1.
describe("sendStateSync: PI_AGENT_NAME fallback (Bug B-1)", () => {
  const ENV_VAR = "PI_AGENT_NAME";

  function withEnvVar<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[ENV_VAR];
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prior;
    }
  }

  it("uses pi.getSessionName() when present (existing behavior preserved)", () => {
    withEnvVar("DashboardSessionNamingClarityFix", () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => "explicit-via-slash-command",
          getCommands: () => [],
        } as any,
      });
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.name).toBe("explicit-via-slash-command");
    });
  });

  it("falls back to PI_AGENT_NAME env-var when getSessionName() returns undefined", () => {
    withEnvVar("DashboardSessionNamingClarityFix", () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => undefined,
          getCommands: () => [],
        } as any,
      });
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.name).toBe("DashboardSessionNamingClarityFix");
    });
  });

  it("falls back to PI_AGENT_NAME env-var when getSessionName() returns null", () => {
    withEnvVar("Joan", () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => null as any,
          getCommands: () => [],
        } as any,
      });
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.name).toBe("Joan");
    });
  });

  it("sends undefined name when both getSessionName() AND PI_AGENT_NAME are unset", () => {
    withEnvVar(undefined, () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => undefined,
          getCommands: () => [],
        } as any,
      });
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.name).toBeUndefined();
    });
  });
});

describe("handleSessionChange: PI_AGENT_NAME fallback (Bug B-1)", () => {
  const ENV_VAR = "PI_AGENT_NAME";

  function withEnvVar<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[ENV_VAR];
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prior;
    }
  }

  function makeCtx() {
    return {
      cwd: "/proj",
      sessionManager: {
        getSessionId: () => "sess-new",
        getSessionFile: () => "/path/new.json",
        getSessionDir: () => "/path",
        getBranch: () => [],
        getEntries: () => [],
      },
    };
  }

  it("uses pi.getSessionName() when present", () => {
    withEnvVar("DashboardSessionNamingClarityFix", () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => "explicit-name",
          getCommands: () => [],
        } as any,
      });
      handleSessionChange(bc, makeCtx() as any, () => []);
      expect(bc.lastSessionName).toBe("explicit-name");
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register" && m.sessionId === "sess-new");
      expect(registerMsg.name).toBe("explicit-name");
    });
  });

  it("falls back to PI_AGENT_NAME env-var when getSessionName() empty", () => {
    withEnvVar("DashboardSessionNamingClarityFix", () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => undefined,
          getCommands: () => [],
        } as any,
      });
      handleSessionChange(bc, makeCtx() as any, () => []);
      expect(bc.lastSessionName).toBe("DashboardSessionNamingClarityFix");
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register" && m.sessionId === "sess-new");
      expect(registerMsg.name).toBe("DashboardSessionNamingClarityFix");
    });
  });

  it("sends undefined name when both unset", () => {
    withEnvVar(undefined, () => {
      const bc = createMockBridgeContext({
        pi: {
          getSessionName: () => undefined,
          getCommands: () => [],
        } as any,
      });
      handleSessionChange(bc, makeCtx() as any, () => []);
      expect(bc.lastSessionName).toBe("");
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register" && m.sessionId === "sess-new");
      expect(registerMsg.name).toBeUndefined();
    });
  });
});

// See change: spawn-correlation-token — bridge token inclusion contract.
describe("sendStateSync: spawnToken from env", () => {
  const ENV_VAR = "PI_DASHBOARD_SPAWN_TOKEN";

  function withEnvVar<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[ENV_VAR];
    if (value === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = prior;
    }
  }

  it("first register includes spawnToken from env", () => {
    withEnvVar("tok_first", () => {
      const bc = createMockBridgeContext({ hasRegisteredOnce: false } as any);
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.spawnToken).toBe("tok_first");
      expect(registerMsg.registerReason).toBe("spawn");
    });
  });

  it("reattach register omits spawnToken (even when env still set)", () => {
    withEnvVar("tok_first", () => {
      const bc = createMockBridgeContext({ hasRegisteredOnce: true } as any);
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.spawnToken).toBeUndefined();
      expect(registerMsg.registerReason).toBe("reattach");
    });
  });

  it("first register without env var omits spawnToken", () => {
    withEnvVar(undefined, () => {
      const bc = createMockBridgeContext({ hasRegisteredOnce: false } as any);
      sendStateSync(bc, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register");
      expect(registerMsg.spawnToken).toBeUndefined();
      expect(registerMsg.registerReason).toBe("spawn");
    });
  });

  it("handleSessionChange register omits spawnToken (in-process new/fork/resume)", () => {
    withEnvVar("tok_first", () => {
      const bc = createMockBridgeContext({ hasRegisteredOnce: true } as any);
      const ctx = {
        cwd: "/proj",
        sessionManager: {
          getSessionId: () => "sess-fork",
          getSessionFile: () => "/path/new.json",
          getSessionDir: () => "/path",
          getBranch: () => [],
          getEntries: () => [],
        },
      };
      handleSessionChange(bc, ctx as any, () => []);
      const sent = (bc as any)._sent;
      const registerMsg = sent.find((m: any) => m.type === "session_register" && m.sessionId === "sess-fork");
      expect(registerMsg).toBeDefined();
      expect(registerMsg.spawnToken).toBeUndefined();
      expect(registerMsg.registerReason).toBe("spawn");
    });
  });
});
