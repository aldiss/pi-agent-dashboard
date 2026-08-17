import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function findPiAiEntry(realHome: string): string {
  const candidates = [
    join(realHome, ".pi-dashboard", "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    join(realHome, ".pi-dashboard", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"),
    join(realHome, ".pi-dashboard", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    join(realHome, ".pi-dashboard", "node_modules", "@mariozechner", "pi-coding-agent", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("pi-ai entry not found in managed installation");
  return found;
}

async function main(): Promise<void> {
  const heldoutDir = process.env.HELDOUT_ACCEPTANCE_DIR;
  assert(heldoutDir, "HELDOUT_ACCEPTANCE_DIR is required");

  const realHome = homedir();
  const isolatedHome = mkdtempSync(join(tmpdir(), "pi-translator-live-"));
  try {
    const realAuth = join(realHome, ".pi", "agent", "auth.json");
    assert(existsSync(realAuth), `missing auth file: ${realAuth}`);
    const isolatedAuth = join(isolatedHome, ".pi", "agent", "auth.json");
    mkdirSync(dirname(isolatedAuth), { recursive: true });
    copyFileSync(realAuth, isolatedAuth);

    const overridePath = join(isolatedHome, ".pi", "dashboard", "tool-overrides.json");
    mkdirSync(dirname(overridePath), { recursive: true });
    writeFileSync(overridePath, JSON.stringify({
      version: 1,
      overrides: { "pi-ai": { path: findPiAiEntry(realHome) } },
    }, null, 2) + "\n", { mode: 0o600 });

    process.env.HOME = isolatedHome;
    const [{ createTranslatorService, countKnownBadPatterns, maskProtectedSpans, selectTranslatorModel }, { getModelRegistry }] = await Promise.all([
      import("../translator-service.js"),
      import("../model-proxy/registry-singleton.js"),
    ]);

    const source = readFileSync(join(heldoutDir, "pre-correction-reply.txt"), "utf8");
    const originalCounts = countKnownBadPatterns(source);
    assert(originalCounts.ledgerIds === 7, `expected 7 ledger ids, got ${originalCounts.ledgerIds}`);
    assert(originalCounts.sectionReferences === 3, `expected 3 section references, got ${originalCounts.sectionReferences}`);

    const registry = await getModelRegistry();
    const availableModels = await registry.getAvailable();
    const model = selectTranslatorModel(availableModels);
    assert(model, "no small model available");

    const started = performance.now();
    const result = await createTranslatorService().translate({
      entryId: "heldout-a1",
      sessionId: "heldout-s1",
      text: source,
    });
    const latencyMs = Math.round(performance.now() - started);
    const output = result.status === "translated" ? result.text : source;
    const outputCounts = countKnownBadPatterns(output);
    const unprotectedOutput = maskProtectedSpans(output).text.toLowerCase();
    const knownCoinedTerms = [
      "door-3",
      "turn-origin",
      "exact-get",
      "lint-eligibility",
      "ledger-first",
      "exact-verified",
      "tool-turns",
      "out-of-band",
    ];
    const remainingCoinedTerms = knownCoinedTerms.filter((term) => unprotectedOutput.includes(term));
    console.log(JSON.stringify({
      model: `${model.provider}/${model.id}`,
      reasoning: model.reasoning === true ? "minimal" : "off",
      latencyMs,
      status: result.status,
      reason: result.status === "failed" ? result.reason : undefined,
      originalCounts,
      outputCounts,
      remainingCoinedTerms,
    }));
    if (result.status === "translated") console.log("--- translation ---\n" + result.text);

    assert(result.status === "translated", `held-out translation did not complete: ${result.status === "failed" ? result.reason : result.status}`);
    assert(outputCounts.ledgerIds === 0, `translation retained ${outputCounts.ledgerIds} ledger ids`);
    assert(outputCounts.sectionReferences === 0, `translation retained ${outputCounts.sectionReferences} section references`);
    assert(remainingCoinedTerms.length === 0, `translation retained coined terms: ${remainingCoinedTerms.join(", ")}`);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
