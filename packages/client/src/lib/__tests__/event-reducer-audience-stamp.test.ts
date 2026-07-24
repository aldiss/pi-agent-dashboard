/**
 * event-reducer-audience-stamp.test.ts — the WHOLE-PIPELINE consumer corpus
 * (Sol fix-cycle-3 F1/F2): wire envelope → reducer → classifier, BOTH roles,
 * BOTH directions, with NO vendored producer copy.
 *
 * Sol fix-cycle-2/3 F2 killed the vendored-copy shortcut: the prior corpus called
 * a dashboard-VENDORED copy of the extension producer and hand-constructed the
 * stamp, so it never exercised the real consumer seam. The producer is the
 * EXTENSION's authority (proven by its own registered-hook corpus,
 * `test/index-stamp.test.ts`); the DASHBOARD's job is to faithfully CONSUME the
 * stamp the extension writes onto the wire envelope. This corpus drives the REAL
 * `reduceEvent` → `classifyMessage` on the exact envelope shapes the server
 * broadcasts — including the SUMMARIZED over-cap shape and the corrupt-`null`
 * shape — for: operator / agent / unknown / worker-agent / corrupt-null /
 * pre-stamp, for BOTH user and assistant rows.
 *
 * The server-side preservation (over-cap summary keeps `audience`; null carried
 * verbatim) is proven at ITS seam in
 * `packages/server/src/__tests__/memory-event-store.test.ts`. Here we prove the
 * consumer reads those exact shapes correctly.
 */
import { describe, it, expect } from "vitest";
import { createInitialState, reduceEvent, type ChatMessage } from "../event-reducer.js";
import { classifyMessage } from "../message-filter-classifier.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { sha256Hex } from "../operator-delivery.js";

/** Drive a live assistant turn (message_update sets streamingText; message_end commits). */
function assistantTurn(text: string, audience?: unknown): ChatMessage {
  let state = createInitialState();
  state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
  state = reduceEvent(state, {
    eventType: "message_update",
    timestamp: 2,
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  } as DashboardEvent);
  const message: Record<string, unknown> = { role: "assistant", content: [{ type: "text", text }] };
  if (arguments.length > 1) message.audience = audience; // include even when null
  if (audience === "agent") {
    message.operatorDelivery = { version: 1, sourceSha256: sha256Hex(text), status: "agent" };
  }
  state = reduceEvent(state, { eventType: "message_end", timestamp: 3, data: { message } } as DashboardEvent);
  return state.messages[state.messages.length - 1]!;
}

/** Drive a live USER turn: message_start creates the row; the stamped user message_end back-fills. */
function userTurn(text: string, audience?: unknown, nonce = "n-1"): ChatMessage {
  let state = createInitialState();
  state = reduceEvent(state, {
    eventType: "message_start",
    timestamp: 1,
    data: { message: { role: "user", content: text }, nonce },
  } as DashboardEvent);
  const message: Record<string, unknown> = { role: "user", content: text };
  if (arguments.length > 1) message.audience = audience;
  state = reduceEvent(state, {
    eventType: "message_end",
    timestamp: 2,
    data: { message, nonce },
  } as DashboardEvent);
  return state.messages.find((m) => m.role === "user")!;
}

describe("F1 consumer corpus — ASSISTANT rows: stamp → reducer → classifier (both directions)", () => {
  it("operator stamp → retained → tierB (shown)", () => {
    const row = assistantTurn("here is the status", "operator");
    expect(row.audience).toBe("operator");
    expect(classifyMessage(row)).toBe("tierB");
  });

  it("agent stamp → retained → meshChatter (hide-eligible)", () => {
    const row = assistantTurn("landing dl-8567 in the ledger", "agent");
    expect(row.audience).toBe("agent");
    expect(classifyMessage(row)).toBe("meshChatter");
  });

  it("unknown stamp (ratified 3rd state) → retained → tierB (shown), even in a worker ctx", () => {
    const row = assistantTurn("headless, no name", "unknown");
    expect(row.audience).toBe("unknown");
    // Shown regardless of evidence — the classifier VISIBILITY axis shows unknown.
    expect(classifyMessage(row, { evidence: { sessionFile: "/x/run-1/session.jsonl" } })).toBe("tierB");
  });

  it("agent stamp WINS over an operator-pane retrospective (source of truth)", () => {
    const row = assistantTurn("mesh note", "agent");
    expect(classifyMessage(row, { evidence: { source: "tui" } })).toBe("meshChatter");
  });
});

