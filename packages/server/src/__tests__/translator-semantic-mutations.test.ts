import { describe, expect, it } from "vitest";
import { countKnownBadPatterns, createTranslatorService, displayTextForTranslation, translationSafetyIssues } from "../translator-service.js";

const mutant = process.env.TRANSLATOR_MUTANT;

function chosen(name: string, good: string, broken: string): string {
  return mutant === name ? broken : good;
}

describe("translator semantic acceptance and must-fail mutants", () => {
  it("BLOCKERS preserves stuck/blocked force", () => {
    const source = "Track A architecture is not settled. Work cannot proceed until two architects agree.";
    const output = chosen(
      "soften-blocker",
      "Track A architecture is not settled. Work cannot proceed until two architects agree.",
      "Architecture work is progressing well, with a couple of options still being weighed.",
    );
    expect(translationSafetyIssues(source, output)).not.toContain("blocker-softened");
  });

  it("NEGATIONS preserves every negation marker", () => {
    const source = "The registry read did not complete and the seat was not eligible, so it cannot proceed.";
    const output = chosen(
      "drop-negation",
      "The registry read did not complete and the seat was not eligible, so it cannot proceed.",
      "The registry read completed and the seat was not eligible, so it cannot proceed.",
    );
    expect(translationSafetyIssues(source, output)).not.toContain("negation-changed");
  });

  it("NUMBERS preserves counts, versions, sizes, and dates exactly", () => {
    const source = "14,690 rows; 4,381 checked; v2.7.1; 16 MB; 2026-08-16.";
    const output = chosen(
      "round-numbers",
      "14,690 rows; 4,381 checked; v2.7.1; 16 MB; 2026-08-16.",
      "Roughly 15,000 rows; a few thousand checked; v2.7; 20 MB; mid-August.",
    );
    expect(translationSafetyIssues(source, output)).not.toContain("numbers-changed");
  });

  it("QUOTED EVIDENCE preserves operator text byte-identically, typo intact", () => {
    const quote = "ты иеня извини но теперь ты утонула сама в жаргоне и прочем";
    const source = `Operator evidence says "${quote}" and must remain exact.`;
    const output = chosen(
      "tidy-quotes",
      source,
      `Operator evidence says "${quote.replace("иеня", "меня")}" and must remain exact.`,
    );
    expect(translationSafetyIssues(source, output)).not.toContain("quoted-evidence-changed");
  });

  it("NO ADDED REASSURANCE adds no conclusion and catches moved negations", () => {
    const source = "Joan's measurement is 0 of 249. The registry did not complete; the seat was not eligible.";
    const good = "Joan's measurement is 0 of 249. The registry did not complete; the seat was not eligible.";
    const output = mutant === "invert-negation"
      ? "Joan's measurement is 0 of 249. The registry was not eligible; the seat did not complete."
      : chosen(
          "add-conclusion",
          good,
          "Joan's measurement is 0 of 249, so coverage is working as intended. The registry did not complete; the seat was not eligible.",
        );
    const issues = translationSafetyIssues(source, output);
    expect(issues).not.toContain("added-reassurance");
    expect(issues).not.toContain("negation-attachment-changed");
  });

  it("DOMAIN ACTION keeps durable recording distinct from agreement", () => {
    const source = "Only the architects can fix this by banking their reversals.";
    const output = chosen(
      "change-domain-action",
      "Only the architects can fix this by recording their reversals.",
      "Only the architects can fix this by agreeing on their reversals.",
    );
    expect(translationSafetyIssues(source, output)).not.toContain("action-changed");
  });

  it("MECHANICAL FLOOR removes every known ledger and section reference", () => {
    const source = "dl-15176 dl-15177 dl-15181 dl-15181 dl-15183 dl-15183 dl-15183; §10 §11 §23.";
    const output = chosen("passthrough", "Seven ledger references and three internal section references were removed.", source);
    expect(countKnownBadPatterns(output)).toEqual({ ledgerIds: 0, sectionReferences: 0, tenureIds: 0 });
  });

  it("TRUNCATED OUTPUT retains finish reason and falls back original", async () => {
    const source = "The internal handoff remains blocked because the registry read did not complete after 16 attempts.";
    const partial = "The work transfer remains blocked because the registry read did not complete after 16 attempts.";
    const service = createTranslatorService({
      runModel: (async () => mutant === "drop-finish-reason"
        ? partial
        : { text: partial, finishReason: "length" }) as any,
    });

    const result = await service.translate({ entryId: "e1", sessionId: "s1", text: source });
    expect(result).toMatchObject({ status: "failed", reason: "incomplete-output" });
    expect(displayTextForTranslation(source, result)).toBe(source);
  });
});
