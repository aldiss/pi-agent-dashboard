import { describe, expect, it, vi } from "vitest";
import {
  TRANSLATOR_VERSION,
  checkChangedSpanActions,
  countKnownBadPatterns,
  createTranslatorService,
  displayTextForTranslation,
  extractTranslationRequest,
  maskProtectedSpans,
  selectTranslatorModel,
  translationSafetyIssues,
} from "../translator-service.js";

const LONG_SOURCE =
  "The internal handoff remains blocked because the registry read did not complete after 16 attempts.";

describe("dashboard translator service", () => {
  it("masks quoted evidence, code, paths, and identifiers before inference, then restores them byte-identically", async () => {
    const source = [
      "The internal handoff remains blocked and did not complete after 16 attempts.",
      'Operator wrote "ты иеня извини" and that typo is evidence.',
      "Use `exact_get()` in /tmp/operator/file.ts with registryValue.",
    ].join("\n");
    let modelInput = "";
    let modelMaxTokens = 0;
    const service = createTranslatorService({
      runModel: async ({ text, maxTokens }) => {
        modelInput = text;
        modelMaxTokens = maxTokens;
        return text.replace("internal handoff", "work transfer");
      },
    });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: source });

    expect(result.status).toBe("translated");
    expect(modelInput).not.toContain('"ты иеня извини"');
    expect(modelInput).not.toContain("`exact_get()`");
    expect(modelInput).not.toContain("/tmp/operator/file.ts");
    expect(modelInput).not.toContain("registryValue");
    expect(modelMaxTokens).toBeGreaterThanOrEqual(2_048);
    expect(modelInput).toMatch(/__PI_TRANSLATOR_[A-F0-9]+_0__/);
    expect(displayTextForTranslation(source, result)).toContain('"ты иеня извини"');
    expect(displayTextForTranslation(source, result)).toContain("`exact_get()`");
    expect(displayTextForTranslation(source, result)).toContain("/tmp/operator/file.ts");
    expect(displayTextForTranslation(source, result)).toContain("registryValue");
  });

  it("skips messages under 80 characters without invoking the model", async () => {
    const runModel = vi.fn(async () => "unused");
    const service = createTranslatorService({ runModel });
    const source = "Short message.";

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: source });

    expect(result.status).toBe("unchanged");
    expect(displayTextForTranslation(source, result)).toBe(source);
    expect(runModel).not.toHaveBeenCalled();
  });

  it("caches by source hash plus translator version and re-correlates entry ids", async () => {
    const runModel = vi.fn(async () =>
      "The work transfer remains blocked because the registry read did not complete after 16 attempts.",
    );
    const service = createTranslatorService({ runModel });

    const first = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });
    const second = await service.translate({ entryId: "e2", sessionId: "s2", text: LONG_SOURCE });

    expect(first.status).toBe("translated");
    expect(second.status).toBe("translated");
    expect(second.entryId).toBe("e2");
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(TRANSLATOR_VERSION).toMatch(/^dashboard-plain-english-v\d+$/);
  });

  it("times out and falls back to the original", async () => {
    const service = createTranslatorService({
      timeoutMs: 10,
      runModel: () => new Promise<string>(() => {}),
    });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });

    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(displayTextForTranslation(LONG_SOURCE, result)).toBe(LONG_SOURCE);
  });

  it("empty-output canary: empty model output never becomes an empty rendering", async () => {
    const service = createTranslatorService({ runModel: async () => "   \n" });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });

    expect(result).toMatchObject({ status: "failed", reason: "empty-output" });
    expect(displayTextForTranslation(LONG_SOURCE, result)).toBe(LONG_SOURCE);
    expect(displayTextForTranslation(LONG_SOURCE, result)).not.toBe("");
  });

  it("rejects a length-finished partial candidate and shows the original", async () => {
    const service = createTranslatorService({
      runModel: (async () => ({
        text: "The work transfer remains blocked because the registry read did not complete",
        finishReason: "length",
      })) as any,
    });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });

    expect(result).toMatchObject({ status: "failed", reason: "incomplete-output" });
    expect(displayTextForTranslation(LONG_SOURCE, result)).toBe(LONG_SOURCE);
  });

  it("accepts a complete provider result and renders its translation", async () => {
    const translated =
      "The work transfer remains blocked because the registry read did not complete after 16 attempts.";
    const service = createTranslatorService({
      runModel: (async () => ({ text: translated, finishReason: "stop" })) as any,
    });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });

    expect(result).toMatchObject({ status: "translated", text: translated });
    expect(displayTextForTranslation(LONG_SOURCE, result)).toBe(translated);
  });

  it("refuses to translate its own output and does not call the model twice", async () => {
    const translated =
      "The work transfer remains blocked because the registry read did not complete after 16 attempts.";
    const runModel = vi.fn(async () => translated);
    const service = createTranslatorService({ runModel });

    const first = await service.translate({ entryId: "e1", sessionId: "s1", text: LONG_SOURCE });
    const second = await service.translate({ entryId: "e2", sessionId: "s1", text: translated });

    expect(first.status).toBe("translated");
    expect(second).toMatchObject({ status: "failed", reason: "recursive-input" });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it("vetoes output that retains known ledger or section references", async () => {
    const source = `${LONG_SOURCE} See dl-15176 and §10 for internal evidence.`;
    const service = createTranslatorService({ runModel: async () => source });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: source });

    expect(result).toMatchObject({ status: "failed", reason: "known-pattern" });
    expect(displayTextForTranslation(source, result)).toBe(source);
  });

  it("extracts only finalized assistant prose without mutating the event", () => {
    const event = {
      eventType: "message_end",
      timestamp: 1,
      data: {
        entryId: "entry-a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: LONG_SOURCE }],
        },
      },
    } as any;
    const before = JSON.stringify(event);

    expect(extractTranslationRequest("session-1", event)).toEqual({
      entryId: "entry-a1",
      sessionId: "session-1",
      text: LONG_SOURCE,
    });
    expect(JSON.stringify(event)).toBe(before);
    expect(extractTranslationRequest("session-1", { ...event, eventType: "prompt_request" })).toBeNull();
  });
});

