/**
 * event-reducer-audience-stamp.test.ts — F4 REAL-SEAM corpus: producer → envelope
 * → reducer → classifier, in BOTH directions, with NO injected stamps.
 *
 * Sol fix-cycle-2 F4: prior tests INJECTED the desired audience string and the
 * "live" helper sent `data:{text}` (wrong-shaped; the reducer's message_update
 * expects `data.message`). This corpus fixes both:
 *
 *   1. The stamp is DERIVED by the EXTENSION's REAL producer (`deriveAudienceFromEnv`,
 *      a pure SDK-free function imported cross-worktree) from a real env
 *      (`PI_AGENT_NAME` presence) — NOT hand-injected.
 *   2. The derived stamp is placed on a correctly-shaped `message_end` envelope
 *      (`data.message`), reduced through the ACTUAL `reduceEvent` (correct
 *      message_update shape), and classified through the ACTUAL `classifyMessage`.
 *
 * So one corpus traverses producer → envelope → reducer → classifier for:
 * operator, standing-crew, ordinary-driver, worker, corrupt, pre-stamp — BOTH
 * directions (operator-facing shown+linted; agent-facing exempt).
 */
import { describe, it, expect } from "vitest";
import { createInitialState, reduceEvent } from "../event-reducer.js";
import { classifyMessage } from "../message-filter-classifier.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
// The operator-voice audience-origin PRODUCER (pure, SDK-free), VENDORED in-tree
// from the extension (SYNC SOURCE in audience-origin.vendored.ts; parity-tested).
// The stamp is DERIVED by this real producer logic, NOT injected.
import { deriveAudienceFromEnv } from "@blackbelt-technology/pi-dashboard-shared/audience-origin.vendored.js";

/**
 * Simulate the FULL emit path: the extension's real producer derives the stamp
 * from the env, then the finalized envelope carries it (as the registered hook
 * returns). `hasUI` mirrors the operator's interactive pane vs a headless spawn.
 */
function emitAssistantEnvelope(text: string, env: Record<string, string | undefined>, hasUI = true) {
  const audience = deriveAudienceFromEnv(env, hasUI); // REAL producer, not injected
  return {
    eventType: "message_end" as const,
    timestamp: 1777032002000,
    data: {
      message: { role: "assistant", content: [{ type: "text", text }], audience },
    },
  } as DashboardEvent;
}

/** Drive a live assistant turn with the CORRECT message_update shape (data.message). */
function reduceTurn(envelope: DashboardEvent, text: string) {
  let state = createInitialState();
  state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
  // message_update carries `data.message` (NOT `data.text`) — the shape the
  // reducer actually reads to set streamingText (Sol M3 fix).
  state = reduceEvent(state, {
    eventType: "message_update",
    timestamp: 2,
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  } as DashboardEvent);
  state = reduceEvent(state, envelope);
  return state;
}

/** Full producer→envelope→reducer→classifier for an assistant turn under `env`. */
function classifyEmitted(text: string, env: Record<string, string | undefined>, hasUI = true) {
  const envelope = emitAssistantEnvelope(text, env, hasUI);
  const state = reduceTurn(envelope, text);
  const last = state.messages[state.messages.length - 1]!;
  return { last, category: classifyMessage(last) };
}

describe("F4 real corpus — producer→envelope→reducer→classifier (BOTH directions)", () => {
  it("OPERATOR pane (no name, interactive) → derived operator → retained → tierB (shown+linted)", () => {
    const { last, category } = classifyEmitted("here is the status", {}, /* hasUI */ true);
    expect(last.audience).toBe("operator"); // DERIVED by the real producer, retained by the real reducer
    expect(category).toBe("tierB");
  });

  it("STANDING-CREW (PI_AGENT_NAME=Joan) → derived operator → tierB", () => {
    const { last, category } = classifyEmitted("the gate is green 4/4", { PI_AGENT_NAME: "Joan" });
    expect(last.audience).toBe("operator");
    expect(category).toBe("tierB");
  });

  it("WORKER (PI_AGENT_NAME=subagent-worker-*) → derived AGENT → retained → meshChatter (exempt)", () => {
    // THE highest-frequency negative fixture at the real producer seam.
    const { last, category } = classifyEmitted("landing dl-8567 in the ledger", {
      PI_AGENT_NAME: "subagent-worker-3f4a1b",
    });
    expect(last.audience).toBe("agent");
    expect(category).toBe("meshChatter");
  });

  it("ORDINARY DRIVER (PI_AGENT_NAME=Commwright) → derived AGENT → meshChatter", () => {
    const { last, category } = classifyEmitted("dispatch reply dl-1", { PI_AGENT_NAME: "Commwright" });
    expect(last.audience).toBe("agent");
    expect(category).toBe("meshChatter");
  });

  it("bare-named dispatched spawn → derived AGENT → meshChatter (Auditor hard case)", () => {
    const { last, category } = classifyEmitted("x", { PI_AGENT_NAME: "someRandomSpawn" });
    expect(last.audience).toBe("agent");
    expect(category).toBe("meshChatter");
  });
});

describe("F4 corpus — pre-stamp + corrupt (M1) at the real reducer/classifier seam", () => {
  it("PRE-STAMP (no audience field on the envelope) → retrospective fail-open → tierB", () => {
    // An old row with no stamp: the reducer retains undefined; the classifier's
    // retrospective (no sessionCtx) fails open to operator → shown.
    let state = createInitialState();
    state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_update",
      timestamp: 2,
      data: { message: { role: "assistant", content: [{ type: "text", text: "old row" }] } },
    } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_end",
      timestamp: 3,
      data: { message: { role: "assistant", content: [{ type: "text", text: "old row" }] } },
    } as DashboardEvent);
    const last = state.messages[state.messages.length - 1]!;
    expect(last.audience).toBeUndefined();
    expect(classifyMessage(last)).toBe("tierB");
  });

  it("CORRUPT present stamp → M1 fail-OPEN to shown (tierB), even in a worker sessionCtx", () => {
    // A corrupt wire stamp must NOT be treated as absent-and-hidden in a worker
    // context. The reducer preserves the corrupt value; the classifier fails it open.
    let state = createInitialState();
    state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_update",
      timestamp: 2,
      data: { message: { role: "assistant", content: [{ type: "text", text: "bad stamp" }] } },
    } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_end",
      timestamp: 3,
      data: { message: { role: "assistant", content: [{ type: "text", text: "bad stamp" }], audience: "corrupt-wire-value" } },
    } as DashboardEvent);
    const last = state.messages[state.messages.length - 1]!;
    // Classify WITH a worker sessionCtx: a fail-CLOSED bug would hide it (meshChatter).
    expect(classifyMessage(last, { tier: "worker" })).toBe("tierB");
  });
});
