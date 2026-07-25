// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useMessageHandler } from "../useMessageHandler.js";
import { OPERATOR_BUFFER_TIMEOUT_MS, type SessionState } from "../../lib/event-reducer.js";
import { OPERATOR_DELIVERY_FALLBACK, sha256Hex } from "../../lib/operator-delivery.js";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";

function setup() {
  const noop = vi.fn();
  const baseSetters: any = {
    setSessions: noop,
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
  const deps: any = {
    send: noop,
    navigate: noop,
    clearSpawningCwd: noop,
    spawningCwdsRef: { current: new Set() },
    subscribedRef: { current: new Set() },
    pendingTerminalCwdRef: { current: null },
    lastCreatedTerminalIdRef: { current: null },
    maxSeqMapRef: { current: new Map() },
    selectedSessionIdRef: { current: undefined },
    pendingSpawnsRef: { current: new Map() },
  };
  const hook = renderHook(() => {
    const [states, setSessionStates] = useState(new Map<string, SessionState>());
    const dispatch = useMessageHandler({ ...baseSetters, setSessionStates }, deps);
    return { states, dispatch };
  });
  return {
    ...hook,
    dispatch(...messages: ServerToBrowserMessage[]) {
      act(() => {
        for (const message of messages) hook.result.current.dispatch(message);
      });
    },
  };
}

function event(
  sessionId: string,
  seq: number,
  eventType: string,
  timestamp: number,
  data: Record<string, unknown>,
): ServerToBrowserMessage {
  return {
    type: "event",
    sessionId,
    seq,
    event: { eventType, timestamp, data },
  } as ServerToBrowserMessage;
}

function start(sessionId: string, seq: number, timestamp: number, audience?: "operator" | "agent" | "unknown", nonce = "nonce-1") {
  return event(sessionId, seq, "message_start", timestamp, {
    message: { role: "assistant", content: [], ...(audience ? { audience } : {}) },
    nonce,
  });
}

function update(sessionId: string, seq: number, timestamp: number, text = "raw source", audience?: "operator" | "agent" | "unknown", nonce = "nonce-1") {
  return event(sessionId, seq, "message_update", timestamp, {
    message: { role: "assistant", content: text, ...(audience ? { audience } : {}) },
    assistantMessageEvent: { type: "text_delta", delta: text },
    nonce,
  });
}

afterEach(() => vi.useRealTimers());

describe("useMessageHandler operator delivery timeout", () => {
  it("arms under React-owned deferred state and unrelated events do not extend the deadline", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const { dispatch, result } = setup();
    const sid = "session-timeout";

    // One batched act exercises the case where React runs both functional
    // updaters only after the callback returns.
    dispatch(start(sid, 1, startedAt), update(sid, 2, startedAt, "raw source"));
    act(() => vi.advanceTimersByTime(20_000));
    dispatch(event(sid, 3, "tool_execution_update", startedAt + 20_000, {
      toolCallId: "t1",
      partialResult: "still running",
    }));

    act(() => vi.advanceTimersByTime(OPERATOR_BUFFER_TIMEOUT_MS - 20_000 - 1));
    expect(result.current.states.get(sid)?.messages).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.states.get(sid)?.messages.map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);
  });

  it("moves the deadline only for a later assistant partial", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_100_000;
    vi.setSystemTime(startedAt);
    const { dispatch, result } = setup();
    const sid = "session-rearm";
    dispatch(start(sid, 1, startedAt), update(sid, 2, startedAt));
    act(() => vi.advanceTimersByTime(20_000));
    dispatch(update(sid, 3, startedAt + 20_000, "later partial"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.states.get(sid)?.messages).toHaveLength(0);
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.states.get(sid)?.messages[0]?.content).toBe(OPERATOR_DELIVERY_FALLBACK);
  });

  it("message_end and session reset cancel a pending timer", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_200_000;
    vi.setSystemTime(startedAt);
    const first = setup();
    const sid = "session-end-clear";
    first.dispatch(start(sid, 1, startedAt), update(sid, 2, startedAt));
    expect(vi.getTimerCount()).toBe(1);
    first.dispatch(event(sid, 3, "message_end", startedAt + 1, {
      message: { role: "assistant", audience: "operator", content: "raw source" },
      nonce: "nonce-1",
    }));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(OPERATOR_BUFFER_TIMEOUT_MS));
    expect(first.result.current.states.get(sid)?.messages.map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);

    first.dispatch(start(sid, 4, startedAt + OPERATOR_BUFFER_TIMEOUT_MS + 1), update(sid, 5, startedAt + OPERATOR_BUFFER_TIMEOUT_MS + 1));
    expect(vi.getTimerCount()).toBe(1);
    first.dispatch({ type: "session_state_reset", sessionId: sid } as ServerToBrowserMessage);
    expect(vi.getTimerCount()).toBe(0);
    expect(first.result.current.states.get(sid)?.messages.map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);
  });

  it("arms from an incomplete replay and cancels when replay includes message_end", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_300_000;
    vi.setSystemTime(startedAt);
    const incomplete = setup();
    const sid = "session-replay-open";
    incomplete.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [
        { seq: 1, event: (start(sid, 1, startedAt) as any).event },
        { seq: 2, event: (update(sid, 2, startedAt) as any).event },
      ],
      isLast: true,
    } as ServerToBrowserMessage);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(OPERATOR_BUFFER_TIMEOUT_MS));
    expect(incomplete.result.current.states.get(sid)?.messages[0]?.content).toBe(OPERATOR_DELIVERY_FALLBACK);
    incomplete.unmount();

    const complete = setup();
    const completeSid = "session-replay-complete";
    complete.dispatch({
      type: "event_replay",
      sessionId: completeSid,
      events: [
        { seq: 1, event: (start(completeSid, 1, startedAt) as any).event },
        { seq: 2, event: (update(completeSid, 2, startedAt) as any).event },
        { seq: 3, event: (event(completeSid, 3, "message_end", startedAt + 1, {
          message: {
            role: "assistant",
            audience: "agent",
            content: "raw source",
            operatorDelivery: {
              version: 1,
              sourceSha256: sha256Hex("raw source"),
              status: "agent",
            },
          },
          nonce: "nonce-1",
        }) as any).event },
      ],
      isLast: true,
    } as ServerToBrowserMessage);
    expect(vi.getTimerCount()).toBe(0);
    expect(complete.result.current.states.get(completeSid)?.messages[0]?.content).toBe("raw source");
  });

  it("clears all pending timers on unmount", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_400_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    hook.dispatch(start("one", 1, startedAt), update("one", 2, startedAt));
    hook.dispatch(start("two", 1, startedAt), update("two", 2, startedAt));
    expect(vi.getTimerCount()).toBe(2);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves an open hold to the exact fallback when the session is removed", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_500_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "removed-with-open-delivery";
    const raw = "CommsReset dl-11743 §2A";
    hook.dispatch(start(sid, 1, startedAt), update(sid, 2, startedAt, raw));
    expect(vi.getTimerCount()).toBe(1);

    hook.dispatch({ type: "session_removed", sessionId: sid } as ServerToBrowserMessage);

    expect(vi.getTimerCount()).toBe(0);
    expect(hook.result.current.states.get(sid)?.messages.map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);
    expect(JSON.stringify(hook.result.current.states.get(sid))).not.toContain(raw);
  });

  it("carries one fallback across a full replay reset that omits the held message", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_600_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "replay-reset-omits-open-message";
    const raw = "CommsReset dl-11743 §2A";
    hook.dispatch(start(sid, 1, startedAt), update(sid, 2, startedAt, raw));

    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [{
        seq: 1,
        event: {
          eventType: "model_select",
          timestamp: startedAt + 1,
          data: { model: { provider: "test", id: "test" } },
        },
      }],
      isLast: true,
    } as ServerToBrowserMessage);

    expect(hook.result.current.states.get(sid)?.messages.map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);
    expect(JSON.stringify(hook.result.current.states.get(sid))).not.toContain(raw);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a live hold fallback after replaying only an older completed assistant", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_700_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "replay-prior-final-does-not-terminalize-live";
    const raw = "CommsReset dl-11743 §2A live partial";
    hook.dispatch(
      start(sid, 10, startedAt, undefined, "nonce-live"),
      update(sid, 11, startedAt + 1, raw, undefined, "nonce-live"),
    );

    const priorSource = "Prior internal update.";
    const priorPlain = "The earlier update was completed.";
    const priorMessage = {
      role: "assistant",
      audience: "operator",
      content: priorSource,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(priorSource),
        status: "ready",
        text: priorPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    };
    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [
        {
          seq: 1,
          event: {
            eventType: "message_update",
            timestamp: startedAt - 100,
            data: { message: priorMessage, entryId: "entry-prior" },
          },
        },
        {
          seq: 2,
          event: {
            eventType: "message_end",
            timestamp: startedAt - 99,
            data: { message: priorMessage, entryId: "entry-prior" },
          },
        },
      ],
      isLast: true,
    } as ServerToBrowserMessage);

    const rows = hook.result.current.states.get(sid)?.messages
      .filter((message) => message.role === "assistant") ?? [];
    expect(rows.map((message) => message.content)).toEqual([
      priorPlain,
      OPERATOR_DELIVERY_FALLBACK,
    ]);
    expect(rows.at(-1)?.content).toBe(OPERATOR_DELIVERY_FALLBACK);
    expect(JSON.stringify(hook.result.current.states.get(sid))).not.toContain(raw);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the carried live fallback last across paginated replay batches", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_800_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "replay-paginated-live-hold";
    hook.dispatch(
      start(sid, 10, startedAt, undefined, "nonce-live"),
      update(sid, 11, startedAt + 1, "raw live partial", undefined, "nonce-live"),
    );
    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [{
        seq: 1,
        event: { eventType: "model_select", timestamp: startedAt - 200, data: {} },
      }],
      isLast: false,
    } as ServerToBrowserMessage);

    const priorSource = "Earlier source.";
    const priorPlain = "The earlier update is complete.";
    const priorMessage = {
      role: "assistant",
      audience: "operator",
      content: priorSource,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(priorSource),
        status: "ready",
        text: priorPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    };
    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [
        {
          seq: 2,
          event: {
            eventType: "message_update",
            timestamp: startedAt - 100,
            data: { message: priorMessage, entryId: "entry-prior" },
          },
        },
        {
          seq: 3,
          event: {
            eventType: "message_end",
            timestamp: startedAt - 99,
            data: { message: priorMessage, entryId: "entry-prior" },
          },
        },
      ],
      isLast: true,
    } as ServerToBrowserMessage);

    expect(hook.result.current.states.get(sid)?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)).toEqual([
      priorPlain,
      OPERATOR_DELIVERY_FALLBACK,
    ]);
  });

  it("uses a receipt-time watchdog when replay splits update and end across pages", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_850_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "replay-split-assistant-pages";
    hook.dispatch(
      start(sid, 10, startedAt, undefined, "nonce-live"),
      update(sid, 11, startedAt + 1, "raw live partial", undefined, "nonce-live"),
    );

    const priorSource = "Earlier internal source.";
    const priorPlain = "The earlier update is complete.";
    const priorMessage = {
      role: "assistant",
      audience: "operator",
      content: priorSource,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(priorSource),
        status: "ready",
        text: priorPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    };
    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [{
        seq: 1,
        event: {
          eventType: "message_update",
          timestamp: startedAt - 100_000,
          data: { message: priorMessage, entryId: "entry-prior" },
        },
      }],
      isLast: false,
    } as ServerToBrowserMessage);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(OPERATOR_BUFFER_TIMEOUT_MS - 1));
    expect(hook.result.current.states.get(sid)?.messages
      .filter((message) => message.content === OPERATOR_DELIVERY_FALLBACK)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.states.get(sid)?.messages
      .filter((message) => message.content === OPERATOR_DELIVERY_FALLBACK)).toHaveLength(2);

    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [{
        seq: 2,
        event: {
          eventType: "message_end",
          timestamp: startedAt - 99_999,
          data: { message: priorMessage, entryId: "entry-prior" },
        },
      }],
      isLast: true,
    } as ServerToBrowserMessage);
    expect(hook.result.current.states.get(sid)?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)).toEqual([
      priorPlain,
      OPERATOR_DELIVERY_FALLBACK,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses entry_persisted aliasing so a matching replay final replaces the live hold", () => {
    vi.useFakeTimers();
    const startedAt = 1_800_000_900_000;
    vi.setSystemTime(startedAt);
    const hook = setup();
    const sid = "replay-entry-alias";
    const source = "Internal source awaiting finalization.";
    const plain = "The update is ready.";
    hook.dispatch(
      start(sid, 10, startedAt, undefined, "nonce-live"),
      update(sid, 11, startedAt + 1, source, undefined, "nonce-live"),
      event(sid, 12, "entry_persisted", startedAt + 2, {
        nonce: "nonce-live",
        entryId: "entry-live",
      }),
    );

    const finalMessage = {
      role: "assistant",
      audience: "operator",
      content: source,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(source),
        status: "ready",
        text: plain,
        checks: { plain: true, anchorsPreserved: true },
      },
    };
    hook.dispatch({
      type: "event_replay",
      sessionId: sid,
      events: [
        {
          seq: 1,
          event: {
            eventType: "message_update",
            timestamp: startedAt + 3,
            data: { message: finalMessage, entryId: "entry-live" },
          },
        },
        {
          seq: 2,
          event: {
            eventType: "message_end",
            timestamp: startedAt + 4,
            data: { message: finalMessage, entryId: "entry-live" },
          },
        },
      ],
      isLast: true,
    } as ServerToBrowserMessage);

    expect(hook.result.current.states.get(sid)?.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)).toEqual([plain]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
