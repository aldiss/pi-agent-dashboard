import { describe, it, expect } from "vitest";
import { deriveReceipt, fallbackReceipt, BUS_TIMEOUT_SOURCE } from "../prompt-receipt.js";

describe("deriveReceipt", () => {
  it("answered: non-cancelled adapter response → answered/delivered, not dismissed/timedOut", () => {
    const r = deriveReceipt({ answer: "Ship it", cancelled: false, source: "dashboard" });
    expect(r).toEqual({
      delivered: true,
      answered: true,
      dismissed: false,
      timedOut: false,
      source: "dashboard",
    });
  });

  it("answered: TUI source is also a real answer", () => {
    const r = deriveReceipt({ answer: "A", source: "tui" });
    expect(r.answered).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.source).toBe("tui");
  });

  it("answered: empty-string answer from an adapter is still an answer (multiselect empty set)", () => {
    // cancelled:false is the sole answered discriminator — an empty payload
    // (e.g. multiselect with nothing checked) is a real decision, not a dismiss.
    const r = deriveReceipt({ answer: "", cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(true);
    expect(r.dismissed).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("dismissed: cancelled by an adapter (source ≠ __bus__) → dismissed/delivered, not timedOut", () => {
    const r = deriveReceipt({ cancelled: true, source: "dashboard" });
    expect(r).toEqual({
      delivered: true,
      answered: false,
      dismissed: true,
      timedOut: false,
      source: "dashboard",
    });
  });

  it("timedOut: cancelled by the bus (source = __bus__) → timedOut, NOT delivered, NOT dismissed", () => {
    const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE });
    expect(r).toEqual({
      delivered: false,
      answered: false,
      dismissed: false,
      timedOut: true,
      source: BUS_TIMEOUT_SOURCE,
    });
  });

  it("delivered distinguishes never-rendered (bus timeout) from operator dismiss", () => {
    const dismissed = deriveReceipt({ cancelled: true, source: "tui" });
    const timedOut = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE });
    expect(dismissed.delivered).toBe(true);
    expect(timedOut.delivered).toBe(false);
    // Both are no-answer, but the reason is now explicit + distinct.
    expect(dismissed.answered).toBe(false);
    expect(timedOut.answered).toBe(false);
    expect(dismissed.dismissed).toBe(true);
    expect(timedOut.timedOut).toBe(true);
  });

  it("the three no-answer/answer states are mutually exclusive across sources", () => {
    for (const resp of [
      { answer: "x", cancelled: false, source: "dashboard" },
      { cancelled: true, source: "dashboard" },
      { cancelled: true, source: BUS_TIMEOUT_SOURCE },
    ]) {
      const r = deriveReceipt(resp);
      const trueCount = [r.answered, r.dismissed, r.timedOut].filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});

describe("fallbackReceipt", () => {
  it("confirm with no stash is treated as answered (no undefined path)", () => {
    const r = fallbackReceipt("confirm", false);
    expect(r.answered).toBe(true);
    expect(r.source).toBe("unknown");
  });

  it("select/input/multiselect with a result → answered=true, source=unknown (degraded)", () => {
    const r = fallbackReceipt("select", true);
    expect(r.answered).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.source).toBe("unknown");
  });

  it("select/input/multiselect with no result → answered=false (best-effort no-decision)", () => {
    const r = fallbackReceipt("input", false);
    expect(r.answered).toBe(false);
    expect(r.delivered).toBe(false);
    expect(r.dismissed).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.source).toBe("unknown");
  });
});
