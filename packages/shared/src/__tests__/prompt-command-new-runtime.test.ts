import { describe, expect, it } from "vitest";
import { isBridgeCommandText, parseSendPrompt } from "../prompt-command.js";

/**
 * `/new [runtime]` grammar.
 *
 * The bare form MUST keep spawning pi — an agent that types `/new` today gets a
 * pi session and must keep getting one. The argument form selects a runtime;
 * an unknown token is a DISTINCT parse result so the bridge can refuse it
 * visibly instead of silently degrading to pi or leaking the text to the model.
 */
describe("/new runtime grammar", () => {
  it("keeps the bare form on pi (default unchanged)", () => {
    expect(parseSendPrompt("/new")).toEqual({ type: "new", runtime: "pi" });
  });

  it("accepts an explicit pi argument", () => {
    expect(parseSendPrompt("/new pi")).toEqual({ type: "new", runtime: "pi" });
  });

  it("accepts codex", () => {
    expect(parseSendPrompt("/new codex")).toEqual({ type: "new", runtime: "codex" });
  });

  it("tolerates surrounding whitespace and case", () => {
    expect(parseSendPrompt("/new   codex  ")).toEqual({ type: "new", runtime: "codex" });
    expect(parseSendPrompt("/new CODEX")).toEqual({ type: "new", runtime: "codex" });
    expect(parseSendPrompt("/new  ")).toEqual({ type: "new", runtime: "pi" });
  });

  it("routes an unknown runtime to a distinct, visibly-refusable result", () => {
    expect(parseSendPrompt("/new bogus")).toEqual({ type: "new-invalid", requested: "bogus" });
    expect(parseSendPrompt("/new pi codex")).toEqual({ type: "new-invalid", requested: "pi codex" });
  });

  it("classifies every /new form as an operator-only command, never co-drive passthrough", () => {
    // Fail-closed residual: the server authorizes command-form text operator-only.
    // A new grammar form that fell through to `passthrough` would silently become
    // co-drive-writable — that is the escape this assertion pins shut.
    for (const text of ["/new", "/new pi", "/new codex", "/new bogus"]) {
      expect(isBridgeCommandText(text)).toBe(true);
    }
  });

  it("leaves unrelated slash commands alone", () => {
    expect(parseSendPrompt("/newsletter").type).toBe("slash");
    expect(parseSendPrompt("/reload").type).toBe("reload");
  });
});