describe("F2 consumer corpus — corrupt-null + pre-stamp at the real reducer/classifier seam", () => {
  it("corrupt-present null → reducer preserves as unknown → tierB (fail-OPEN), even in a worker ctx", () => {
    // Sol F2: the wire reader used to map null→absent→retrospective→hidden in a
    // worker ctx. The reducer now preserves a corrupt-present value as `unknown`
    // (shown), distinct from truly-absent.
    const row = assistantTurn("bad stamp", null);
    expect(row.audience).toBe("unknown"); // corrupt-present → shown sentinel
    expect(classifyMessage(row, { evidence: { sessionFile: "/x/run-1/session.jsonl" } })).toBe("tierB");
  });

  it("pre-stamp final → explicit unknown → tierB (SHOWN)", () => {
    const row = assistantTurn("old row"); // no audience arg → field absent
    expect(row.audience).toBe("unknown");
    expect(classifyMessage(row)).toBe("tierB");
  });

  it("pre-stamp final in a WORKER ctx remains explicit unknown and visible", () => {
    const row = assistantTurn("old worker row");
    expect(row.audience).toBe("unknown");
    expect(classifyMessage(row, { evidence: { sessionFile: "/x/run-1/session.jsonl" } })).toBe("tierB");
  });

  it("over-cap SUMMARIZED envelope shape (content preview + audience) still classifies by the stamp", () => {
    // The server's summarizeOverCap rebuilds data.message as {role, content:<preview>,
    // audience}. The reducer's message_end replay path reads that shape; the agent
    // stamp must still drive meshChatter.
    let state = createInitialState();
    state = reduceEvent(state, { eventType: "agent_start", timestamp: 1, data: {} } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_end",
      timestamp: 2,
      data: {
        __truncated: true,
        message: {
          role: "assistant",
          content: "hello world preview",
          audience: "agent",
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex("hello world preview"),
            status: "agent",
          },
        },
      },
    } as DashboardEvent);
    const row = state.messages[state.messages.length - 1]!;
    expect(row.audience).toBe("agent");
    expect(classifyMessage(row)).toBe("meshChatter");
  });
});

describe("finalized agent thinking visibility", () => {
  it("classifies source-bound agent thinking as agent-only chat", () => {
    const row: ChatMessage = {
      id: "thinking-agent",
      role: "thinking",
      content: "private reasoning",
      timestamp: 1,
      audience: "agent",
    };
    expect(classifyMessage(row)).toBe("meshChatter");
  });

  it("retains legacy unstamped thinking as narrative compatibility", () => {
    const row: ChatMessage = {
      id: "thinking-legacy",
      role: "thinking",
      content: "legacy reasoning",
      timestamp: 1,
    };
    expect(classifyMessage(row)).toBe("tierB");
  });
});

describe("F1 consumer corpus — USER rows are stamped now (the closed 'half the conversation' gap)", () => {
  it("a stamped user message_end back-fills the user row by nonce → operator → tierB", () => {
    const row = userTurn("ship it", "operator", "n-42");
    expect(row.audience).toBe("operator");
    expect(classifyMessage(row)).toBe("tierB");
  });

  it("a user row in a mesh session stamps agent → meshChatter (dispatch brief, hidden-eligible)", () => {
    const row = userTurn("dispatch brief dl-1", "agent", "n-7");
    expect(row.audience).toBe("agent");
    expect(classifyMessage(row)).toBe("meshChatter");
  });

  it("an UNSTAMPED user row (pre-stamp) stays undefined → retrospective (session evidence)", () => {
    const row = userTurn("legacy prompt"); // no audience arg
    expect(row.audience).toBeUndefined();
    expect(classifyMessage(row, { evidence: { sessionFile: "/x/run-1/session.jsonl" } })).toBe("meshChatter"); // worker evidence
    expect(classifyMessage(row, { evidence: { source: "tui" } })).toBe("tierB"); // operator pane
  });
});
