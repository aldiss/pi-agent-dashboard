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
  /** Fire the real handleRetryQueued (as tapping "retry" would). */
  retry: (queueNonce: string) => void;
  /** Toggle the browser↔server WS connected state (gap (i) WS-drop). */
  setConnected: (v: boolean) => void;
  /** Apply the send_prompt_failed client path (markQueueEntryFailed) — gap (ii). */
  failByNonce: (queueNonce: string) => void;
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
  let api: Pick<Harness, "sendText" | "inject" | "getQueue" | "retry" | "setConnected" | "failByNonce"> | null = null;

  function App() {
    const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(() => {
      const s = createInitialState();
      s.isStreaming = true;
      s.status = "streaming";
      return new Map([[SID, s]]);
    });
    // Controllable browser↔server WS state (gap (i)).
    const [connected, setConnected] = useState(true);

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
      connected,
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
      retry: (queueNonce: string) => actions.handleRetryQueued(queueNonce),
      setConnected: (v: boolean) => setConnected(v),
      // Gap (ii): the useMessageHandler `send_prompt_failed` case calls exactly
      // markQueueEntryFailed(nonce). Drive that same path.
      failByNonce: (queueNonce: string) =>
        setSessionStates((prev) => {
          const current = prev.get(SID);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(SID, markQueueEntryFailed(current, queueNonce));
          return next;
        }),
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
    retry: (n) => act(() => api!.retry(n)),
    setConnected: (v) => act(() => api!.setConnected(v)),
    failByNonce: (n) => act(() => api!.failByNonce(n)),
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
    // to rot. Advance past the long-grace backstop to prove it never fails.
    act(() => {
      vi.advanceTimersByTime(95_000);
    });
    const queue = h.getQueue();
    expect(queue.find((q) => q.state === "failed")).toBeUndefined(); // pre-fix: FAILED
    expect(queue).toHaveLength(0); // dispatched into the committed bubble
  });

  // ── AMEND #5 (f) delivery-aware-fail: three gaps, none silent ──

  it("(2b-iii) CONNECTED-SLOW does NOT false-fail before the long grace; confirms within window", () => {
    const h = renderHarness();
    h.sendText("connected but slow");
    const nonce = h.getQueue()[0].queueNonce;
    // Past the OLD bare-30s proxy, well before the ~90s long grace — must stay
    // optimistic (connected + sent=true; no failure signal).
    act(() => { vi.advanceTimersByTime(45_000); });
    expect(h.getQueue()[0].state).toBe("optimistic"); // pre-fix: false-"failed" at 30s
    // The slow confirmation arrives within the window → confirmed, never failed.
    h.inject(enqueuedEvent(nonce, "connected but slow"));
    expect(h.getQueue()[0].state).toBe("confirmed");
  });

  it("(2b-iii) LONG-GRACE genuine bridge→pi loss: connected + sent=true + no message_enqueued within ~90s → failed", () => {
    const h = renderHarness();
    h.sendText("reached bridge WS but pi lost it");
    expect(h.getQueue()[0].state).toBe("optimistic");
    // Connected throughout; no message_enqueued ever (pi crashed/session ended
    // after ws.send). The long-grace backstop MUST fire — genuine loss surfaced,
    // not silently vanished.
    act(() => { vi.advanceTimersByTime(91_000); });
    expect(h.getQueue()[0].state).toBe("failed");
  });

  it("(2b-i) WS-DROP fast-fails an in-flight optimistic (didn't reach the server)", () => {
    const h = renderHarness();
    h.sendText("never reached the server");
    expect(h.getQueue()[0].state).toBe("optimistic");
    // browser↔server WS drops while the send is in-flight → fast-fail (no need
    // to wait the long grace; the send provably didn't reach the server).
    h.setConnected(false);
    expect(h.getQueue()[0].state).toBe("failed");
  });

  it("(2b-ii) send_prompt_failed (bridge absent) fast-fails the matching card", () => {
    const h = renderHarness();
    h.sendText("bridge is not connected");
    const nonce = h.getQueue()[0].queueNonce;
    expect(h.getQueue()[0].state).toBe("optimistic");
    // The server emits send_prompt_failed on sent===false; the client reducer
    // path is markQueueEntryFailed(nonce) (useMessageHandler `send_prompt_failed`
    // case). It fast-fails immediately — no waiting out the long grace.
    h.failByNonce(nonce);
    expect(h.getQueue()[0].state).toBe("failed");
  });

  it("(f) RETRY round-trip: false-failed → retry → late OLD confirm is inert (no flip-flop, no duplicate)", () => {
    const h = renderHarness();
    h.sendText("retry round trip");
    const oldNonce = h.getQueue()[0].queueNonce;
    // Force a (genuine-loss) long-grace failure.
    act(() => { vi.advanceTimersByTime(91_000); });
    expect(h.getQueue()[0].state).toBe("failed");
    // User taps retry → re-key OLD→NEW, OLD recorded superseded, re-send.
    h.retry(oldNonce);
    const newNonce = h.getQueue()[0].queueNonce;
    expect(newNonce).not.toBe(oldNonce);
    expect(h.getQueue()[0].state).toBe("optimistic");
    // The OLD send confirms LATE (connected-slow) — must be INERT.
    h.inject(enqueuedEvent(oldNonce, "retry round trip"));
    expect(h.getQueue()).toHaveLength(1); // no duplicate
    expect(h.getQueue()[0].queueNonce).toBe(newNonce); // no flip-flop back to OLD
    // The NEW confirms normally.
    h.inject(enqueuedEvent(newNonce, "retry round trip"));
    expect(h.getQueue()).toHaveLength(1);
    expect(h.getQueue()[0].state).toBe("confirmed");
  });

  it("AMEND #3 SAME-TEXT: two INTENTIONAL same-text sends → two cards, FIFO send-order, neither false-fails", () => {
    const h = renderHarness();
    // First intentional send.
    h.sendText("same text twice");
    // Second intentional send, spaced PAST the 600ms double-submit window so it
    // is NOT collapsed (the guard only stops accidental double-FIRES).
    act(() => {
      vi.advanceTimersByTime(700);
    });
    h.sendText("same text twice");

    // Two distinct optimistic cards (intentional re-send is allowed).
    let queue = h.getQueue();
    expect(queue).toHaveLength(2);
    const [n1, n2] = [queue[0].queueNonce, queue[1].queueNonce];
    expect(n1).not.toBe(n2);

    // Exactly TWO real send_prompts reached the wire (not 1, not 4).
    const sends = h.send.mock.calls.filter((c) => c[0]?.type === "send_prompt");
    expect(sends).toHaveLength(2);

    // Each confirms by its EXACT nonce (the normal round-trip) — send-order
    // (FIFO) is preserved, nonces NOT swapped.
    h.inject(enqueuedEvent(n1, "same text twice"));
    h.inject(enqueuedEvent(n2, "same text twice"));
    queue = h.getQueue();
    expect(queue.map((q) => q.queueNonce)).toEqual([n1, n2]);
    expect(queue.every((q) => q.state === "confirmed")).toBe(true);

    // pi pulls them into work FIFO; advance past the stuck-timeout to prove
    // NEITHER false-fails along the way.
    h.inject(userCommitEvent("same text twice", n1));
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(h.getQueue().map((q) => q.queueNonce)).toEqual([n2]);
    expect(h.getQueue()[0].state).toBe("confirmed");
    h.inject(userCommitEvent("same text twice", n2));
    expect(h.getQueue()).toHaveLength(0);
  });
});
