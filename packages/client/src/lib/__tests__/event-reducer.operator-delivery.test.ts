import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  createInitialState,
  OPERATOR_BUFFER_TIMEOUT_MS,
  reduceEvent,
  releaseAssistantBufferAsFallback,
  shouldBuffer,
  type SessionState,
} from "../event-reducer.js";
import { OPERATOR_DELIVERY_FALLBACK, sha256Hex } from "../operator-delivery.js";

const SOURCE = "Per dl-11743 §2A, Pete t30 BLOCK kept CODENAME-47 on hold. Correlation 550e8400-e29b-41d4-a716-446655440000; source 65ab66f0123456789abcdef. Decision: do not deploy until plain delivery passes review.";
const SOURCE_SHA256 = "7e123305de49c74d895b7df8c2836c42cd22537976533fbf8220d31f99ae4847";
const PLAIN = "The final review blocked this release because plain-language delivery was not reliable. The decision is to keep it undeployed until that delivery is verified.";

const delivery = {
  version: 1,
  sourceSha256: SOURCE_SHA256,
  status: "ready",
  text: PLAIN,
  checks: { plain: true, anchorsPreserved: true },
};

function event(eventType: string, timestamp: number, data: Record<string, unknown>): DashboardEvent {
  return { eventType, timestamp, data } as DashboardEvent;
}

function start(timestamp = 1, audience?: "operator" | "agent" | "unknown", nonce = "nonce-1"): DashboardEvent {
  return event("message_start", timestamp, {
    message: { role: "assistant", content: [], ...(audience ? { audience } : {}) },
    nonce,
  });
}

function update(text = SOURCE, timestamp = 2, audience?: "operator" | "agent" | "unknown", nonce = "nonce-1"): DashboardEvent {
  return event("message_update", timestamp, {
    message: { role: "assistant", content: [{ type: "text", text }], ...(audience ? { audience } : {}) },
    assistantMessageEvent: { type: "text_delta", delta: text },
    nonce,
  });
}

function end(options: {
  audience?: "operator" | "agent" | "unknown";
  operatorDelivery?: unknown;
  content?: unknown;
  timestamp?: number;
  nonce?: string;
  entryId?: string;
  operatorDeliveryPresentation?: unknown;
} = {}): DashboardEvent {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content ?? [{ type: "text", text: SOURCE }],
  };
  if (options.audience !== undefined) message.audience = options.audience;
  if ("operatorDelivery" in options) message.operatorDelivery = options.operatorDelivery;
  if ("operatorDeliveryPresentation" in options) {
    message.operatorDeliveryPresentation = options.operatorDeliveryPresentation;
  }
  return event("message_end", options.timestamp ?? 4, {
    message,
    entryId: options.entryId ?? "entry-1",
    nonce: options.nonce ?? "nonce-1",
  });
}

function assistantRows(state: SessionState) {
  return state.messages.filter((message) => message.role === "assistant");
}

describe("assistant partial buffering", () => {
  it("holds every partial because no production-authenticated pre-final audience proof exists", () => {
    expect(shouldBuffer("operator")).toBe(true);
    expect(shouldBuffer("unknown")).toBe(true);
    expect(shouldBuffer(undefined)).toBe(true);
    expect(shouldBuffer("agent")).toBe(true);

    for (const audience of ["operator", "agent", "unknown", undefined] as const) {
      let state: SessionState = { ...createInitialState(), audience };
      state = reduceEvent(state, start(1, audience));
      state = reduceEvent(state, update(SOURCE, 2, audience));
      expect(state.streamingText).toBe("");
      expect(state.heldOperatorText).toBe(SOURCE);
    }
  });

  it("does not expose a synthetic agent-stamped partial before an operator final", () => {
    let state: SessionState = reduceEvent(createInitialState(), start(1, "agent"));
    state = reduceEvent(state, update(SOURCE, 2, "agent"));
    expect(state.messages.some((message) => message.content.includes("dl-11743"))).toBe(false);
    expect(state.streamingText).toBe("");
    state = reduceEvent(state, end({ audience: "operator", operatorDelivery: delivery }));
    expect(assistantRows(state).map((message) => message.content)).toEqual([PLAIN]);
  });

  it("suppresses thinking deltas without current-message agent proof", () => {
    let state: SessionState = { ...createInitialState(), audience: "agent" as const };
    state = reduceEvent(state, start());
    state = reduceEvent(state, event("message_update", 2, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_start" },
    }));
    state = reduceEvent(state, event("message_update", 3, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "dl-11743 §2A CODENAME-47" },
    }));
    state = reduceEvent(state, event("message_update", 4, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_end" },
    }));
    expect(state.streamingThinking).toBe("");
    expect(state.messages.some((message) => message.role === "thinking")).toBe(false);
  });
});

