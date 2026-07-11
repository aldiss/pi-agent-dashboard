/**
 * C3 (bridge side) — huddle phase holder + fence/hold predicates.
 *
 * Proves the M-E / M-C bridge contract:
 *  - ARM engages the active phase (fence + hold ON); RECALL releases it.
 *  - shouldFenceTuiInput / shouldHoldPromptResponse track the active phase — the
 *    pure predicates the bridge's pi.on("input") + prompt_response guards call.
 *  - The M-E fence buffer captures fenced TUI turns for the span and drains on
 *    recall.
 *  - A stale recall (wrong epoch) is ignored (composes with the server SM's
 *    epoch guard).
 */
import { describe, it, expect } from "vitest";
import {
  createHuddleBridgeState,
  shouldFenceTuiInput,
  shouldHoldPromptResponse,
} from "../huddle-bridge-state.js";

describe("C3 bridge state — arm/recall phase", () => {
  it("starts idle, arms to active, recalls to idle", () => {
    const st = createHuddleBridgeState();
    expect(st.phase()).toBe("idle");
    expect(st.isActive()).toBe(false);

    expect(st.arm(1)).toBe(true);
    expect(st.phase()).toBe("active");
    expect(st.epoch()).toBe(1);

    const drained = st.recall(1);
    expect(drained).toEqual([]); // no buffered turns
    expect(st.phase()).toBe("idle");
  });

  it("ignores a stale recall (wrong epoch)", () => {
    const st = createHuddleBridgeState();
    st.arm(2);
    expect(st.recall(1)).toBeNull(); // stale — epoch mismatch
    expect(st.isActive()).toBe(true); // still active
    expect(st.recall(2)).toEqual([]); // correct epoch releases
    expect(st.isActive()).toBe(false);
  });
});

describe("C3 bridge state — M-E fence predicate + buffer", () => {
  it("shouldFenceTuiInput is true only while active", () => {
    const st = createHuddleBridgeState();
    expect(shouldFenceTuiInput(st)).toBe(false);
    st.arm(1);
    expect(shouldFenceTuiInput(st)).toBe(true);
    st.recall(1);
    expect(shouldFenceTuiInput(st)).toBe(false);
  });

  it("buffers fenced TUI turns for the span and drains them on recall", () => {
    const st = createHuddleBridgeState();
    st.arm(1);
    st.bufferTuiTurn({ text: "typed into the local TUI mid-huddle", at: 100 });
    st.bufferTuiTurn({ text: "and again", at: 200 });
    expect(st.tuiBuffer()).toHaveLength(2);
    const drained = st.recall(1);
    expect(drained?.map((t) => t.text)).toEqual([
      "typed into the local TUI mid-huddle",
      "and again",
    ]);
    // Buffer cleared after recall.
    expect(st.tuiBuffer()).toHaveLength(0);
  });
});

describe("C3 bridge state — M-C hold predicate", () => {
  it("shouldHoldPromptResponse is true only while active", () => {
    const st = createHuddleBridgeState();
    expect(shouldHoldPromptResponse(st)).toBe(false);
    st.arm(1);
    expect(shouldHoldPromptResponse(st)).toBe(true);
    st.recall(1);
    expect(shouldHoldPromptResponse(st)).toBe(false);
  });
});
