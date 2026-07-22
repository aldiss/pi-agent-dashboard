import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type React from "react";

// Fix e101284 (client half): on a send_prompt_failed carrying an AUTH reason
// (no-principal / invalid-principal — the WS principal was absent/dropped, e.g.
// after a server bounce) the client must re-auth (redirectToLogin) so the operator
// gets a path back, instead of a silently stranded send. A per-session refusal
// (session-unavailable) or a bridge-absent failure (no reason) must NOT redirect.
const { redirectToLogin } = vi.hoisted(() => ({ redirectToLogin: vi.fn() }));
vi.mock("../hooks/useAuthStatus.js", () => ({
  redirectToLogin,
  useAuthStatus: () => ({ authenticated: false }),
}));

import { useMessageHandler, type MessageHandlerSetters, type MessageHandlerDeps } from "../hooks/useMessageHandler.js";
import { type SessionState } from "../lib/event-reducer.js";

function makeRefs() {
  return {
    spawningCwdsRef: { current: new Set<string>() },
    subscribedRef: { current: new Set<string>() },
    pendingTerminalCwdRef: { current: null },
    lastCreatedTerminalIdRef: { current: null },
    maxSeqMapRef: { current: new Map<string, number>() },
    selectedSessionIdRef: { current: undefined },
    pendingSpawnsRef: { current: new Map<string, { cwd: string; kind: "spawn" | "resume" }>() },
  };
}

function makeHarness() {
  let sessionStates = new Map<string, SessionState>();
  const setSessionStates = ((u: any) => {
    sessionStates = typeof u === "function" ? u(sessionStates) : u;
  }) as React.Dispatch<React.SetStateAction<Map<string, SessionState>>>;
  const noop = ((_: any) => {}) as any;
  const setters: MessageHandlerSetters = {
    setSessions: noop, setSessionStates, setSessionCommands: noop, setSessionFlows: noop,
    setFileResults: noop, setOpenspecMap: noop, setOpenspecGroupsMap: noop, setModelsMap: noop,
    setRolesMap: noop, setSpawnResult: noop, setSessionOrderMap: noop, setPinnedDirectories: noop,
    setTerminals: noop, setEditorStatuses: noop, setDiscoveredServers: noop, setSpawnErrors: noop,
    setResumeErrors: noop, setPresenceMap: noop, setPendingOperatorInputs: noop,
  };
  const deps: MessageHandlerDeps = { send: () => {}, navigate: () => {}, clearSpawningCwd: () => {}, ...makeRefs() };
  const { result } = renderHook(() => useMessageHandler(setters, deps));
  return { dispatch: (msg: any) => act(() => result.current(msg)) };
}

describe("useMessageHandler — re-auth on send_prompt_failed principal loss (fix e101284)", () => {
  beforeEach(() => redirectToLogin.mockClear());

  it("redirects to login on reason=no-principal", () => {
    makeHarness().dispatch({ type: "send_prompt_failed", sessionId: "s1", reason: "no-principal" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("redirects to login on reason=invalid-principal", () => {
    makeHarness().dispatch({ type: "send_prompt_failed", sessionId: "s1", reason: "invalid-principal" });
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("does NOT redirect on a non-auth failure (session-unavailable / bridge-absent / no reason)", () => {
    const h = makeHarness();
    h.dispatch({ type: "send_prompt_failed", sessionId: "s1", reason: "session-unavailable" });
    h.dispatch({ type: "send_prompt_failed", sessionId: "s1", queueNonce: "n1" });
    expect(redirectToLogin).not.toHaveBeenCalled();
  });
});
