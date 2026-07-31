import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PromptBus, type PromptAdapter, type PromptRequest, type PromptResponse, type PromptAuthor } from "../prompt-bus.js";
import { deriveReceipt } from "../prompt-receipt.js";

function createMockAdapter(name: string, claim: any = {}) {
  return {
    name,
    onRequest: vi.fn().mockReturnValue(claim) as any,
    onResponse: vi.fn() as any,
    onCancel: vi.fn() as any,
  } satisfies PromptAdapter;
}

describe("PromptBus", () => {
  let bus: PromptBus;
  let onDashboardRequest: any;
  let onDashboardDismiss: any;
  let onDashboardCancel: any;

  beforeEach(() => {
    vi.useFakeTimers();
    onDashboardRequest = vi.fn() as any;
    onDashboardDismiss = vi.fn() as any;
    onDashboardCancel = vi.fn() as any;
    bus = new PromptBus({
      timeoutMs: 5000,
      onDashboardRequest,
      onDashboardDismiss,
      onDashboardCancel,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("adapter registration", () => {
    it("should register an adapter", () => {
      const adapter = createMockAdapter("test");
      bus.registerAdapter(adapter);
      expect(bus.adapterNames).toEqual(["test"]);
    });

    it("should replace adapter with same name on re-registration", () => {
      const adapter1 = createMockAdapter("test");
      const adapter2 = createMockAdapter("test");
      bus.registerAdapter(adapter1);
      bus.registerAdapter(adapter2);
      expect(bus.adapterNames).toEqual(["test"]);

      // Verify new adapter is used
      bus.request({ pipeline: "command", type: "select", question: "Pick:", options: ["A"] });
      expect(adapter2.onRequest).toHaveBeenCalled();
      expect(adapter1.onRequest).not.toHaveBeenCalled();
    });

    it("should unregister adapter via returned function", () => {
      const adapter = createMockAdapter("test");
      const unsub = bus.registerAdapter(adapter);
      expect(bus.adapterNames).toEqual(["test"]);
      unsub();
      expect(bus.adapterNames).toEqual([]);
    });

    it("should support multiple adapters", () => {
      bus.registerAdapter(createMockAdapter("a"));
      bus.registerAdapter(createMockAdapter("b"));
      expect(bus.adapterNames).toEqual(["a", "b"]);
    });
  });

  describe("request distribution", () => {
    it("should call onRequest on all registered adapters", () => {
      const a = createMockAdapter("a");
      const b = createMockAdapter("b");
      bus.registerAdapter(a);
      bus.registerAdapter(b);

      bus.request({ pipeline: "command", type: "select", question: "Pick:", options: ["A", "B"] });

      expect(a.onRequest).toHaveBeenCalledWith(expect.objectContaining({
        pipeline: "command",
        type: "select",
        question: "Pick:",
        options: ["A", "B"],
      }));
      expect(b.onRequest).toHaveBeenCalledWith(expect.objectContaining({
        pipeline: "command",
      }));
    });

    it("should generate a unique id for each request", () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Q1", options: ["A"] });
      bus.request({ pipeline: "command", type: "select", question: "Q2", options: ["B"] });

      const id1 = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      const id2 = (adapter.onRequest.mock.calls[1][0] as PromptRequest).id;
      expect(id1).not.toBe(id2);
    });

    it("should send prompt_request to dashboard with custom component if claimed", () => {
      const adapter = createMockAdapter("arch", {
        component: { type: "architect-prompt", props: { foo: 1 } },
        placement: "widget-bar",
      });
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "architect-new", type: "select", question: "Save?", options: ["Save", "Cancel"] });

      expect(onDashboardRequest).toHaveBeenCalledWith(
        expect.objectContaining({ question: "Save?" }),
        { type: "architect-prompt", props: { foo: 1 } },
        "widget-bar",
      );
    });

    it("should fall back to generic-dialog when no adapter claims with component", () => {
      const adapter = createMockAdapter("tui", {}); // no component
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Pick:", options: ["A"] });

      expect(onDashboardRequest).toHaveBeenCalledWith(
        expect.objectContaining({ question: "Pick:" }),
        expect.objectContaining({ type: "generic-dialog" }),
        "inline",
      );
    });

    it("should use first adapter's component when multiple claim", () => {
      const a = createMockAdapter("a", {
        component: { type: "custom-a", props: {} },
        placement: "widget-bar",
      });
      const b = createMockAdapter("b", {
        component: { type: "custom-b", props: {} },
        placement: "inline",
      });
      bus.registerAdapter(a);
      bus.registerAdapter(b);

      bus.request({ pipeline: "test", type: "select", question: "Q", options: [] });

      expect(onDashboardRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "custom-a" }),
        "widget-bar",
      );
    });

    it("should skip adapters that return null", () => {
      const a = createMockAdapter("a");
      a.onRequest.mockReturnValue(null);
      const b = createMockAdapter("b", {});
      bus.registerAdapter(a);
      bus.registerAdapter(b);

      bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });

      // Should still send to dashboard (generic fallback since b has no component)
      expect(onDashboardRequest).toHaveBeenCalled();
    });

    it("should handle adapter onRequest throwing without breaking", () => {
      const bad = createMockAdapter("bad");
      bad.onRequest.mockImplementation(() => { throw new Error("boom"); });
      const good = createMockAdapter("good", {});
      bus.registerAdapter(bad);
      bus.registerAdapter(good);

      bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });

      expect(good.onRequest).toHaveBeenCalled();
    });
  });

  describe("first-response-wins", () => {
    it("should resolve with first response", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id, answer: "A", source: "a" });

      const result = await promise;
      // A1: respond threads the pending render flag (false when no ACK arrived).
      expect(result).toEqual({ id, answer: "A", source: "a", rendered: false });
    });

    it("should ignore second response for same prompt", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id, answer: "A", source: "tui" });
      bus.respond({ id, answer: "B", source: "dashboard" }); // late, ignored

      const result = await promise;
      expect(result.answer).toBe("A");
      expect(result.source).toBe("tui");
    });

    it("should remove from pending after response", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      expect(bus.pendingCount).toBe(1);

      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      bus.respond({ id, answer: "A", source: "a" });
      await promise;

      expect(bus.pendingCount).toBe(0);
    });
  });

  describe("cross-adapter dismissal", () => {
    it("should call onResponse on all adapters when one responds", async () => {
      const a = createMockAdapter("a");
      const b = createMockAdapter("b");
      bus.registerAdapter(a);
      bus.registerAdapter(b);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (a.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id, answer: "X", source: "a" });
      await promise;

      expect(a.onResponse).toHaveBeenCalledWith({ id, answer: "X", source: "a" });
      expect(b.onResponse).toHaveBeenCalledWith({ id, answer: "X", source: "a" });
    });

    it("should send dashboard dismiss on response", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id, answer: "A", source: "tui" });
      await promise;

      expect(onDashboardDismiss).toHaveBeenCalledWith(id);
    });
  });

  describe("cancellation", () => {
    it("should resolve with cancelled when cancel is called", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.cancel(id);

      const result = await promise;
      expect(result.cancelled).toBe(true);
    });

    it("should call onCancel on all adapters", async () => {
      const a = createMockAdapter("a");
      const b = createMockAdapter("b");
      bus.registerAdapter(a);
      bus.registerAdapter(b);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (a.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.cancel(id);
      await promise;

      expect(a.onCancel).toHaveBeenCalledWith(id);
      expect(b.onCancel).toHaveBeenCalledWith(id);
    });

    it("should send dashboard cancel on cancel", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.cancel(id);
      await promise;

      expect(onDashboardCancel).toHaveBeenCalledWith(id);
    });

    it("should be a no-op when cancelling already-resolved prompt", () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id, answer: "A", source: "a" });
      bus.cancel(id); // no-op, no error

      expect(adapter.onCancel).not.toHaveBeenCalled();
    });
  });

  describe("timeout", () => {
    it("should cancel prompt after timeout", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });

      vi.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.cancelled).toBe(true);
      expect(adapter.onCancel).toHaveBeenCalled();
    });

    it("should not timeout if answered before deadline", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      vi.advanceTimersByTime(2000);
      bus.respond({ id, answer: "A", source: "a" });

      const result = await promise;
      expect(result.answer).toBe("A");
      expect(result.cancelled).toBeUndefined();

      // Advance past timeout — should be no-op
      vi.advanceTimersByTime(5000);
      expect(adapter.onCancel).not.toHaveBeenCalled();
    });

    it("should never timeout when timeoutMs is -1 (infinite)", async () => {
      const infiniteBus = new PromptBus({
        timeoutMs: -1,
        onDashboardRequest,
        onDashboardDismiss,
        onDashboardCancel,
      });
      const adapter = createMockAdapter("a");
      infiniteBus.registerAdapter(adapter);

      const promise = infiniteBus.request({ pipeline: "command", type: "select", question: "Q", options: [] });

      // Advance way past the default 5-minute timeout
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Still pending — no cancellation fired
      expect(adapter.onCancel).not.toHaveBeenCalled();
      expect(infiniteBus.pendingCount).toBe(1);

      // Can still be answered normally
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      infiniteBus.respond({ id, answer: "late", source: "a" });
      const result = await promise;
      expect(result.answer).toBe("late");
      expect(result.cancelled).toBeUndefined();
    });

    it("should never timeout when timeoutMs is 0 (also treated as infinite)", async () => {
      const infiniteBus = new PromptBus({
        timeoutMs: 0,
        onDashboardRequest,
        onDashboardDismiss,
        onDashboardCancel,
      });
      const adapter = createMockAdapter("a");
      infiniteBus.registerAdapter(adapter);

      infiniteBus.request({ pipeline: "command", type: "select", question: "Q", options: [] });

      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(adapter.onCancel).not.toHaveBeenCalled();
      expect(infiniteBus.pendingCount).toBe(1);
    });
  });

  // ── A1 render-lifecycle ACK (markRendered) ──
  describe("markRendered (A1 render ACK)", () => {
    it("a timeout AFTER markRendered resolves with rendered:true (delivered timeout)", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      // Client ACKs the render, THEN the prompt times out.
      bus.markRendered(id);
      vi.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.cancelled).toBe(true);
      expect(result.source).toBe("__bus__");
      expect(result.rendered).toBe(true); // RED pre-amendment (no markRendered / field)
    });

    it("a timeout WITHOUT markRendered resolves with rendered:false (never-rendered)", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      vi.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.cancelled).toBe(true);
      expect(result.rendered).toBe(false);
    });

    it("an answer after markRendered threads rendered:true", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id);
      bus.respond({ id, answer: "A", source: "a" });

      const result = await promise;
      expect(result.answer).toBe("A");
      expect(result.rendered).toBe(true);
    });

    it("markRendered on an unknown / already-resolved id is a no-op (no throw)", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      bus.respond({ id, answer: "A", source: "a" });
      await promise;

      // Late ACK after resolution — must not throw.
      expect(() => bus.markRendered(id)).not.toThrow();
      expect(() => bus.markRendered("nonexistent")).not.toThrow();
    });

    // ── C1 (dl-r3): markRendered is idempotent — the AT-LEAST-ONCE client can
    //    re-send the ACK on every remount/reconnect; the server dedups so there
    //    is NO false double-effect. This SERVER idempotency is what now
    //    guarantees "no false duplicate" (superseding client exactly-once). ──
    it("[C1] duplicate markRendered (at-least-once client retries) marks once — no double-effect", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      // The client re-sends the ACK on each remount/reconnect (at-least-once).
      bus.markRendered(id);
      bus.markRendered(id);
      bus.markRendered(id);

      // Timeout → the receipt carries rendered:true ONCE; duplicates are a no-op
      // (the pending flag is simply set; no cumulative/side effect).
      vi.advanceTimersByTime(5000);
      const result = await promise;
      expect(result.cancelled).toBe(true);
      expect(result.rendered).toBe(true);
      // onCancel fired exactly once — the duplicate ACKs never re-triggered
      // adapter callbacks or resolved the prompt more than once.
      expect(adapter.onCancel).toHaveBeenCalledTimes(1);
    });

    it("[C1] a DROPPED first ACK is recovered by a later markRendered (at-least-once)", async () => {
      // Model transport: the client's first ACK send never reached the server
      // (dropped), so markRendered was NOT called at send time. On reconnect the
      // client re-sends and markRendered runs BEFORE the timeout → delivered.
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      // (first ACK dropped — no markRendered here)
      vi.advanceTimersByTime(2000);
      // reconnect remount re-sends → reaches the server this time
      bus.markRendered(id);
      vi.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.rendered).toBe(true); // recovered (pre-fix perma-Set: false forever)
    });
  });

  describe("concurrent prompts", () => {
    it("should handle multiple pending prompts independently", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise1 = bus.request({ pipeline: "command", type: "select", question: "Q1", options: ["A"] });
      const promise2 = bus.request({ pipeline: "architect-new", type: "input", question: "Q2" });

      expect(bus.pendingCount).toBe(2);

      const id1 = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      const id2 = (adapter.onRequest.mock.calls[1][0] as PromptRequest).id;

      bus.respond({ id: id1, answer: "A", source: "tui" });

      const result1 = await promise1;
      expect(result1.answer).toBe("A");
      expect(bus.pendingCount).toBe(1);

      bus.respond({ id: id2, answer: "guidance", source: "dashboard" });

      const result2 = await promise2;
      expect(result2.answer).toBe("guidance");
      expect(bus.pendingCount).toBe(0);
    });

    it("should not dismiss other prompts when one is answered", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Q1", options: [] });
      bus.request({ pipeline: "command", type: "select", question: "Q2", options: [] });

      const id1 = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.respond({ id: id1, answer: "A", source: "tui" });

      // Second prompt should still be pending
      expect(bus.pendingCount).toBe(1);
    });
  });

  describe("respond with unknown id", () => {
    it("should silently ignore response for unknown prompt id", () => {
      bus.respond({ id: "nonexistent", answer: "A", source: "tui" });
      // No error
    });
  });

  describe("getPendingRequests", () => {
    it("should return empty array when no prompts are pending", () => {
      expect(bus.getPendingRequests()).toEqual([]);
    });

    it("should return pending prompt with resolved component", () => {
      const adapter = createMockAdapter("a", {
        component: { type: "custom-ui", props: { x: 1 } },
        placement: "widget-bar",
      });
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Pick:", options: ["A"] });

      const pending = bus.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].request).toEqual(expect.objectContaining({
        pipeline: "command",
        type: "select",
        question: "Pick:",
      }));
      expect(pending[0].component).toEqual({ type: "custom-ui", props: { x: 1 } });
      expect(pending[0].placement).toBe("widget-bar");
    });

    it("should return generic-dialog component when no adapter claims with component", () => {
      const adapter = createMockAdapter("tui", {}); // no component
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Pick:", options: ["A"] });

      const pending = bus.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0].component.type).toBe("generic-dialog");
      expect(pending[0].placement).toBe("inline");
    });

    it("should omit resolved prompts", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      expect(bus.getPendingRequests()).toHaveLength(1);

      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      bus.respond({ id, answer: "A", source: "a" });
      await promise;

      expect(bus.getPendingRequests()).toEqual([]);
    });

    it("should omit cancelled prompts", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: [] });
      expect(bus.getPendingRequests()).toHaveLength(1);

      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;
      bus.cancel(id);
      await promise;

      expect(bus.getPendingRequests()).toEqual([]);
    });

    it("should return multiple pending prompts", () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);

      bus.request({ pipeline: "command", type: "select", question: "Q1", options: ["A"] });
      bus.request({ pipeline: "command", type: "input", question: "Q2" });

      expect(bus.getPendingRequests()).toHaveLength(2);
    });
  });

  // ── D1 (Pete BLOCK dl-13383): responder-attribution split — WHO ANSWERED
  //    (`author`) must be the responder's own author ONLY; WHO RENDERED rides on
  //    the SEPARATE `renderedBy`. The answer-author must NEVER fall back to the
  //    render-ACK author, else a TUI answer after an operator render falsely
  //    proves the operator answered. Full pipeline: request → markRendered(op) →
  //    respond/timeout → resolved response → deriveReceipt. ──
  describe("responder-attribution split (D1 / dl-13383)", () => {
    const OP: PromptAuthor = { sub: "op-1", display: "Operator One", isOperator: true };
    const OP2: PromptAuthor = { sub: "op-2", display: "Operator Two", isOperator: true };

    // Test #1 — operator-render → TUI-answer: the answer-author is the
    // responder's (ABSENT for the TUI), never the render identity.
    it("[#1a able-to-fail] operator RENDERED, TUI ANSWERED first (no author) → resolved.author ABSENT (pre-fix: =operator), renderedBy=operator", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id, OP);                          // operator renders
      bus.respond({ id, answer: "A", source: "tui" });   // TUI answers, NO author

      const resolved = await promise;
      // Pre-fix (`author: response.author ?? entry.renderedAuthor`) would put OP
      // here — a FALSE operator-answer proof. Post-fix it is absent.
      expect(resolved.author).toBeUndefined();
      expect(resolved.renderedBy).toEqual(OP);
      expect(resolved.source).toBe("tui");

      const receipt = deriveReceipt(resolved);
      expect("author" in receipt).toBe(false);           // NOT an authenticated-operator answer
      expect(receipt.renderedBy).toEqual(OP);
      expect(receipt.answered).toBe(true);
      expect(receipt.source).toBe("tui");
    });

    it("[#1b able-to-fail] operator RENDERED, TUI CANCELLED (dismiss, no author) → author ABSENT (pre-fix: =operator), renderedBy=operator", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id, OP);                                 // operator renders
      bus.respond({ id, cancelled: true, source: "tui" });      // TUI dismiss, NO author

      const resolved = await promise;
      expect(resolved.author).toBeUndefined();                 // pre-fix: =operator (FALSE)
      expect(resolved.renderedBy).toEqual(OP);

      const receipt = deriveReceipt(resolved);
      expect("author" in receipt).toBe(false);
      expect(receipt.dismissed).toBe(true);
      expect(receipt.renderedBy).toEqual(OP);
    });

    // Test #2 — dashboard-answer: operator renders AND answers → author=operator.
    it("[#2] operator RENDERED and ANSWERED → receipt.author=operator (the answerer)", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id, OP);
      bus.respond({ id, answer: "A", source: "dashboard-default", author: OP }); // operator answers

      const resolved = await promise;
      expect(resolved.author).toEqual(OP);
      expect(resolved.renderedBy).toEqual(OP);

      const receipt = deriveReceipt(resolved);
      expect(receipt.author).toEqual(OP);   // the ANSWERER
      expect(receipt.answered).toBe(true);
    });

    it("[#2-split] renderer and answerer are DISTINCT operators — kept separate end-to-end", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id, OP);                                              // OP renders
      bus.respond({ id, answer: "A", source: "dashboard-default", author: OP2 }); // OP2 answers

      const resolved = await promise;
      const receipt = deriveReceipt(resolved);
      expect(receipt.author).toEqual(OP2);      // answerer
      expect(receipt.renderedBy).toEqual(OP);   // renderer
    });

    // Test #3 — rendered-timeout: operator renders, nobody answers, bus timeout.
    it("[#3] operator RENDERED, NO answer, bus TIMEOUT → renderedBy=operator, author ABSENT, timedOut=true", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      const id = (adapter.onRequest.mock.calls[0][0] as PromptRequest).id;

      bus.markRendered(id, OP);          // operator renders
      vi.advanceTimersByTime(5000);      // bus timeout fires (no answer)

      const resolved = await promise;
      expect(resolved.cancelled).toBe(true);
      expect(resolved.source).toBe("__bus__");
      expect(resolved.author).toBeUndefined();     // pre-fix: =operator (FALSE — nobody answered)
      expect(resolved.renderedBy).toEqual(OP);

      const receipt = deriveReceipt(resolved);
      expect("author" in receipt).toBe(false);
      expect(receipt.renderedBy).toEqual(OP);
      expect(receipt.timedOut).toBe(true);
      expect(receipt.delivered).toBe(true);
      expect(receipt.rendered).toBe(true);
      expect(receipt.answered).toBe(false);
    });

    it("[#3-never] never-rendered (no ACK), bus TIMEOUT → neither author nor renderedBy", async () => {
      const adapter = createMockAdapter("a");
      bus.registerAdapter(adapter);
      const promise = bus.request({ pipeline: "command", type: "select", question: "Q", options: ["A", "B"] });
      vi.advanceTimersByTime(5000);

      const resolved = await promise;
      expect(resolved.author).toBeUndefined();
      expect(resolved.renderedBy).toBeUndefined();

      const receipt = deriveReceipt(resolved);
      expect("author" in receipt).toBe(false);
      expect("renderedBy" in receipt).toBe(false);
      expect(receipt.timedOut).toBe(true);
      expect(receipt.delivered).toBe(false);
    });
  });
});
