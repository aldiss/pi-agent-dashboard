/**
 * door-3 operator-voice pre-render hold — reducer state-machine tests.
 *
 * Proves the buffer/hold at the event-reducer seam (build-item-4): an operator
 * session buffers assistant partials (renders NOTHING live), releases BYTE-
 * IDENTICAL on clean/observe-hit, HOLDS on enforce-hit, self-corrects on the
 * authoritative end-stamp, and fails-safe on the Contract-D inactivity timeout.
 * agent/unknown render live unchanged (unknown = ratified shown+exempt).
 *
 * Pure reducer state (no DOM). The operator-VISIBLE hold is proven separately by
 * ChatView.operator-hold-render.test.tsx (render boundary) — see change:
 * operator-voice-buffer-hold.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduceEvent,
  shouldBuffer,
  isOperatorBufferTimedOut,
  releaseOperatorBufferAsNeutral,
  OPERATOR_BUFFER_TIMEOUT_MS,
  OPERATOR_BUFFER_TIMEOUT_PLACEHOLDER,
  type SessionState,
} from "../event-reducer.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { Audience } from "@blackbelt-technology/pi-dashboard-shared/vendor/operator-voice-audience/audience-core.js";

function stateWith(audience: Audience | undefined): SessionState {
  return { ...createInitialState(), audience };
}
function asstStart(t: number): DashboardEvent {
  return { eventType: "message_start", timestamp: t, data: { message: { role: "assistant", content: [] } } } as DashboardEvent;
}
function textDelta(t: number, text: string): DashboardEvent {
  return { eventType: "message_update", timestamp: t, data: { message: { role: "assistant", content: [{ type: "text", text }] } } } as DashboardEvent;
}
function messageEnd(t: number, opts: { text: string; audience?: string; voiceVerdict?: string }): DashboardEvent {
  const message: Record<string, unknown> = { role: "assistant", content: [{ type: "text", text: opts.text }] };
  if (opts.audience !== undefined) message.audience = opts.audience;
  if (opts.voiceVerdict !== undefined) message.voiceVerdict = opts.voiceVerdict;
  return { eventType: "message_end", timestamp: t, data: { message, entryId: "e1", nonce: "n1" } } as DashboardEvent;
}

describe("door-3 shouldBuffer seam (ratified FINAL: operator only)", () => {
  it("buffers operator only; agent + unknown + undefined render live", () => {
    expect(shouldBuffer("operator")).toBe(true);
    expect(shouldBuffer("agent")).toBe(false);
    expect(shouldBuffer("unknown")).toBe(false);
    expect(shouldBuffer(undefined)).toBe(false);
  });
});

describe("door-3 operator session — buffer partials (render nothing live)", () => {
  it("routes operator partials into heldOperatorText, NOT streamingText", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "Hello"));
    s = reduceEvent(s, textDelta(3, "Hello operator"));
    expect(s.streamingText).toBe("");             // nothing renders live
    expect(s.heldOperatorText).toBe("Hello operator");
    expect(s.heldBufferLastActivityAt).toBe(3);   // inactivity anchor re-armed per partial
  });
});

describe("door-3 message_end verdict reconciliation", () => {
  it("clean → RELEASE the buffered message", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "plain reply"));
    s = reduceEvent(s, messageEnd(3, { text: "plain reply", audience: "operator", voiceVerdict: "clean" }));
    const asst = s.messages.filter((m) => m.role === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0].content).toBe("plain reply");
    expect(s.heldOperatorText).toBe("");
    expect(s.streamingText).toBe("");
    expect(s.heldBufferLastActivityAt).toBeUndefined();
  });

  it("enforce-hit → HOLD (render nothing; buffer dropped)", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "jargony synergy leverage"));
    s = reduceEvent(s, messageEnd(3, { text: "jargony synergy leverage", audience: "operator", voiceVerdict: "enforce-hit" }));
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0); // nothing rendered
    expect(s.heldOperatorText).toBe("");
    expect(s.heldBufferLastActivityAt).toBeUndefined();
  });

  it("observe-hit → RELEASE (observe is log-only, does not hold)", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "observed reply"));
    s = reduceEvent(s, messageEnd(3, { text: "observed reply", audience: "operator", voiceVerdict: "observe-hit" }));
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["observed reply"]);
  });

  it("missing verdict at a real message_end → RELEASE (fail-open shown, not held)", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "reply with no verdict"));
    s = reduceEvent(s, messageEnd(3, { text: "reply with no verdict", audience: "operator" })); // no voiceVerdict
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["reply with no verdict"]);
  });
});

describe("door-3 end-stamp-authoritative self-correction", () => {
  it("start operator + end-stamp agent → self-correct forward AND release (never hold)", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, "was predicted operator"));
    // The authoritative end-stamp says agent (start over-predicted, e.g. missing-source→default-tui).
    s = reduceEvent(s, messageEnd(3, { text: "was predicted operator", audience: "agent", voiceVerdict: "enforce-hit" }));
    expect(s.audience).toBe("agent");                                   // self-corrected going forward
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["was predicted operator"]); // released despite enforce-hit (agent is exempt)
  });
});

describe("door-3 agent / unknown render live (unchanged)", () => {
  for (const audience of ["agent", "unknown"] as const) {
    it(`${audience} → streams live into streamingText, never held`, () => {
      let s = stateWith(audience);
      s = reduceEvent(s, asstStart(1));
      s = reduceEvent(s, textDelta(2, "live text"));
      expect(s.streamingText).toBe("live text");
      expect(s.heldOperatorText).toBe("");
      expect(s.heldBufferLastActivityAt).toBeUndefined();
      s = reduceEvent(s, messageEnd(3, { text: "live text", audience, voiceVerdict: "clean" }));
      expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["live text"]);
    });
  }
});

describe("door-3 Contract-D inactivity timeout → neutral (never hangs)", () => {
  it("not timed out before the bound; timed out at the bound", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1000));
    s = reduceEvent(s, textDelta(1001, "held, awaiting a verdict that never comes"));
    expect(isOperatorBufferTimedOut(s, 1001 + OPERATOR_BUFFER_TIMEOUT_MS - 1)).toBe(false);
    expect(isOperatorBufferTimedOut(s, 1001 + OPERATOR_BUFFER_TIMEOUT_MS)).toBe(true);
  });

  it("releaseOperatorBufferAsNeutral emits a neutral placeholder (NOT the held text) + clears buffer", () => {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1000));
    s = reduceEvent(s, textDelta(1001, "unverified jargon that must not leak"));
    const released = releaseOperatorBufferAsNeutral(s, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);
    const asst = released.messages.filter((m) => m.role === "assistant");
    expect(asst.map((m) => m.content)).toEqual([OPERATOR_BUFFER_TIMEOUT_PLACEHOLDER]); // neutral, not the held text
    expect(released.heldOperatorText).toBe("");
    expect(released.heldBufferLastActivityAt).toBeUndefined();
    expect(released.streamingText).toBe("");
  });

  it("release is a no-op when no buffer is open", () => {
    const s = stateWith("agent");
    expect(releaseOperatorBufferAsNeutral(s, 5)).toBe(s);
  });
});

describe("door-3 BYTE-IDENTICAL held→released (empirical render-safety proof)", () => {
  it("clean release commits content BYTE-IDENTICAL to what streamed (never reshaped/dropped)", () => {
    // Special chars, markdown, unicode, newline — any reshape would fail equality.
    const STREAMED = "Here's the **plan**: run `npm test`, verify \u2713, then\nship. \u2014 no jargon.";
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    // stream cumulative partials (as the wire does), ending with the full text
    s = reduceEvent(s, textDelta(2, "Here's the **plan**: "));
    s = reduceEvent(s, textDelta(3, STREAMED));
    expect(s.streamingText).toBe("");            // proven nothing rendered live
    expect(s.heldOperatorText).toBe(STREAMED);
    s = reduceEvent(s, messageEnd(4, { text: STREAMED, audience: "operator", voiceVerdict: "clean" }));
    const asst = s.messages.filter((m) => m.role === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0].content).toBe(STREAMED);      // BYTE-IDENTICAL — no reshape, no drop
    expect(asst[0].entryId).toBe("e1");          // stamped like a normal commit
    expect(asst[0].nonce).toBe("n1");
  });
});
