/**
 * Message-queue round-trip INTEGRATION test (dashboard-message-queue/v1 AMEND #2).
 *
 * Unit tests on the reducer in isolation missed two bugs the operator hit on the
 * LIVE dashboard. This test exercises the REAL send-while-streaming round-trip —
 * the real `useSessionActions.handleSend` + the real `reduceEvent` + the real
 * `useQueueStuckTimeout` + the real `ChatView` render — with only the WS `send`
 * stubbed and events injected the way the server would deliver them. It is the
 * coverage that was absent.
 *
 * Reproduces (must FAIL pre-fix) then pins (passes post-fix):
 *   1. DOUBLING — one user action that fires `handleSend` twice rapidly must
 *      yield exactly ONE queued card AND ONE `send_prompt` (not two).
 *   2. FALSE-FAILED — an optimistic entry whose `message_enqueued` confirmation
 *      never arrives (streaming-view mismatch: bridge committed it straight to
 *      work) must be reconciled by the committing `message_start` (text), NOT
 *      left to rot into the 30s stuck-timeout "failed" state.
 *   3. Genuine loss still fails visibly (timeout fires when nothing confirms).
 *
 * See change: dashboard-message-queue (AMEND #2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import React, { useState, useRef, useCallback, useMemo } from "react";
import { ChatView } from "../../components/ChatView.js";
import { useSessionActions } from "../../hooks/useSessionActions.js";
import { useQueueStuckTimeout } from "../../hooks/useQueueStuckTimeout.js";
import {
  createInitialState,
  reduceEvent,
  markQueueEntryFailed,
  type SessionState,
} from "../../lib/event-reducer.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const SID = "session-rt";

interface Harness {
  send: ReturnType<typeof vi.fn>;
  /** Fire the real handleSend (as the composer would). */
  sendText: (text: string) => void;
  /** Inject a DashboardEvent through the real reducer (as the server would). */
  inject: (event: DashboardEvent) => void;
  /** Current queue snapshot for assertions. */
  getQueue: () => SessionState["queue"];
  container: HTMLElement;
}

/**
 * Renders the real ChatView wired to the real handleSend + reducer +
 * stuck-timeout, mirroring App.tsx's wiring. Starts the session in a STREAMING
 * state so handleSend takes the queue path.
 */
function renderHarness(): Harness {
  const send = vi.fn();
  let api: Pick<Harness, "sendText" | "inject" | "getQueue"> | null = null;

  function App() {
    const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(() => {
      const s = createInitialState();
      s.isStreaming = true;
      s.status = "streaming";
      return new Map([[SID, s]]);
    });

    // Minimal deps for useSessionActions — only handleSend is exercised.
    const setSessions = useState(() => new Map())[1] as any;
    const setSpawningCwds = useState(() => new Set())[1] as any;
    const setTerminals = useState(() => new Map())[1] as any;
    const spawnTimeoutsRef = useRef(new Map());
    const pendingTerminalCwdRef = useRef<string | null>(null);
    const pendingSpawnsRef = useRef(new Map());

    const actions = useSessionActions({
      selectedId: SID,
      send,
      navigate: () => {},
      setMobileOpen: (() => {}) as any,
      setSessions,
      setSessionStates,
      setSpawningCwds,
      setTerminals,
      clearSpawningCwd: () => {},
      spawnTimeoutsRef,
      pendingTerminalCwdRef,
      terminals: new Map(),
      pendingSpawnsRef,
    });

    const selectedState = sessionStates.get(SID) ?? createInitialState();

    // Real stuck-timeout wiring (as App.tsx does it).
    const optimisticQueueEntries = useMemo(
      () =>
        selectedState.queue
          .filter((q) => q.state === "optimistic")
          .map((q) => ({ queueNonce: q.queueNonce, createdAt: q.createdAt })),
      [selectedState.queue],
    );
    useQueueStuckTimeout(
      optimisticQueueEntries,
      useCallback((queueNonce: string) => {
        setSessionStates((prev) => {
          const current = prev.get(SID);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(SID, markQueueEntryFailed(current, queueNonce));
          return next;
        });
      }, []),
    );

    api = {
      sendText: (text: string) => actions.handleSend(text),
      inject: (event: DashboardEvent) =>
        setSessionStates((prev) => {
          const current = prev.get(SID) ?? createInitialState();
          const next = new Map(prev);
          next.set(SID, reduceEvent(current, event));
          return next;
        }),
      getQueue: () => (sessionStates.get(SID) ?? createInitialState()).queue,
    };

    const toolContext = { cwd: undefined, editors: [] } as any;
    return <ChatView sessionId={SID} state={selectedState} toolContext={toolContext} />;
  }

  const { container } = render(<App />);
  return {
    send,
    sendText: (t) => act(() => api!.sendText(t)),
    inject: (e) => act(() => api!.inject(e)),
    getQueue: () => api!.getQueue(),
    container,
  };
}

