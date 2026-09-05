import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSessionActions, type SessionActionDeps } from "../useSessionActions.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

function renderActions() {
  const send = vi.fn();
  const deps: SessionActionDeps = {
    selectedId: "codex-session", send, navigate: vi.fn(), setMobileOpen: vi.fn(),
    setSessions: vi.fn(), setSessionStates: vi.fn(), setSpawningCwds: vi.fn(), setTerminals: vi.fn(),
    clearSpawningCwd: vi.fn(), spawnTimeoutsRef: { current: new Map() },
    pendingTerminalCwdRef: { current: null }, terminals: new Map(), pendingSpawnsRef: { current: new Map() },
  };
  return { ...renderHook(() => useSessionActions(deps)), send };
}

describe("session runtime wire actions", () => {
  it("preserves the existing pi spawn payload when runtime is omitted", () => {
    const { result, send } = renderActions();
    act(() => result.current.handleSpawnSession("/project", "attached-change"));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "spawn_session", cwd: "/project", attachProposal: "attached-change", requestId: expect.any(String) });
  });

  it("appends Codex runtime without repurposing the attachment argument", () => {
    const { result, send } = renderActions();
    act(() => result.current.handleSpawnSession("/project", "attached-change", "codex"));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "spawn_session", cwd: "/project", attachProposal: "attached-change", runtime: "codex", requestId: expect.any(String) });
  });

  it("reuses existing resume, abort and shutdown messages with no terminal message", () => {
    const { result, send } = renderActions();
    act(() => {
      result.current.handleResumeSession("codex-session", "continue");
      result.current.handleAbort();
      result.current.handleShutdownSession("codex-session");
    });
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "resume_session", sessionId: "codex-session", mode: "continue", placement: "front", requestId: expect.any(String) },
      { type: "abort", sessionId: "codex-session" },
      { type: "shutdown", sessionId: "codex-session" },
    ]);
  });
});
