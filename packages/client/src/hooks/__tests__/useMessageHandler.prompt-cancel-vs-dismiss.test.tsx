/**
 * dl-13559 regression: a bus TIMEOUT (prompt_cancel) must set the interactive
 * request's status to "cancelled" (→ renders "No response"), NOT "dismissed"
 * (→ "Answered in terminal", a false TUI-answer claim). A genuine TUI answer
 * (prompt_dismiss) must still set "dismissed" (preserved).
 *
 * The dispatch returned by `useMessageHandler` is a pure switch on `msg.type`;
 * we render the hook with stub setters and inspect the sessionStates map.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMessageHandler, type MessageHandlerSetters, type MessageHandlerDeps } from "../useMessageHandler.js";
import { createInitialState, addInteractiveRequest, type SessionState } from "../../lib/event-reducer.js";

function makeRefs() {
  return {
    spawningCwdsRef: { current: new Set<string>() },
    subscribedRef: { current: new Set<string>() },
    pendingTerminalCwdRef: { current: null },
    lastCreatedTerminalIdRef: { current: null },
    maxSeqMapRef: { current: new Map<string, number>() },
    selectedSessionIdRef: { current: undefined },
    pendingSpawnsRef: { current: new Map<string, { cwd: string; kind: "spawn" | "resume" }>() },
  } satisfies Pick<
    MessageHandlerDeps,
    "spawningCwdsRef" | "subscribedRef" | "pendingTerminalCwdRef" | "lastCreatedTerminalIdRef" | "maxSeqMapRef" | "selectedSessionIdRef" | "pendingSpawnsRef"
  >;
}

function makeHarness(initialState: Map<string, SessionState>) {
  let sessionStates = initialState;
  const setSessionStates = ((updater: any) => {
    sessionStates = typeof updater === "function" ? updater(sessionStates) : updater;
  }) as React.Dispatch<React.SetStateAction<Map<string, SessionState>>>;

  const noop = ((_: any) => {}) as any;
  const setters: MessageHandlerSetters = {
    setSessions: noop,
    setSessionStates,
    setSessionCommands: noop,
    setSessionFlows: noop,
    setFileResults: noop,
    setOpenspecMap: noop,
    setOpenspecGroupsMap: noop,
    setModelsMap: noop,
    setRolesMap: noop,
    setSpawnResult: noop,
    setSessionOrderMap: noop,
    setPinnedDirectories: noop,
    setTerminals: noop,
    setEditorStatuses: noop,
    setDiscoveredServers: noop,
    setSpawnErrors: noop,
    setResumeErrors: noop,
    setPresenceMap: noop,
    setPendingOperatorInputs: noop,
  };

  const deps: MessageHandlerDeps = {
    send: () => {},
    navigate: () => {},
    clearSpawningCwd: () => {},
    ...makeRefs(),
  };

  const { result } = renderHook(() => useMessageHandler(setters, deps));
  return {
    dispatch: (msg: any) => act(() => result.current(msg)),
    getStates: () => sessionStates,
  };
}

const SID = "session-abc";
const PROMPT_ID = "prompt-1";

function stateWithPendingRequest(): Map<string, SessionState> {
  const s = addInteractiveRequest(createInitialState(), PROMPT_ID, "select", { title: "Deploy now?", options: ["A", "B"] });
  return new Map<string, SessionState>([[SID, s]]);
}

function statusOf(states: Map<string, SessionState>): string | undefined {
  return states.get(SID)?.interactiveRequests.find((r) => r.requestId === PROMPT_ID)?.status;
}

describe("useMessageHandler — prompt_cancel vs prompt_dismiss routing (dl-13559)", () => {
  it("[able-to-fail] prompt_cancel (bus timeout) → request status becomes 'cancelled', NOT 'dismissed'", () => {
    const { dispatch, getStates } = makeHarness(stateWithPendingRequest());
    expect(statusOf(getStates())).toBe("pending");

    dispatch({ type: "prompt_cancel", sessionId: SID, promptId: PROMPT_ID });

    expect(statusOf(getStates())).toBe("cancelled"); // RED pre-fix (was routed to dismissInteractiveRequest → "dismissed")
    expect(statusOf(getStates())).not.toBe("dismissed");
  });

  it("prompt_dismiss (answered in TUI) → request status becomes 'dismissed' (preserved)", () => {
    const { dispatch, getStates } = makeHarness(stateWithPendingRequest());
    expect(statusOf(getStates())).toBe("pending");

    dispatch({ type: "prompt_dismiss", sessionId: SID, promptId: PROMPT_ID });

    expect(statusOf(getStates())).toBe("dismissed");
    expect(statusOf(getStates())).not.toBe("cancelled");
  });

  it("cancel then dismiss on distinct prompts stay distinct (no cross-contamination)", () => {
    const s = addInteractiveRequest(
      addInteractiveRequest(createInitialState(), "p-cancel", "select", { title: "A?", options: ["x"] }),
      "p-dismiss", "select", { title: "B?", options: ["y"] },
    );
    const { dispatch, getStates } = makeHarness(new Map([[SID, s]]));

    dispatch({ type: "prompt_cancel", sessionId: SID, promptId: "p-cancel" });
    dispatch({ type: "prompt_dismiss", sessionId: SID, promptId: "p-dismiss" });

    const reqs = getStates().get(SID)!.interactiveRequests;
    expect(reqs.find((r) => r.requestId === "p-cancel")?.status).toBe("cancelled");
    expect(reqs.find((r) => r.requestId === "p-dismiss")?.status).toBe("dismissed");
  });
});
