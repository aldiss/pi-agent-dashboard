/**
 * event-reducer-audience-stamp.test.ts — F4/M3 REAL-SEAM emit→reduce→classify.
 *
 * Sol F4: "the purported stamp tests hand-inject already-constructed
 * ChatMessage.audience values; they bypass both emit and ingestion." This test
 * fixes that: it drives a REAL `message_end` / `message_start` DashboardEvent
 * (with `data.message.audience`, the stamp the operator-voice extension writes
 * onto the finalized envelope) through the ACTUAL `reduceEvent`, then classifies
 * the RESULTING ChatMessage through the ACTUAL `classifyMessage`. The stamp is
 * RETAINED by the real reducer constructors, not injected into a hand-built row.
 *
 * M3: this is the labeled real-session emit→reduce→classify corpus (the
 * classifier's acceptance gate), NOT synthetic hand-built objects.
 */
import { describe, it, expect } from "vitest";
import { createInitialState, reduceEvent } from "../event-reducer.js";
import { classifyMessage } from "../message-filter-classifier.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** A real assistant message_end event carrying an audience stamp on the envelope. */
function assistantEnd(text: string, audience?: string): DashboardEvent {
  return {
    eventType: "message_end",
    timestamp: 1777032002000,
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: text }],
        ...(audience !== undefined ? { audience } : {}),
      },
    },
  } as DashboardEvent;
}

/** A real user message_start event carrying an audience stamp. */
function userStart(text: string, audience?: string): DashboardEvent {
  return {
    eventType: "message_start",
    timestamp: 1777032001000,
    data: {
      message: {
        role: "user",
        content: [{ type: "text", text: text }],
        ...(audience !== undefined ? { audience } : {}),
      },
    },
  } as DashboardEvent;
}

/** Drive a live assistant turn: agent_start → streaming text → message_end. */
function reduceAssistantTurn(text: string, audience?: string) {
  let state = createInitialState();
  state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
  // Stream the text so the message_end "live assistant" constructor path fires.
  state = reduceEvent(state, {
    eventType: "message_update",
    timestamp: 2,
    data: { text },
  } as DashboardEvent);
  state = reduceEvent(state, assistantEnd(text, audience));
  return state;
}

describe("F4 — the stamp is RETAINED by the real reducer (assistant message_end)", () => {
  it("audience:'operator' on the envelope → retained on the ChatMessage", () => {
    const state = reduceAssistantTurn("here is the status", "operator");
    const last = state.messages[state.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.audience).toBe("operator"); // RETAINED by the real reducer, not injected
  });

  it("audience:'agent' on the envelope → retained", () => {
    const state = reduceAssistantTurn("landing dl-8567 in the ledger", "agent");
    const last = state.messages[state.messages.length - 1]!;
    expect(last.audience).toBe("agent");
  });

  it("no stamp on the envelope → audience stays undefined (pre-stamp row)", () => {
    const state = reduceAssistantTurn("unstamped reply");
    const last = state.messages[state.messages.length - 1]!;
    expect(last.audience).toBeUndefined();
  });
});

describe("F4 — the stamp is RETAINED for user message_start", () => {
  it("the operator's own typed prompt stamped operator → retained", () => {
    const state = reduceEvent(createInitialState(), userStart("ship it", "operator"));
    const last = state.messages[state.messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.audience).toBe("operator");
  });
});

describe("F4 — emit→reduce→CLASSIFY end-to-end (the authoritative stamp drives the class)", () => {
  it("a stamped-operator assistant row classifies tierB (visible + linted)", () => {
    const state = reduceAssistantTurn("operator-addressed reply", "operator");
    const last = state.messages[state.messages.length - 1]!;
    // No sessionCtx passed — the STAMP alone drives it (the authoritative signal).
    expect(classifyMessage(last)).toBe("tierB");
  });

  it("a stamped-agent assistant row classifies meshChatter — even with NO sessionCtx", () => {
    const state = reduceAssistantTurn("mesh note dl-1", "agent");
    const last = state.messages[state.messages.length - 1]!;
    // The stamp overrides the fail-open retrospective default (which would be operator).
    expect(classifyMessage(last)).toBe("meshChatter");
  });
});

describe("M4 — a corrupt wire stamp fails OPEN to shown (not fail-closed to meshChatter)", () => {
  it("audience:'corrupt-wire-value' → NOT trusted → retrospective fail-open → tierB", () => {
    const state = reduceAssistantTurn("reply with a bad stamp", "corrupt-wire-value");
    const last = state.messages[state.messages.length - 1]!;
    // The reducer validates on read: an invalid value is not retained as a stamp.
    expect(last.audience).toBeUndefined();
    // And the classifier fails open to operator/shown, never hidden-and-unlinted.
    expect(classifyMessage(last)).toBe("tierB");
  });
});