describe("message_end operator delivery selection", () => {
  it.each(["operator", "unknown", undefined] as const)("commits only the verified plain delivery for %s", (audience) => {
    let state: SessionState = { ...createInitialState(), audience };
    state = reduceEvent(state, start());
    state = reduceEvent(state, update());
    state = reduceEvent(state, end({ audience, operatorDelivery: delivery }));

    expect(assistantRows(state)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: PLAIN,
        entryId: "entry-1",
        nonce: "nonce-1",
        audience: audience ?? "unknown",
      }),
    ]);
    expect(state.heldOperatorText).toBe("");
    expect(state.streamingText).toBe("");
  });

  it("commits the exact honest fallback when delivery is absent, failed, malformed, mismatched, or unsafe", () => {
    const badDeliveries = [
      undefined,
      { version: 1, sourceSha256: SOURCE_SHA256, status: "failed", code: "provider-timeout" },
      { version: 1, sourceSha256: SOURCE_SHA256, status: "ready", text: PLAIN },
      { ...delivery, sourceSha256: "0".repeat(64) },
      { ...delivery, text: "The result still references dl-11743." },
    ];
    for (const bad of badDeliveries) {
      let state: SessionState = { ...createInitialState(), audience: "operator" as const };
      state = reduceEvent(state, start());
      state = reduceEvent(state, update());
      state = reduceEvent(state, end({ audience: "operator", operatorDelivery: bad }));
      expect(assistantRows(state).map((message) => message.content)).toEqual([OPERATOR_DELIVERY_FALLBACK]);
    }
  });

  it("releases exact finalized prose only for a source-bound agent envelope", () => {
    let state: SessionState = { ...createInitialState(), audience: "agent" as const };
    state = reduceEvent(state, start());
    state = reduceEvent(state, update("partial source"));
    state = reduceEvent(state, end({
      audience: "agent",
      operatorDelivery: { version: 1, sourceSha256: SOURCE_SHA256, status: "agent" },
    }));
    expect(assistantRows(state).map((message) => message.content)).toEqual([SOURCE]);

    const unbound = reduceEvent(createInitialState(), end({ audience: "agent" }));
    expect(assistantRows(unbound)).toEqual([
      expect.objectContaining({ content: OPERATOR_DELIVERY_FALLBACK, audience: "unknown" }),
    ]);
  });

  it("uses the same selection on cold replay without a preceding update", () => {
    const state = reduceEvent(createInitialState(), end({ audience: "operator", operatorDelivery: delivery }));
    expect(assistantRows(state).map((message) => message.content)).toEqual([PLAIN]);
  });

  it("uses a valid image-only presentation without changing source or certified delivery bytes", () => {
    const source = "Inspect ![chart](./chart.png) before deciding whether to release.";
    const certified = "The chart supports keeping the release undeployed. ![chart](./chart.png)";
    const presented = "The chart supports keeping the release undeployed. ![chart](pi-asset:abc12345def67890)";
    const state = reduceEvent(createInitialState(), end({
      audience: "operator",
      content: source,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(source),
        status: "ready",
        text: certified,
        checks: { plain: true, anchorsPreserved: true },
      },
      operatorDeliveryPresentation: {
        version: 1,
        deliverySha256: sha256Hex(certified),
        text: presented,
      },
    }));
    expect(assistantRows(state).map((message) => message.content)).toEqual([presented]);
  });

  it("does not render a source partial before an operator-stamped end, even with a session agent prediction", () => {
    let state: SessionState = { ...createInitialState(), audience: "agent" as const };
    state = reduceEvent(state, start());
    state = reduceEvent(state, update());
    state = reduceEvent(state, event("tool_execution_start", 3, { toolCallId: "tool-1", toolName: "read", args: {} }));
    expect(state.streamingText).toBe("");
    expect(assistantRows(state)).toHaveLength(0);
    expect(state.heldOperatorText).toBe(SOURCE);

    state = reduceEvent(state, end({
      audience: "operator",
      operatorDelivery: delivery,
      content: [
        { type: "text", text: SOURCE },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "app.test.ts" } },
      ],
    }));

    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(state.messages[0].content).toBe(PLAIN);
  });

  it("replaces a pre-existing flushed row and preserves its id, metadata, and tool order", () => {
    let state: SessionState = {
      ...createInitialState(),
      streamingTextFlushed: true,
      messages: [
        { id: "flush-tool-1", role: "assistant", content: "legacy raw prefix", timestamp: 2 },
        { id: "tool-tool-1", role: "toolResult", content: "read", timestamp: 3, toolCallId: "tool-1", toolName: "read", toolStatus: "running" },
      ],
    };
    state = reduceEvent(state, end({
      audience: "operator",
      operatorDelivery: delivery,
      content: [
        { type: "text", text: SOURCE },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "app.test.ts" } },
      ],
    }));

    expect(state.messages.map((message) => message.id)).toEqual(["flush-tool-1", "tool-tool-1"]);
    expect(state.messages[0]).toEqual(expect.objectContaining({
      role: "assistant",
      content: PLAIN,
      entryId: "entry-1",
      nonce: "nonce-1",
      audience: "operator",
    }));
    expect(state.messages[1]).toEqual(expect.objectContaining({ role: "toolResult", toolCallId: "tool-1" }));
  });

  it("places selected plain prose before its tool card when the stream was held", () => {
    let state = createInitialState();
    state = reduceEvent(state, start());
    state = reduceEvent(state, update());
    state = reduceEvent(state, event("tool_execution_start", 3, {
      toolCallId: "tool-2",
      toolName: "read",
      args: {},
    }));
    state = reduceEvent(state, end({
      audience: "unknown",
      operatorDelivery: delivery,
      content: [
        { type: "text", text: SOURCE },
        { type: "toolCall", id: "tool-2", name: "read", arguments: {} },
      ],
    }));
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(state.messages[0].content).toBe(PLAIN);
    expect(state.messages[1]).toEqual(expect.objectContaining({ id: "tool-tool-2", toolCallId: "tool-2" }));
  });

  it("timeout commits the exact fallback, never raw text, redaction, ellipsis, or an indefinite hold", () => {
    let state = createInitialState();
    state = reduceEvent(state, start(1000));
    state = reduceEvent(state, update(SOURCE, 1001));
    state = releaseAssistantBufferAsFallback(state, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);
    expect(assistantRows(state).map((message) => message.content)).toEqual([OPERATOR_DELIVERY_FALLBACK]);
    expect(state.heldOperatorText).toBe("");
    expect(state.heldBufferLastActivityAt).toBeUndefined();
  });

  it("replaces a timeout fallback when message_end arrives late instead of appending a second row", () => {
    let state = createInitialState();
    state = reduceEvent(state, start(1000));
    state = reduceEvent(state, update(SOURCE, 1001));
    state = releaseAssistantBufferAsFallback(state, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);
    const fallbackId = assistantRows(state)[0].id;

    state = reduceEvent(state, end({
      timestamp: 1001 + OPERATOR_BUFFER_TIMEOUT_MS + 1,
      audience: "operator",
      operatorDelivery: delivery,
    }));

    expect(assistantRows(state)).toHaveLength(1);
    expect(assistantRows(state)[0]).toEqual(expect.objectContaining({
      id: fallbackId,
      content: PLAIN,
      entryId: "entry-1",
      nonce: "nonce-1",
    }));
    expect(state.messages.some((message) => message.content === SOURCE)).toBe(false);
  });

  it("ignores resumed partials after timeout and cannot append repeated fallback rows", () => {
    let state = createInitialState();
    state = reduceEvent(state, start(1000));
    state = reduceEvent(state, update(SOURCE, 1001));
    state = releaseAssistantBufferAsFallback(state, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);
    state = reduceEvent(state, update(`${SOURCE} resumed`, 1002 + OPERATOR_BUFFER_TIMEOUT_MS));
    state = releaseAssistantBufferAsFallback(state, 1002 + (2 * OPERATOR_BUFFER_TIMEOUT_MS));
    expect(assistantRows(state).map((message) => message.content)).toEqual([OPERATOR_DELIVERY_FALLBACK]);
    expect(state.heldBufferLastActivityAt).toBeUndefined();
  });

  it("does not let a later turn replace a prior timeout whose message_end was dropped", () => {
    let state = createInitialState();
    state = reduceEvent(state, start(1000));
    state = reduceEvent(state, update(SOURCE, 1001));
    state = releaseAssistantBufferAsFallback(state, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);
    const firstId = assistantRows(state)[0].id;

    const nextSource = "Decision: keep the release undeployed until delivery is verified.";
    const nextPlain = "Keep the release undeployed until plain delivery is verified.";
    state = reduceEvent(state, start(40_000, undefined, "nonce-2"));
    state = reduceEvent(state, update(nextSource, 40_001, undefined, "nonce-2"));
    state = reduceEvent(state, end({
      timestamp: 40_002,
      audience: "operator",
      content: nextSource,
      nonce: "nonce-2",
      entryId: "entry-2",
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(nextSource),
        status: "ready",
        text: nextPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    }));

    expect(assistantRows(state).map((message) => [message.id, message.content])).toEqual([
      [firstId, OPERATOR_DELIVERY_FALLBACK],
      [expect.any(String), nextPlain],
    ]);
  });

  it("keeps an unknown-key timeout as history while allowing a fresh keyed turn", () => {
    let state = reduceEvent(createInitialState(), start(1000, undefined, ""));
    state = reduceEvent(state, update(SOURCE, 1001, undefined, ""));
    state = releaseAssistantBufferAsFallback(state, 1001 + OPERATOR_BUFFER_TIMEOUT_MS);

    const nextSource = "Keep the release undeployed until delivery is verified.";
    const nextPlain = "Keep the release undeployed until the update is verified.";
    state = reduceEvent(state, start(40_000, undefined, "nonce-new"));
    state = reduceEvent(state, update(nextSource, 40_001, undefined, "nonce-new"));
    state = reduceEvent(state, end({
      timestamp: 40_002,
      nonce: "nonce-new",
      entryId: "entry-new",
      audience: "operator",
      content: nextSource,
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(nextSource),
        status: "ready",
        text: nextPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    }));

    expect(assistantRows(state).map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
      nextPlain,
    ]);
  });

  it("surfaces a fallback when a new message starts before the dropped end times out", () => {
    let state = reduceEvent(createInitialState(), start(1000));
    state = reduceEvent(state, update(SOURCE, 1001));

    state = reduceEvent(state, start(2000));

    expect(assistantRows(state).map((message) => message.content)).toEqual([
      OPERATOR_DELIVERY_FALLBACK,
    ]);
    expect(assistantRows(state)[0].audience).toBe("unknown");
    expect(state.heldOperatorText).toBe("");
    expect(state.heldBufferLastActivityAt).toBeUndefined();
  });

  it("replaces a boundary fallback when its late final arrives after the next assistant", () => {
    let state = reduceEvent(createInitialState(), start(1000, undefined, "nonce-1"));
    state = reduceEvent(state, update(SOURCE, 1001, undefined, "nonce-1"));

    const nextSource = "Decision: keep the release undeployed until delivery is verified.";
    const nextPlain = "Keep the release undeployed until plain delivery is verified.";
    state = reduceEvent(state, start(2000, undefined, "nonce-2"));
    expect(state.timedOutAssistantFallbackKey).toBe("nonce:nonce-1");
    state = reduceEvent(state, update(nextSource, 2001, undefined, "nonce-2"));
    state = reduceEvent(state, end({
      timestamp: 2002,
      audience: "operator",
      content: nextSource,
      nonce: "nonce-2",
      entryId: "entry-2",
      operatorDelivery: {
        version: 1,
        sourceSha256: sha256Hex(nextSource),
        status: "ready",
        text: nextPlain,
        checks: { plain: true, anchorsPreserved: true },
      },
    }));

    state = reduceEvent(state, end({
      timestamp: 2003,
      audience: "operator",
      operatorDelivery: delivery,
      nonce: "nonce-1",
      entryId: "entry-1",
    }));

    expect(assistantRows(state).map((message) => message.content)).toEqual([
      PLAIN,
      nextPlain,
    ]);
  });
});
