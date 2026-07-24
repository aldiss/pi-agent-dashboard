import { describe, expect, it } from "vitest";
import {
  collectPersistedDashboardAssets,
  replayEntriesAsEvents,
} from "../state-replay.js";

describe("persisted dashboard assets", () => {
  it("collects valid sidecars and strips their bytes from replay event frames", () => {
    const entries = [{
      id: "entry-1",
      type: "message",
      timestamp: new Date(1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "source" }],
        audience: "agent",
        operatorDelivery: {
          version: 1,
          sourceSha256: "a".repeat(64),
          status: "agent",
        },
        operatorDeliveryPresentation: {
          version: 1,
          deliverySha256: "b".repeat(64),
          text: "![chart](pi-asset:0123456789abcdef)",
        },
        dashboardAssets: [
          { hash: "0123456789abcdef", mimeType: "image/png", data: "AAAA" },
          { hash: "not-valid", mimeType: "text/plain", data: "BBBB" },
        ],
      },
    }];

    expect(collectPersistedDashboardAssets(entries)).toEqual({
      "0123456789abcdef": { mimeType: "image/png", data: "AAAA" },
    });
    const replay = replayEntriesAsEvents("session-1", entries);
    const messages = replay
      .map((frame) => frame.event.data.message as Record<string, unknown> | undefined)
      .filter((message): message is Record<string, unknown> => message !== undefined);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => !("dashboardAssets" in message))).toBe(true);
    expect(messages.every((message) =>
      (message.operatorDeliveryPresentation as any)?.text ===
        "![chart](pi-asset:0123456789abcdef)",
    )).toBe(true);
  });
});
