import { describe, it, expect, vi } from "vitest";

// Mock modules before importing
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn(() => ({})),
    String: vi.fn(() => ({})),
    Optional: vi.fn((x: any) => x),
    Array: vi.fn(() => ({})),
    Union: vi.fn(() => ({})),
    Literal: vi.fn(() => ({})),
  },
}));

vi.mock("@earendil-works/pi-ai", () => ({
  StringEnum: vi.fn(() => ({})),
}));

import { registerAskUserTool } from "../ask-user-tool.js";
import { decodeMultiselectAnswer } from "../multiselect-decode.js";

function createMockPi() {
  return {
    registerTool: vi.fn(),
  };
}

describe("registerAskUserTool", () => {
  it("registers ask_user tool", () => {
    const pi = createMockPi();
    registerAskUserTool(pi as any);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool.mock.calls[0][0].name).toBe("ask_user");
  });

  it("registers with correct methods", () => {
    const pi = createMockPi();
    registerAskUserTool(pi as any);

    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.name).toBe("ask_user");
    expect(tool.execute).toBeTypeOf("function");
    expect(tool.promptGuidelines).toBeDefined();
    expect(tool.promptGuidelines.length).toBeGreaterThan(0);
  });

  it("description instructs agents not to add a Select all option", () => {
    const pi = createMockPi();
    registerAskUserTool(pi as any);
    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.description).toMatch(/UI provides a Select all/i);
  });

  describe("message passthrough", () => {
    function getToolAndMockCtx() {
      const pi = createMockPi();
      registerAskUserTool(pi as any);
      const tool = pi.registerTool.mock.calls[0][0];
      // `custom` stands in for the multiselect polyfill: it invokes the factory
      // with a `done` callback; the factory-returned component exposes
      // onConfirm/onCancel. We auto-confirm with ["A"] to preserve the legacy
      // mock return value that the multiselect assertions expected.
      const custom = vi.fn().mockImplementation(async (factory: any) => {
        return await new Promise<unknown>((resolve) => {
          const component: any = factory({}, {}, {}, (r: unknown) => resolve(r));
          component?.onConfirm?.(["A"]);
        });
      });
      const ctx = {
        ui: {
          confirm: vi.fn().mockResolvedValue(true),
          select: vi.fn().mockResolvedValue("A"),
          input: vi.fn().mockResolvedValue("hello"),
          custom,
        },
      };
      return { tool, ctx, custom };
    }

    it("passes message through opts for input", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "input", title: "Q", message: "Details here" }, undefined, undefined, ctx);
      // toolCallId is also threaded through opts since change
      // `fix-interactive-ui-reorder`. Asserts both fields without
      // pinning property order.
      expect(ctx.ui.input).toHaveBeenCalledWith(
        "Q",
        undefined,
        expect.objectContaining({ message: "Details here", toolCallId: "id" }),
      );
    });

    it("passes message through opts for select", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "select", title: "Pick", message: "Context", options: ["A", "B"] }, undefined, undefined, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Pick",
        ["A", "B"],
        expect.objectContaining({ message: "Context", toolCallId: "id" }),
      );
    });

    it("dispatches multiselect through the polyfill via ctx.ui.custom", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      const result = await tool.execute(
        "id",
        { method: "multiselect", title: "Multi", message: "Info", options: ["A"] },
        undefined,
        undefined,
        ctx,
      );
      // Polyfill routes via custom(factory); multiselect is not called directly.
      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
      expect(result.details.method).toBe("multiselect");
      expect(result.details.result).toEqual(["A"]);
    });

    it("passes only toolCallId through opts when message is undefined", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "input", title: "Q" }, undefined, undefined, ctx);
      // Even with no `message`, the wrapper still attaches toolCallId so
      // the resulting prompt_request can be paired by the client reducer.
      expect(ctx.ui.input).toHaveBeenCalledWith(
        "Q",
        undefined,
        expect.objectContaining({ toolCallId: "id" }),
      );
    });

    it("falls back to message when title is missing", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "input", message: "Detailed question" }, undefined, undefined, ctx);
      expect(ctx.ui.input).toHaveBeenCalledWith(
        "Detailed question",
        undefined,
        expect.objectContaining({ message: "Detailed question", toolCallId: "id" }),
      );
    });

    it("falls back to 'Question' when both title and message are missing", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "confirm" }, undefined, undefined, ctx);
      // confirm now also threads toolCallId via 3rd arg.
      expect(ctx.ui.confirm).toHaveBeenCalledWith(
        "Question",
        "",
        expect.objectContaining({ toolCallId: "id" }),
      );
    });

    it("parses options from JSON string", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute("id", { method: "select", title: "Pick", options: '["A", "B"]' }, undefined, undefined, ctx);
      // No message, no other opts — only toolCallId.
      expect(ctx.ui.select).toHaveBeenCalledWith(
        "Pick",
        ["A", "B"],
        expect.objectContaining({ toolCallId: "id" }),
      );
    });

    it("throws when select reaches execute with unparseable options string", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await expect(
        tool.execute("id", { method: "select", title: "Pick", options: "not json" }, undefined, undefined, ctx),
      ).rejects.toThrow(/options/i);
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("throws when select is invoked with empty options array", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await expect(
        tool.execute("id", { method: "select", title: "Pick", options: [] }, undefined, undefined, ctx),
      ).rejects.toThrow(/options.*input/is);
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("throws when multiselect is invoked without options", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await expect(
        tool.execute("id", { method: "multiselect", title: "Pick" }, undefined, undefined, ctx),
      ).rejects.toThrow(/options/i);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    });
  });

  describe("prepareArguments", () => {
    function getTool() {
      const pi = createMockPi();
      registerAskUserTool(pi as any);
      return pi.registerTool.mock.calls[0][0];
    }

    it("leaves empty {} args untouched (no synthetic method) so schema rejection still fires", () => {
      // Regression test for the Opus-emits-empty-args bug seen in session 019dd05c.
      // Our rescue layer must NOT silently fabricate a method/title when there is
      // nothing to rescue — the framework's schema validator must still reject {}
      // so the model is forced to retry with valid args.
      const tool = getTool();
      const result = tool.prepareArguments({});
      expect(result.method).toBeUndefined();
      expect(result.title).toBeUndefined();
      expect(result.questions).toBeUndefined();
      expect(Object.keys(result).filter((k) => k !== "__normalizations")).toHaveLength(0);
    });

    it("parses stringified options array", () => {
      const tool = getTool();
      const result = tool.prepareArguments({ method: "select", title: "Pick", options: '["A", "B"]' });
      expect(result.options).toEqual(["A", "B"]);
    });

    it("leaves real array options unchanged", () => {
      const tool = getTool();
      const result = tool.prepareArguments({ method: "select", title: "Pick", options: ["A", "B"] });
      expect(result.options).toEqual(["A", "B"]);
    });

    it("leaves malformed string as-is", () => {
      const tool = getTool();
      const result = tool.prepareArguments({ method: "select", title: "Pick", options: "not json" });
      expect(result.options).toBe("not json");
    });

    it("unwraps stringified params wrapper", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "select",
        params: '{"title":"X","options":["a","b"]}',
      });
      expect(result.method).toBe("select");
      expect(result.title).toBe("X");
      expect(result.options).toEqual(["a", "b"]);
      expect(result.params).toBeUndefined();
    });

    it("unwraps object-form params wrapper", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "select",
        params: { title: "X", options: ["a", "b"] },
      });
      expect(result.method).toBe("select");
      expect(result.title).toBe("X");
      expect(result.options).toEqual(["a", "b"]);
      expect(result.params).toBeUndefined();
    });

    it("copies question into title when title is absent", () => {
      const tool = getTool();
      const result = tool.prepareArguments({ method: "input", question: "Your name?" });
      expect(result.title).toBe("Your name?");
    });

    it("does not overwrite explicit title with question", () => {
      const tool = getTool();
      const result = tool.prepareArguments({ method: "input", title: "T", question: "Q" });
      expect(result.title).toBe("T");
    });

    it("top-level fields win over params wrapper", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "select",
        title: "OuterTitle",
        params: { title: "InnerTitle", options: ["a", "b"] },
      });
      expect(result.title).toBe("OuterTitle");
      expect(result.options).toEqual(["a", "b"]);
    });

    it("rescues options JSON string inside params wrapper", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "select",
        params: '{"title":"X","options":"[\\"a\\",\\"b\\"]"}',
      });
      expect(result.options).toEqual(["a", "b"]);
    });

    // ── batch rescue ────────────────────────────────────────────────

    it("parses stringified questions array and synthesizes method=batch", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        questions:
          '[{"title":"Pick","method":"select","options":["a","b"]}]',
      });
      expect(result.method).toBe("batch");
      expect(Array.isArray(result.questions)).toBe(true);
      expect(result.questions).toHaveLength(1);
      expect(result.title).toBe("Pick");
    });

    it("backfills missing outer title on explicit method=batch call", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "batch",
        questions: [
          { method: "confirm", question: "Proceed?" },
          { method: "select", question: "Scope?", options: ["A", "B"] },
        ],
      });
      expect(result.title).toBe("Proceed?");
      expect(result.questions[0].title).toBe("Proceed?"); // sub-question rename also fired
      expect(result.questions[1].title).toBe("Scope?");
    });

    it("bare questions array with no method synthesizes method=batch and pulls title", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        questions: [{ method: "confirm", title: "Proceed?" }],
      });
      expect(result.method).toBe("batch");
      expect(result.title).toBe("Proceed?");
    });

    it("pulls title from question or header if sub-question lacks title", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        questions: [{ method: "input", question: "Your name?" }],
      });
      expect(result.method).toBe("batch");
      expect(result.title).toBe("Your name?");
    });

    it("flattens input_type wrapper inside a sub-question", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "batch",
        title: "T",
        questions: [
          {
            title: "Pick",
            input_type: { method: "select", options: ["a", "b"] },
          },
        ],
      });
      const sq = result.questions[0];
      expect(sq.method).toBe("select");
      expect(sq.options).toEqual(["a", "b"]);
      expect(sq.input_type).toBeUndefined();
    });

    it("converts {label, value} options to labels and records a warning", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "batch",
        title: "T",
        questions: [
          {
            method: "select",
            title: "Pick",
            options: [
              { label: "Sync now", value: "sync" },
              { label: "Skip", value: "skip" },
            ],
          },
        ],
      });
      expect(result.questions[0].options).toEqual(["Sync now", "Skip"]);
      const warnings = (result as any).__normalizations as string[];
      expect(warnings).toBeDefined();
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/label.*value/);
    });

    it("renames sub-question header to title", () => {
      const tool = getTool();
      const result = tool.prepareArguments({
        method: "batch",
        title: "T",
        questions: [{ method: "input", header: "Enter name" }],
      });
      expect(result.questions[0].title).toBe("Enter name");
    });
  });

  describe("batch execution", () => {
    function getToolAndMockCtx() {
      const pi = createMockPi();
      registerAskUserTool(pi as any);
      const tool = pi.registerTool.mock.calls[0][0];
      const custom = vi.fn().mockImplementation(async (factory: any) => {
        return await new Promise<unknown>((resolve) => {
          const component: any = factory({}, {}, {}, (r: unknown) => resolve(r));
          component?.onConfirm?.(["A"]);
        });
      });
      const ctx = {
        ui: {
          confirm: vi.fn().mockResolvedValue(true),
          select: vi.fn().mockResolvedValue("A"),
          input: vi.fn().mockResolvedValue("hello"),
          custom,
        },
      };
      return { tool, ctx };
    }

    it("invokes ctx.ui primitives sequentially for each sub-question", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      const result = await tool.execute(
        "id",
        {
          method: "batch",
          title: "Setup",
          questions: [
            { method: "input", title: "Name?" },
            { method: "select", title: "Lang?", options: ["TS", "Py"] },
            { method: "confirm", title: "Init git?" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(ctx.ui.input).toHaveBeenCalledTimes(1);
      expect(ctx.ui.select).toHaveBeenCalledTimes(1);
      expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
      expect(result.details.method).toBe("batch");
      expect(result.details.results).toEqual(["hello", "A", true]);
      expect(result.details.cancelled).toBe(false);
    });

    it("prepends batch title to sub-question titles", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await tool.execute(
        "id",
        {
          method: "batch",
          title: "Setup",
          questions: [{ method: "input", title: "Name?" }],
        },
        undefined,
        undefined,
        ctx,
      );
      const firstCallTitle = ctx.ui.input.mock.calls[0][0];
      expect(firstCallTitle).toContain("Setup");
      expect(firstCallTitle).toContain("Name?");
    });

    it("stops on cancellation and returns partial results with cancelled=true", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      // First sub-question returns a value; second cancels (undefined); third should not be called.
      ctx.ui.input.mockResolvedValueOnce("first");
      ctx.ui.select.mockResolvedValueOnce(undefined); // cancel
      const result = await tool.execute(
        "id",
        {
          method: "batch",
          title: "T",
          questions: [
            { method: "input", title: "Q1" },
            { method: "select", title: "Q2", options: ["a", "b"] },
            { method: "confirm", title: "Q3" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.cancelled).toBe(true);
      expect(result.details.results).toEqual(["first", null]);
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });

    it("surfaces __normalizations warnings in details.warnings", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      const prepared = tool.prepareArguments({
        method: "batch",
        title: "T",
        questions: [
          {
            method: "select",
            title: "Pick",
            options: [
              { label: "A", value: "a" },
              { label: "B", value: "b" },
            ],
          },
        ],
      });
      const result = await tool.execute("id", prepared, undefined, undefined, ctx);
      expect(result.details.warnings).toBeDefined();
      expect(result.details.warnings.length).toBeGreaterThan(0);
      expect(result.details.warnings[0]).toMatch(/label.*value/);
    });

    it("throws if a batch sub-question is select with empty options", async () => {
      const { tool, ctx } = getToolAndMockCtx();
      await expect(
        tool.execute(
          "id",
          {
            method: "batch",
            title: "T",
            questions: [{ method: "select", title: "Pick", options: [] }],
          },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/options/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Receipt (A6) + collision-safe mapping (A4)
  //
  // These exercise execute() as a black box. The mock ctx mirrors the
  // bridge stash EXACTLY: each ctx.ui.* method stashes the full
  // PromptResponse into ctx.ui.__promptReceipts keyed by toolCallId, then
  // collapses to the legacy `string | undefined` contract. The tool reads
  // the stash out-of-band to build details.receipt.
  //
  // Able-to-fail: every assertion on `details.receipt` / `details.selectedIndex`
  // throws on the pre-fix execute() (which returns only {method, result}).
  // ────────────────────────────────────────────────────────────────────
  describe("receipt (A6) + collision-safe mapping (A4)", () => {
    // Build a ctx whose ctx.ui.* methods behave like the bridge-patched ones:
    // stash a PromptResponse per toolCallId, then collapse per method.
    function makeReceiptCtx(responses: Record<string, any>) {
      const store = new Map<string, any>();
      const stash = (opts: any, resp: any) => {
        const tcid = opts?.toolCallId;
        if (tcid) store.set(tcid, resp);
      };
      const ui: any = {
        __promptReceipts: store,
        confirm: vi.fn(async (_t: string, _m: string, opts?: any) => {
          const r = responses.confirm;
          stash(opts, r);
          return !r.cancelled && r.answer === "true";
        }),
        select: vi.fn(async (_t: string, _options: string[], opts?: any) => {
          const r = responses.select;
          stash(opts, r);
          return r.cancelled ? undefined : r.answer;
        }),
        input: vi.fn(async (_t: string, _ph: string | undefined, opts?: any) => {
          const r = responses.input;
          stash(opts, r);
          return r.cancelled ? undefined : r.answer;
        }),
        // Bridge-patched multiselect: routes via PromptBus then decodes.
        multiselect: vi.fn(async (_t: string, _options: string[], opts?: any) => {
          const r = responses.multiselect;
          stash(opts, r);
          return decodeMultiselectAnswer(r);
        }),
      };
      return { ui };
    }

    function getTool() {
      const pi = createMockPi();
      registerAskUserTool(pi as any);
      return pi.registerTool.mock.calls[0][0];
    }

    // (i) answered → receipt.answered=true, source=adapter, result=value
    it("answered select → receipt.answered=true, source=adapter, result=value", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { answer: "Ship it", source: "dashboard" } });
      const result = await tool.execute(
        "tc-1",
        { method: "select", title: "Pick", options: ["Ship it", "Hold"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt).toEqual({
        delivered: true,
        rendered: true,
        answered: true,
        dismissed: false,
        timedOut: false,
        invalid: false,
        source: "dashboard",
      });
      expect(result.details.result).toBe("Ship it");
      expect(result.content[0].text).toMatch(/User responded: "Ship it"/);
    });

    it("answered input → receipt.answered=true with the typed value", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ input: { answer: "Priya", source: "dashboard" } });
      const result = await tool.execute(
        "tc-in",
        { method: "input", title: "Name?" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.answered).toBe(true);
      expect(result.details.receipt.source).toBe("dashboard");
      expect(result.details.result).toBe("Priya");
    });

    it("answered confirm=false is a real decision (answered=true, result=false)", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ confirm: { answer: "false", source: "dashboard" } });
      const result = await tool.execute(
        "tc-c",
        { method: "confirm", title: "Proceed?" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.answered).toBe(true);
      expect(result.details.result).toBe(false);
      expect(result.content[0].text).toMatch(/User responded: false/);
    });

    // (ii) dismissed → receipt.dismissed=true, result no-decision
    it("dismissed select → receipt.dismissed=true, delivered=true, text is a clear non-decision", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { cancelled: true, source: "dashboard" } });
      const result = await tool.execute(
        "tc-2",
        { method: "select", title: "Pick", options: ["A", "B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.dismissed).toBe(true);
      expect(result.details.receipt.delivered).toBe(true);
      expect(result.details.receipt.answered).toBe(false);
      expect(result.details.receipt.timedOut).toBe(false);
      expect(result.details.result).toBeUndefined();
      // Never reads as a decision.
      expect(result.content[0].text).not.toMatch(/User responded/);
      expect(result.content[0].text).toMatch(/dismiss/i);
    });

    // (iii) timeout / __bus__ → receipt.timedOut=true, delivered distinguishes never-rendered
    it("timed-out select (__bus__) → receipt.timedOut=true, delivered=false (never rendered)", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { cancelled: true, source: "__bus__" } });
      const result = await tool.execute(
        "tc-3",
        { method: "select", title: "Pick", options: ["A", "B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.timedOut).toBe(true);
      expect(result.details.receipt.delivered).toBe(false);
      expect(result.details.receipt.dismissed).toBe(false);
      expect(result.details.receipt.answered).toBe(false);
      expect(result.content[0].text).not.toMatch(/User responded/);
      expect(result.content[0].text).toMatch(/timed out|never (delivered|rendered)/i);
    });

    it("dismiss vs timeout are DISTINGUISHABLE from one another (the live n=3 conflation)", async () => {
      const tool = getTool();
      const dismissed = await tool.execute(
        "d",
        { method: "input", title: "Q" },
        undefined,
        undefined,
        makeReceiptCtx({ input: { cancelled: true, source: "dashboard" } }),
      );
      const timedOut = await tool.execute(
        "t",
        { method: "input", title: "Q" },
        undefined,
        undefined,
        makeReceiptCtx({ input: { cancelled: true, source: "__bus__" } }),
      );
      // Pre-fix, both collapse to `result: undefined` and are indistinguishable.
      expect(dismissed.details.receipt.dismissed).toBe(true);
      expect(dismissed.details.receipt.timedOut).toBe(false);
      expect(timedOut.details.receipt.timedOut).toBe(true);
      expect(timedOut.details.receipt.dismissed).toBe(false);
    });

    // (iv) A4 fail-closed: duplicate labels are REJECTED before render (the
    // display-rename bijection is superseded — Pete dl-13350 + Lane).
    it("[A4] duplicate-label select → REJECTED before any render (fail-closed)", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { answer: "Deploy", source: "dashboard" } });
      await expect(
        tool.execute(
          "tc-4",
          { method: "select", title: "Action", options: ["Deploy", "Deploy", "Rollback"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/distinct/i);
      // The prompt was NEVER rendered — no ctx.ui.select call fired.
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("[A4] trimmed-duplicate select (\"Deploy\" vs \"Deploy \") → REJECTED before render", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { answer: "Deploy", source: "dashboard" } });
      await expect(
        tool.execute(
          "tc-4b",
          { method: "select", title: "Action", options: ["Deploy", "Deploy ", "Rollback"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/distinct/i);
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("[A4] duplicate-label multiselect → REJECTED before render", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ multiselect: { answer: '["A"]', source: "dashboard" } });
      await expect(
        tool.execute(
          "tc-4c",
          { method: "multiselect", title: "Pick", options: ["A", "A", "B"] },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow(/distinct/i);
      expect(ctx.ui.multiselect).not.toHaveBeenCalled();
    });

    it("distinct-label select is unchanged: same labels shown, index preserved", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { answer: "Hold", source: "dashboard" } });
      const result = await tool.execute(
        "tc-5",
        { method: "select", title: "Pick", options: ["Ship", "Hold", "Cancel"] },
        undefined,
        undefined,
        ctx,
      );
      expect(ctx.ui.select.mock.calls[0][1]).toEqual(["Ship", "Hold", "Cancel"]);
      expect(result.details.selectedIndex).toBe(1);
      expect(result.details.result).toBe("Hold");
    });

    // Batch receipts — per-question + aggregate
    it("batch: per-question receipts distinguish answered from the cancelling reason", async () => {
      const tool = getTool();
      const store = new Map<string, any>();
      // Sequential responses per method call; input answers, select times out.
      const inputResp = { answer: "Alice", source: "dashboard" };
      const selectResp = { cancelled: true, source: "__bus__" };
      const ui: any = {
        __promptReceipts: store,
        input: vi.fn(async (_t: string, _ph: any, opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, inputResp);
          return inputResp.answer;
        }),
        select: vi.fn(async (_t: string, _o: string[], opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, selectResp);
          return undefined; // cancelled collapse
        }),
        confirm: vi.fn(),
      };
      const result = await tool.execute(
        "tc-batch",
        {
          method: "batch",
          title: "Setup",
          questions: [
            { method: "input", title: "Name?" },
            { method: "select", title: "Lang?", options: ["TS", "Py"] },
            { method: "confirm", title: "Init?" },
          ],
        },
        undefined,
        undefined,
        { ui },
      );
      expect(result.details.cancelled).toBe(true);
      // Third question never asked (batch stopped on the select timeout).
      expect(ui.confirm).not.toHaveBeenCalled();
      // Per-question receipts.
      expect(result.details.receipts).toHaveLength(2);
      expect(result.details.receipts[0].answered).toBe(true);
      expect(result.details.receipts[1].timedOut).toBe(true);
      // Aggregate reflects the decisive (cancelling) receipt.
      expect(result.details.receipt.answered).toBe(false);
      expect(result.details.receipt.timedOut).toBe(true);
      expect(result.details.receipt.dismissed).toBe(false);
    });

    it("batch: fully answered → aggregate receipt.answered=true", async () => {
      const tool = getTool();
      const store = new Map<string, any>();
      const ui: any = {
        __promptReceipts: store,
        input: vi.fn(async (_t: string, _ph: any, opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, { answer: "Alice", source: "dashboard" });
          return "Alice";
        }),
        confirm: vi.fn(async (_t: string, _m: string, opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, { answer: "true", source: "dashboard" });
          return true;
        }),
      };
      const result = await tool.execute(
        "tc-batch2",
        {
          method: "batch",
          title: "Setup",
          questions: [
            { method: "input", title: "Name?" },
            { method: "confirm", title: "Init?" },
          ],
        },
        undefined,
        undefined,
        { ui },
      );
      expect(result.details.cancelled).toBe(false);
      expect(result.details.receipt.answered).toBe(true);
      expect(result.details.receipt.delivered).toBe(true);
      expect(result.details.receipts).toHaveLength(2);
      expect(result.details.receipts.every((r: any) => r.answered)).toBe(true);
    });

    // ── A2 / A3 able-to-fail: malformed / no-answer → explicit non-decision,
    //    NEVER "User responded: undefined". Empty string + false stay valid. ──
    it("[A2/A3 able-to-fail] malformed select (cancelled:false, answer:undefined) → invalid non-decision, never 'User responded: undefined'", async () => {
      const tool = getTool();
      // A non-cancelled response whose answer field is ABSENT. The bridge
      // collapse yields `undefined`; the stashed response drives the receipt.
      const store = new Map<string, any>();
      const ui: any = {
        __promptReceipts: store,
        select: vi.fn(async (_t: string, _o: string[], opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, { cancelled: false, source: "dashboard", answer: undefined });
          return undefined; // collapsed
        }),
      };
      const result = await tool.execute(
        "tc-malformed",
        { method: "select", title: "Pick", options: ["A", "B"] },
        undefined,
        undefined,
        { ui },
      );
      expect(result.details.receipt.answered).toBe(false); // RED pre-amendment (was true)
      expect(result.details.receipt.invalid).toBe(true);
      expect(result.details.result).toBeUndefined();
      expect(result.content[0].text).not.toMatch(/User responded/);
      expect(result.content[0].text).toMatch(/malformed|no valid answer/i);
    });

    it("[A2] input answered with empty string is a VALID decision (answered, result='')", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ input: { answer: "", source: "dashboard" } });
      const result = await tool.execute(
        "tc-empty",
        { method: "input", title: "Notes?" },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.answered).toBe(true);
      expect(result.details.receipt.invalid).toBe(false);
      expect(result.details.result).toBe("");
      expect(result.content[0].text).toMatch(/User responded: ""/);
    });

    it("[A3] batch sub-question malformed → aggregate invalid, readable non-decision line", async () => {
      const tool = getTool();
      const store = new Map<string, any>();
      const ui: any = {
        __promptReceipts: store,
        input: vi.fn(async (_t: string, _ph: any, opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, { answer: "Alice", source: "dashboard" });
          return "Alice";
        }),
        select: vi.fn(async (_t: string, _o: string[], opts?: any) => {
          if (opts?.toolCallId) store.set(opts.toolCallId, { cancelled: false, source: "dashboard", answer: undefined });
          return undefined; // malformed collapse
        }),
        confirm: vi.fn(),
      };
      const result = await tool.execute(
        "tc-batch-malformed",
        {
          method: "batch",
          title: "Setup",
          questions: [
            { method: "input", title: "Name?" },
            { method: "select", title: "Lang?", options: ["TS", "Py"] },
            { method: "confirm", title: "Init?" },
          ],
        },
        undefined,
        undefined,
        { ui },
      );
      expect(result.details.cancelled).toBe(true);
      expect(ui.confirm).not.toHaveBeenCalled();
      expect(result.details.receipts[0].answered).toBe(true);
      expect(result.details.receipts[1].invalid).toBe(true);
      expect(result.details.receipt.invalid).toBe(true);
      expect(result.content[0].text).toMatch(/malformed|no valid answer/i);
      expect(result.content[0].text).not.toMatch(/User responded: undefined/);
    });

    it("[A4] batch sub-question with duplicate options → REJECTED before render", async () => {
      const tool = getTool();
      const store = new Map<string, any>();
      const ui: any = {
        __promptReceipts: store,
        input: vi.fn(async () => "Alice"),
        select: vi.fn(async () => "TS"),
        confirm: vi.fn(),
      };
      await expect(
        tool.execute(
          "tc-batch-dup",
          {
            method: "batch",
            title: "Setup",
            questions: [
              { method: "input", title: "Name?" },
              { method: "select", title: "Lang?", options: ["TS", "TS", "Py"] },
            ],
          },
          undefined,
          undefined,
          { ui },
        ),
      ).rejects.toThrow(/distinct/i);
      // The duplicate select is never rendered.
      expect(ui.select).not.toHaveBeenCalled();
    });

    // ── A1 mechanism (unit): render-ACK threads through PromptBus so a rendered
    //    timeout is delivered:true, an un-ACKed timeout is delivered:false. The
    //    live client-sends-the-ACK path is the DEFERRED actual-surface arm. ──
    it("[A1] rendered-then-timeout receipt is delivered:true (via stashed rendered flag)", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ select: { cancelled: true, source: "__bus__", rendered: true } });
      const result = await tool.execute(
        "tc-a1",
        { method: "select", title: "Pick", options: ["A", "B"] },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.receipt.timedOut).toBe(true);
      expect(result.details.receipt.delivered).toBe(true);
      expect(result.details.receipt.rendered).toBe(true);
      expect(result.content[0].text).not.toMatch(/User responded/);
      expect(result.content[0].text).toMatch(/timed out|never (delivered|rendered)/i);
    });

    // (v) ABLE-TO-FAIL CONTROL: proves the pre-fix collapse can't distinguish
    // a dismiss from a decision. On the unfixed execute(), details.receipt is
    // undefined → this throws (RED). After the fix it passes (GREEN).
    it("[able-to-fail control] pre-fix dismissed confirm cannot be told from a decision", async () => {
      const tool = getTool();
      const ctx = makeReceiptCtx({ confirm: { cancelled: true, source: "dashboard" } });
      const result = await tool.execute(
        "tc-ctrl",
        { method: "confirm", title: "Deploy to production now?" },
        undefined,
        undefined,
        ctx,
      );
      // The crux: a dismissed confirm must NOT surface as a "no" decision.
      expect(result.details.receipt).toBeDefined();
      expect(result.details.receipt.answered).toBe(false);
      expect(result.details.receipt.dismissed).toBe(true);
      expect(result.content[0].text).not.toMatch(/User responded/);
    });
  });
});
