import { describe, expect, it, vi } from "vitest";
import {
  createAppendBoundMessageEndForwarder,
  isAppendMessageRole,
  MAX_PENDING_MESSAGE_ENDS,
  MESSAGE_END_CORRELATION_FIELD,
} from "../message-end-forwarder.js";

interface Message {
  role: "assistant";
  content: string;
  id?: string;
  operatorDelivery?: unknown;
}

async function runOrder(order: "bridge-first" | "producer-first") {
  const original: Message = { role: "assistant", content: "source prose" };
  let current = original;
  const sent: any[] = [];
  const persisted: any[] = [];
  const ordering: string[] = [];
  const forwarder = createAppendBoundMessageEndForwarder({
    prepare: (_payload, appendedMessage) => {
      (appendedMessage as Message).content += " [inlined]";
    },
    resolveFallbackEntryId: (message) => (message as Message).id,
    send: (payload, message, entryId, nonce) => {
      ordering.push("message_end");
      sent.push({
        payload: structuredClone(payload),
        message: structuredClone(message),
        entryId,
        nonce,
      });
    },
  });
  const bridge = async () => {
    const event = { type: "message_end", message: current };
    forwarder.hold(current, event, "nonce-1");
  };
  const producer = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = {
      ...current,
      operatorDelivery: {
        version: 1,
        sourceSha256: "a".repeat(64),
        status: "ready",
        text: "Plain facts. The decision is to keep the release undeployed.",
        checks: { plain: true, anchorsPreserved: true },
      },
    };
  };
  for (const handler of order === "bridge-first" ? [bridge, producer] : [producer, bridge]) {
    await handler();
  }

  // Core copies the final replacement back into the stable original ref.
  Object.assign(original, current);
  const prepared = forwarder.beforeAppend(original);
  expect(prepared).toEqual({ nonce: "nonce-1" });
  persisted.push(structuredClone(original));
  original.id = "entry-1";
  ordering.push("entry_persisted");
  forwarder.afterAppend(original, original.id);

  return { sent, persisted, ordering };
}

describe("append-bound message_end forwarding", () => {
  it("binds only appendMessage-persisted roles, so custom messages can forward without delay", () => {
    expect(isAppendMessageRole({ role: "assistant" })).toBe(true);
    expect(isAppendMessageRole({ role: "user" })).toBe(true);
    expect(isAppendMessageRole({ role: "toolResult" })).toBe(true);
    expect(isAppendMessageRole({ role: "custom" })).toBe(false);

    const sent: object[] = [];
    const custom = { role: "custom", content: "status" };
    if (!isAppendMessageRole(custom)) sent.push(custom);
    expect(sent).toEqual([custom]);
  });

  it.each(["bridge-first", "producer-first"] as const)("forwards final delivery with %s handler order", async (order) => {
    const { sent, persisted, ordering } = await runOrder(order);
    expect(persisted[0].operatorDelivery.status).toBe("ready");
    expect(persisted[0].content).toBe("source prose [inlined]");
    expect(sent).toHaveLength(1);
    // The held payload may still point at a producer replacement clone; the
    // forwarder must send the same append-time object it prepared/persisted.
    expect(sent[0].message.operatorDelivery.status).toBe("ready");
    expect(sent[0].message.content).toBe("source prose [inlined]");
    expect(sent[0].entryId).toBe("entry-1");
    expect(ordering).toEqual(["entry_persisted", "message_end"]);
    expect(persisted[0]).not.toHaveProperty(MESSAGE_END_CORRELATION_FIELD);
    expect(sent[0].payload.message).not.toHaveProperty(MESSAGE_END_CORRELATION_FIELD);
  });

  it("cannot flush before append even when a later handler exceeds the old timeout", () => {
    vi.useFakeTimers();
    const message: Message = { role: "assistant", content: "source" };
    const sent: Array<{ message: object; entryId?: string }> = [];
    const forwarder = createAppendBoundMessageEndForwarder({
      prepare: () => {},
      resolveFallbackEntryId: () => undefined,
      send: (_payload, authoritativeMessage, entryId) => {
        sent.push({ message: authoritativeMessage, entryId });
      },
    });
    forwarder.hold(message, { message }, "nonce-1");
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(0);

    message.operatorDelivery = { status: "ready" };
    forwarder.beforeAppend(message);
    message.id = "entry-slow";
    forwarder.afterAppend(message, message.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ message, entryId: "entry-slow" });
    vi.useRealTimers();
  });

  it("clears abandoned pending records and markers on a session reset", () => {
    const message: Message = { role: "assistant", content: "source" };
    const send = vi.fn();
    const forwarder = createAppendBoundMessageEndForwarder({
      prepare: () => {},
      resolveFallbackEntryId: () => undefined,
      send,
    });
    forwarder.hold(message, { message }, "nonce-1");
    expect(forwarder.has(message)).toBe(true);

    forwarder.clear();

    expect(forwarder.has(message)).toBe(false);
    expect(message).not.toHaveProperty(MESSAGE_END_CORRELATION_FIELD);
    expect(forwarder.beforeAppend(message)).toBeUndefined();
    expect(forwarder.afterAppend(message)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds abandoned records within a session", () => {
    const send = vi.fn();
    const forwarder = createAppendBoundMessageEndForwarder({
      prepare: () => {},
      resolveFallbackEntryId: () => undefined,
      send,
    });
    const messages = Array.from({ length: MAX_PENDING_MESSAGE_ENDS + 1 }, (_, index): Message => ({
      role: "assistant",
      content: `source-${index}`,
    }));
    messages.forEach((message, index) => {
      forwarder.hold(message, { message }, `nonce-${index}`);
    });

    expect(forwarder.has(messages[0])).toBe(false);
    expect(messages[0]).not.toHaveProperty(MESSAGE_END_CORRELATION_FIELD);
    expect(forwarder.has(messages[1])).toBe(true);
    expect(forwarder.has(messages.at(-1)!)).toBe(true);

    const latest = messages.at(-1)!;
    expect(forwarder.beforeAppend(latest)).toEqual({ nonce: `nonce-${MAX_PENDING_MESSAGE_ENDS}` });
    expect(forwarder.afterAppend(latest, "entry-latest")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