describe("translator safety oracles", () => {
  it("counts the held-out floor classes exactly", () => {
    const source = "dl-1 dl-2 dl-3 dl-4 dl-5 dl-6 dl-7 and §10, §11, §23";
    expect(countKnownBadPatterns(source)).toEqual({ ledgerIds: 7, sectionReferences: 3, tenureIds: 0 });
  });

  it("preserves blocker force, negations, exact numbers, quotes, and adds no reassurance", () => {
    const source =
      'Work is blocked and cannot proceed. The read did not complete: 14,690 rows on 2026-08-16. Evidence: "tyop stays".';
    const output =
      'Work is blocked and cannot proceed. The read did not complete: 14,690 rows on 2026-08-16. Evidence: "tyop stays".';
    expect(translationSafetyIssues(source, output)).toEqual([]);
  });

  it("allows the blocker subject to be clarified while preserving 'not settled' exactly", () => {
    const issues = translationSafetyIssues(
      "Track A architecture is not settled.",
      "The architecture choice is not settled.",
    );
    expect(issues).not.toContain("negation-attachment-changed");
    expect(issues).not.toContain("blocker-softened");
  });

  it("rejects changing the domain action from durable recording to agreement", () => {
    const checks = checkChangedSpanActions(
      "Only the architects can fix this by banking their reversals.",
      "Only the architects can fix this by agreeing on their reversals.",
    );
    const issues = translationSafetyIssues(
      "Only the architects can fix this by banking their reversals.",
      "Only the architects can fix this by agreeing on their reversals.",
    );
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceActions: ["record-durably"],
        outputActions: ["reach-agreement"],
        sameAction: false,
      }),
    ]));
    expect(issues).toContain("action-changed");
  });

  it.each([
    "Only the architects can fix this by recording their reversals.",
    "Only the architects can fix this by preserving their reversals.",
  ])("accepts the same durable-recording action: %s", (output) => {
    const checks = checkChangedSpanActions(
      "Only the architects can fix this by banking their reversals.",
      output,
    );
    const issues = translationSafetyIssues(
      "Only the architects can fix this by banking their reversals.",
      output,
    );
    expect(checks.every((check) => check.sameAction)).toBe(true);
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceActions: ["record-durably"],
        outputActions: ["record-durably"],
        sameAction: true,
      }),
    ]));
    expect(issues).not.toContain("action-changed");
  });

  it("masking leaves known jargon references visible to the translator", () => {
    const masked = maskProtectedSpans("See dl-15176, **dl-15183**, §10, and door-3 beside `exact_get()`.");
    expect(masked.text).toContain("dl-15176");
    expect(masked.text).toContain("dl-15183");
    expect(masked.text).toContain("§10");
    expect(masked.text).toContain("door-3");
    expect(masked.text).not.toContain("`exact_get()`");
  });
});

describe("translator model tier", () => {
  it("chooses a small model and rejects large-only choices", () => {
    const models = [
      { provider: "openai", id: "o3", reasoning: true },
      { provider: "anthropic", id: "claude-opus-4-1", reasoning: true },
      { provider: "google", id: "gemini-2.5-flash", reasoning: false },
      { provider: "google", id: "gemini-2.5-flash-lite", reasoning: false },
    ];
    expect(selectTranslatorModel(models)).toMatchObject({ id: "gemini-2.5-flash-lite" });
    expect(selectTranslatorModel([
      ...models.slice(0, 2),
      { provider: "github-copilot", id: "claude-haiku-4.5", reasoning: true },
    ])).toMatchObject({ id: "claude-haiku-4.5" });
    expect(selectTranslatorModel([
      { provider: "github-copilot", id: "claude-haiku-4.5", reasoning: true },
      { provider: "github-copilot", id: "gemini-3.5-flash", reasoning: true },
    ])).toMatchObject({ id: "gemini-3.5-flash" });
    expect(selectTranslatorModel([
      { provider: "github-copilot", id: "gemini-3.5-flash", reasoning: true },
      { provider: "github-copilot", id: "gpt-5.4-mini", reasoning: true },
    ])).toMatchObject({ id: "gpt-5.4-mini" });
    expect(selectTranslatorModel([
      { provider: "github-copilot", id: "gpt-5.4-mini", reasoning: true },
      { provider: "github-copilot", id: "gpt-5-mini", reasoning: true },
    ])).toMatchObject({ id: "gpt-5.4-mini" });
    expect(selectTranslatorModel(models.slice(0, 2))).toBeNull();
  });

  it("uses Copilot's advertised gpt-4o-mini transport when the static catalogue only carries gpt-4.1", () => {
    const base = {
      provider: "github-copilot",
      id: "gpt-4.1",
      name: "GPT-4.1",
      api: "openai-completions",
      reasoning: false,
      maxTokens: 16_384,
    };
    expect(selectTranslatorModel([base])).toMatchObject({
      provider: "github-copilot",
      id: "gpt-4o-mini",
      name: "GPT-4o mini",
      api: "openai-completions",
      reasoning: false,
    });
    expect(base.id).toBe("gpt-4.1");
  });
});
