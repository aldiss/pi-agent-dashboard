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

  // ── B2 (Pete dl-13358) + responder-attribution split (Pete dl-13383): the
  //    ANSWERER's authenticated author threads into receipt.author (present-answer
  //    ONLY); the RENDERER's author threads into the SEPARATE receipt.renderedBy.
  //    A no-answer response (dismiss/timeout) carries NO `author`. ──
  describe("author (B2 operator identity) + renderedBy split (dl-13383)", () => {
    const OP = { sub: "op-1", display: "Operator One", isOperator: true };
    const OP2 = { sub: "op-2", display: "Operator Two", isOperator: true };

    it("[B2 able-to-fail] an answered response carries the operator author into receipt.author", () => {
      const r = deriveReceipt({ answer: "Ship it", cancelled: false, source: "dashboard", author: OP });
      expect(r.author).toEqual(OP); // RED pre-B2 (no author threaded)
      expect(r.answered).toBe(true);
    });

    it("[dl-13383 able-to-fail] a rendered-then-timed-out response carries WHO RENDERED it in renderedBy, and author is ABSENT (nobody answered)", () => {
      const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE, rendered: true, renderedBy: OP });
      expect(r.renderedBy).toEqual(OP);
      expect("author" in r).toBe(false); // RED pre-split (render identity leaked into author)
      expect(r.author).toBeUndefined();
      expect(r.delivered).toBe(true);
      expect(r.rendered).toBe(true);
      expect(r.timedOut).toBe(true);
      expect(r.answered).toBe(false);
    });

    it("[dl-13383 able-to-fail] operator RENDERED, TUI ANSWERED (no author) → author ABSENT, renderedBy=operator, answered=true", () => {
      // The responder (TUI) answered with NO author; the render ACK was the
      // operator. The answer-author must be the responder's (absent), NEVER the
      // render identity.
      const r = deriveReceipt({ answer: "A", cancelled: false, source: "tui", renderedBy: OP });
      expect("author" in r).toBe(false); // RED if answer-author fell back to renderedBy
      expect(r.author).toBeUndefined();
      expect(r.renderedBy).toEqual(OP);
      expect(r.answered).toBe(true);
      expect(r.source).toBe("tui");
    });

    it("[dl-13383] distinct answerer vs renderer: author=answerer, renderedBy=renderer (kept separate)", () => {
      const r = deriveReceipt({ answer: "A", cancelled: false, source: "dashboard", author: OP2, renderedBy: OP });
      expect(r.author).toEqual(OP2);
      expect(r.renderedBy).toEqual(OP);
    });

    it("[dl-13383] a dismiss with NO responder author carries renderedBy but no author (render-only)", () => {
      // Input carries renderedBy but NO responder author (a render-only dismiss
      // where no authenticated responder was stamped) → author absent because the
      // INPUT has none. Contrast dl-13527 below: an authenticated dismiss DOES
      // carry a responder author, which is now preserved.
      const r = deriveReceipt({ cancelled: true, source: "dashboard", renderedBy: OP });
      expect(r.dismissed).toBe(true);
      expect("author" in r).toBe(false);
      expect(r.renderedBy).toEqual(OP);
    });

    it("single-operator (no author) → receipt has NO author key (byte-unchanged)", () => {
      const r = deriveReceipt({ answer: "A", cancelled: false, source: "dashboard" });
      expect("author" in r).toBe(false);
      expect("renderedBy" in r).toBe(false);
    });

    it("a no-author receipt is not an operator decision (author undefined)", () => {
      const r = deriveReceipt({ answer: "A", cancelled: false, source: "dashboard" });
      expect(r.author).toBeUndefined();
    });

    // ── dl-13527: `author` = the RESPONDER actor (answerer OR authenticated
    //    DISMISSER). The browser gateway server-stamps `author` on an
    //    authenticated dashboard dismiss too; the r6 gate `answerPresent &&
    //    response.author` DROPPED that dismisser identity. Now preserved. ──
    describe("dismiss-actor preserve (dl-13527)", () => {
      it("[dl-13527 able-to-fail] authenticated dashboard DISMISS preserves the dismisser as receipt.author", () => {
        // cancelled:true (no answer) + a server-stamped operator author + renderedBy.
        const r = deriveReceipt({ cancelled: true, source: "dashboard", author: OP, renderedBy: OP });
        expect(r.dismissed).toBe(true);
        expect(r.author).toEqual(OP);     // RED pre-fix (answerPresent gate dropped it)
        expect(r.renderedBy).toEqual(OP);
        expect(r.answered).toBe(false);   // a dismiss is NOT an answer
      });

      it("[dl-13527] a distinct dismisser vs renderer stays split (author=dismisser, renderedBy=renderer)", () => {
        const r = deriveReceipt({ cancelled: true, source: "dashboard", author: OP2, renderedBy: OP });
        expect(r.dismissed).toBe(true);
        expect(r.author).toEqual(OP2);
        expect(r.renderedBy).toEqual(OP);
        expect(r.answered).toBe(false);
      });

      it("[dl-13527] TUI cancel (no responder author) → author ABSENT", () => {
        const r = deriveReceipt({ cancelled: true, source: "tui" });
        expect(r.dismissed).toBe(true);
        expect("author" in r).toBe(false);
        expect(r.author).toBeUndefined();
      });

      it("[dl-13527] bus timeout with a render-ACK author → author ABSENT, renderedBy preserved", () => {
        const r = deriveReceipt({ cancelled: true, source: BUS_TIMEOUT_SOURCE, renderedBy: OP });
        expect(r.timedOut).toBe(true);
        expect("author" in r).toBe(false);   // a timeout has no RESPONDER author
        expect(r.renderedBy).toEqual(OP);
      });

      it("[dl-13527 regression] operator-render → TUI-answer (no responder author) → author still ABSENT", () => {
        // The responder (TUI) carried no author; only the render ACK was authored.
        // The fix must NOT let the render identity leak into author.
        const r = deriveReceipt({ answer: "A", cancelled: false, source: "tui", renderedBy: OP });
        expect("author" in r).toBe(false);
        expect(r.renderedBy).toEqual(OP);
        expect(r.answered).toBe(true);
      });
    });
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
