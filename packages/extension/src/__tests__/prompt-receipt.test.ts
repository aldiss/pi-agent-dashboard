import { describe, it, expect } from "vitest";
import { deriveReceipt, fallbackReceipt, answerFieldIsPresent, BUS_TIMEOUT_SOURCE } from "../prompt-receipt.js";

describe("deriveReceipt", () => {
  it("answered: non-cancelled adapter response with a present answer → answered/delivered/rendered", () => {
    const r = deriveReceipt({ answer: "Ship it", cancelled: false, source: "dashboard" });
    expect(r).toEqual({
      delivered: true,
      rendered: true,
      answered: true,
      dismissed: false,
      timedOut: false,
      invalid: false,
      source: "dashboard",
    });
  });

  it("answered: TUI source with a present answer is also a real answer", () => {
    const r = deriveReceipt({ answer: "A", source: "tui" });
    expect(r.answered).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.source).toBe("tui");
  });

  it("answered (A2): empty-string answer is PRESENT → a real answer (multiselect empty set)", () => {
    const r = deriveReceipt({ answer: "", cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.dismissed).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("answered (A2): confirm=No arrives as answer:'false' — PRESENT → a real answer", () => {
    const r = deriveReceipt({ answer: "false", cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(true);
    expect(r.invalid).toBe(false);
  });

  // ── A2 able-to-fail: the pre-amendment `answered = !cancelled` marked a
  //    non-cancelled response with NO answer as answered (→ User responded:
  //    undefined). Now that is `invalid`, never `answered`. ──
  it("[A2 able-to-fail] non-cancelled response with answer:undefined → invalid, NOT answered", () => {
    const r = deriveReceipt({ answer: undefined, cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(false); // RED pre-amendment (was true)
    expect(r.invalid).toBe(true);
    expect(r.dismissed).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("[A2 able-to-fail] non-cancelled response with answer:null → invalid, NOT answered", () => {
    const r = deriveReceipt({ answer: null, cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("[A2 able-to-fail] non-cancelled response with the answer field ABSENT → invalid", () => {
    const r = deriveReceipt({ cancelled: false, source: "dashboard" });
    expect(r.answered).toBe(false);
    expect(r.invalid).toBe(true);
  });

  it("dismissed: cancelled by an adapter (source ≠ __bus__) → dismissed/delivered/rendered, not timedOut", () => {
    const r = deriveReceipt({ cancelled: true, source: "dashboard" });
    expect(r).toEqual({
      delivered: true,
      rendered: true,
      answered: false,
      dismissed: true,
      timedOut: false,
      invalid: false,
      source: "dashboard",
    });
  });

  it("timedOut (never rendered): cancelled by the bus, no render ACK → NOT delivered/rendered", () => {
    const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE });
    expect(r).toEqual({
      delivered: false,
      rendered: false,
      answered: false,
      dismissed: false,
      timedOut: true,
      invalid: false,
      source: BUS_TIMEOUT_SOURCE,
    });
  });

  // ── A1 able-to-fail: pre-amendment `delivered = source !== "__bus__"` made a
  //    RENDERED-then-timed-out prompt untruthfully delivered:false. With the
  //    render ACK threaded in, a rendered timeout is delivered:true/rendered:true. ──
  it("[A1 able-to-fail] rendered-ACK then timeout → delivered:true, rendered:true, timedOut:true", () => {
    const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE, rendered: true });
    expect(r.rendered).toBe(true); // RED pre-amendment (no rendered field / false)
    expect(r.delivered).toBe(true); // RED pre-amendment (was false via __bus__ heuristic)
    expect(r.timedOut).toBe(true);
    expect(r.answered).toBe(false);
  });

  it("[A1] never-rendered (no ACK) then timeout → delivered:false, rendered:false", () => {
    const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE, rendered: false });
    expect(r.rendered).toBe(false);
    expect(r.delivered).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("A1 delivered/rendered distinguish rendered-timeout from never-rendered timeout", () => {
    const renderedTimeout = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE, rendered: true });
    const neverRendered = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE });
    expect(renderedTimeout.delivered).toBe(true);
    expect(neverRendered.delivered).toBe(false);
    expect(renderedTimeout.timedOut).toBe(true);
    expect(neverRendered.timedOut).toBe(true);
  });

  it("the four states are mutually exclusive across every response kind", () => {
    for (const resp of [
      { answer: "x", cancelled: false, source: "dashboard" },       // answered
      { answer: undefined, cancelled: false, source: "dashboard" }, // invalid
      { cancelled: true, source: "dashboard" },                     // dismissed
      { cancelled: true, source: BUS_TIMEOUT_SOURCE },              // timedOut
    ]) {
      const r = deriveReceipt(resp);
      const trueCount = [r.answered, r.dismissed, r.timedOut, r.invalid].filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});

describe("answerFieldIsPresent (A2)", () => {
  it("present: any string (incl. empty and 'false') counts as an answer", () => {
    expect(answerFieldIsPresent({ answer: "hello", source: "x" })).toBe(true);
    expect(answerFieldIsPresent({ answer: "", source: "x" })).toBe(true);
    expect(answerFieldIsPresent({ answer: "false", source: "x" })).toBe(true);
  });
  it("absent: undefined / null / missing is NOT a present answer", () => {
    expect(answerFieldIsPresent({ answer: undefined, source: "x" })).toBe(false);
    expect(answerFieldIsPresent({ answer: null, source: "x" })).toBe(false);
    expect(answerFieldIsPresent({ source: "x" })).toBe(false);
  });
});

describe("fallbackReceipt", () => {
  it("confirm with no stash is treated as answered (no undefined path)", () => {
    const r = fallbackReceipt("confirm", false);
    expect(r.answered).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("unknown");
  });

  it("select/input/multiselect with a result → answered=true, source=unknown (degraded)", () => {
    const r = fallbackReceipt("select", true);
    expect(r.answered).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.source).toBe("unknown");
  });

  it("select/input/multiselect with no result → answered=false, invalid=true (non-decision)", () => {
    const r = fallbackReceipt("input", false);
    expect(r.answered).toBe(false);
    expect(r.delivered).toBe(false);
    expect(r.rendered).toBe(false);
    expect(r.dismissed).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.invalid).toBe(true);
    expect(r.source).toBe("unknown");
  });
});