/** Build the message_enqueued event the bridge forwards on a dashboard enqueue. */
function enqueuedEvent(queueNonce: string, text: string): DashboardEvent {
  return {
    eventType: "message_enqueued",
    timestamp: Date.now(),
    data: { queueNonce, text, source: "dashboard" },
  } as DashboardEvent;
}

/** Build the user message_start the bridge forwards when a message commits. */
function userCommitEvent(text: string, queueNonce?: string): DashboardEvent {
  return {
    eventType: "message_start",
    timestamp: Date.now(),
    data: {
      message: { role: "user", content: [{ type: "text", text }] },
      nonce: `n-${text}`,
      ...(queueNonce ? { queueNonce } : {}),
    },
  } as DashboardEvent;
}

describe("queue round-trip integration — AMEND #2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does not implement Element.scrollTo; ChatView's auto-scroll effect
    // calls it on queue/message change. Stub so the test exercises real queue
    // logic, not jsdom's gap.
    (Element.prototype as any).scrollTo = (Element.prototype as any).scrollTo ?? (() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("DOUBLING: firing handleSend twice rapidly yields exactly ONE card and ONE send", () => {
    const h = renderHarness();
    // One user action that double-fires the composer onSend (keydown+click /
    // Enter double-fire / mobile+parent both firing).
    h.sendText("run the tests");
    h.sendText("run the tests");

    const queue = h.getQueue();
    expect(queue).toHaveLength(1); // pre-fix: 2 (two nonces)
    expect(queue[0].text).toBe("run the tests");
    // And only ONE real send_prompt reached the wire (not two).
    const sends = h.send.mock.calls.filter((c) => c[0]?.type === "send_prompt");
    expect(sends).toHaveLength(1); // pre-fix: 2
  });

  it("CONFIRM: an optimistic entry flips to confirmed on matching message_enqueued (one card)", () => {
    const h = renderHarness();
    h.sendText("hello there");
    // Grab the client-minted nonce off the optimistic entry, echo it back.
    const nonce = h.getQueue()[0].queueNonce;
    h.inject(enqueuedEvent(nonce, "hello there"));
    const queue = h.getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].state).toBe("confirmed");
  });

  it("FALSE-FAILED: optimistic entry reconciled by the committing message_start (text), never failed", () => {
    const h = renderHarness();
    h.sendText("focus on the parser");
    expect(h.getQueue()).toHaveLength(1);
    expect(h.getQueue()[0].state).toBe("optimistic");

    // Streaming-view mismatch: the bridge committed it straight to work, so NO
    // message_enqueued ever arrives — but the committing user message_start does
    // (without a queueNonce, since the bridge didn't intercept it as queued).
    h.inject(userCommitEvent("focus on the parser"));

    // The optimistic card must be reconciled away by the text match — NOT left
    // to rot. Advance past the 30s stuck-timeout to prove it never fails.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    const queue = h.getQueue();
    expect(queue.find((q) => q.state === "failed")).toBeUndefined(); // pre-fix: FAILED
    expect(queue).toHaveLength(0); // dispatched into the committed bubble
  });

  it("GENUINE LOSS still fails visibly: nothing confirms → 30s stuck-timeout → failed", () => {
    const h = renderHarness();
    h.sendText("this one truly never reaches the bridge");
    expect(h.getQueue()[0].state).toBe("optimistic");
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(h.getQueue()[0].state).toBe("failed");
  });
});
