import { describe, it, expect, beforeEach } from "vitest";
import {
  claimPromptRenderedAck,
  hasPromptRenderedAck,
  __resetPromptRenderedAckLedger,
} from "../prompt-rendered-ack.js";

// Pete dl-13358 B1: the render ACK must fire EXACTLY ONCE per promptId across
// remount / reconnect-replay / StrictMode double-invoke. The module-level
// ledger is the idempotency guard; this proves claim-once semantics.

describe("prompt-rendered-ack ledger (B1 idempotency)", () => {
  beforeEach(() => __resetPromptRenderedAckLedger());

  it("claims true on the FIRST call for a promptId", () => {
    expect(claimPromptRenderedAck("p1")).toBe(true);
  });

  it("[able-to-fail] a SECOND claim for the same promptId is false (no duplicate ACK)", () => {
    expect(claimPromptRenderedAck("p1")).toBe(true);
    expect(claimPromptRenderedAck("p1")).toBe(false); // remount / reconnect / StrictMode
    expect(claimPromptRenderedAck("p1")).toBe(false);
  });

  it("distinct promptIds each claim once (independent)", () => {
    expect(claimPromptRenderedAck("a")).toBe(true);
    expect(claimPromptRenderedAck("b")).toBe(true);
    expect(claimPromptRenderedAck("a")).toBe(false);
    expect(claimPromptRenderedAck("b")).toBe(false);
  });

  it("empty promptId never claims (guard)", () => {
    expect(claimPromptRenderedAck("")).toBe(false);
  });

  it("hasPromptRenderedAck reflects the ledger", () => {
    expect(hasPromptRenderedAck("x")).toBe(false);
    claimPromptRenderedAck("x");
    expect(hasPromptRenderedAck("x")).toBe(true);
  });
});
