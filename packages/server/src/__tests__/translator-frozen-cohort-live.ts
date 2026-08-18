import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const EXPECTED_COHORT_SHA256 = "d86242af8c9dbf2690dc7d9d6b4d39e83cdeb2bf3b6d4b2ffd7c0450210189c0";
const EXPECTED_BASELINE_SHA256 = "876d2560fd3cd7ce57d144d59f0e5247df5632add57a217cd0af4f95d1eb5491";
const EXPECTED_RECONSTRUCTED_SHA256 = "3517c41712dd0a053b37a5116fd5444f4b9568a9a73109bc54f716e66c517cea";
const EXPECTED_SEATS = [
  "VoiceGuard-2", "VoiceGuard-2", "VoiceGuard-2", "VoiceGuard-2",
  "Repowright", "Repowright", "Repowright", "Repowright",
  "Statewright", "Statewright", "Statewright", "Statewright",
];

interface FrozenCohortRow {
  seat: string;
  sessionId: string;
  entryId: string;
  sourceHash: string;
  charCount: number;
}

interface FrozenBaselineRow extends FrozenCohortRow {
  sourceText: string;
}

interface FrozenReconstructedRow extends FrozenBaselineRow {
  reconstructedCandidate: string;
}

interface FrozenArtifact<Row> {
  selector: string;
  release: string;
  rows: Row[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
  const cohortPath = process.env.TRANSLATOR_FROZEN_COHORT;
  const baselinePath = process.env.TRANSLATOR_FROZEN_BASELINE;
  const reconstructedPath = process.env.TRANSLATOR_FROZEN_RECONSTRUCTED;
  assert(cohortPath, "TRANSLATOR_FROZEN_COHORT is required");
  assert(baselinePath, "TRANSLATOR_FROZEN_BASELINE is required");
  assert(reconstructedPath, "TRANSLATOR_FROZEN_RECONSTRUCTED is required");

  const cohortBytes = readFileSync(cohortPath);
  const baselineBytes = readFileSync(baselinePath);
  const reconstructedBytes = readFileSync(reconstructedPath);
  assert(sha256(cohortBytes) === EXPECTED_COHORT_SHA256, "frozen cohort hash mismatch");
  assert(sha256(baselineBytes) === EXPECTED_BASELINE_SHA256, "frozen baseline hash mismatch");
  assert(sha256(reconstructedBytes) === EXPECTED_RECONSTRUCTED_SHA256, "frozen reconstruction hash mismatch");

  const cohort = JSON.parse(cohortBytes.toString("utf8")) as FrozenArtifact<FrozenCohortRow>;
  const baseline = JSON.parse(baselineBytes.toString("utf8")) as FrozenArtifact<FrozenBaselineRow>;
  const reconstructed = JSON.parse(reconstructedBytes.toString("utf8")) as FrozenArtifact<FrozenReconstructedRow>;
  assert(cohort.selector === "driver-cohort-v1", "unexpected cohort selector");
  assert(cohort.rows.length === 12 && baseline.rows.length === 12, "frozen cohort must contain 12 rows");
  assert(
    cohort.rows.every((row, index) => row.sourceHash === baseline.rows[index]?.sourceHash),
    "cohort and private baseline row order differ",
  );
  assert(
    cohort.rows.every((row, index) => row.sourceHash === reconstructed.rows[index]?.sourceHash),
    "cohort and reconstructed candidate row order differ",
  );
  assert(
    cohort.rows.every((row, index) => row.seat === EXPECTED_SEATS[index]),
    "frozen cohort seat order differs",
  );
  for (const row of baseline.rows) {
    assert(sha256(row.sourceText) === row.sourceHash, `source hash mismatch: ${row.sourceHash.slice(0, 12)}`);
    assert(row.sourceText.length === row.charCount, `source length mismatch: ${row.sourceHash.slice(0, 12)}`);
  }

  const realHome = homedir();
  const isolatedHome = mkdtempSync(join(tmpdir(), "pi-translator-cohort-"));
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
    const wire: Array<{ url: string; requestBody: string | null; responseBody: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      let responseBody: string | null = null;
      try {
        responseBody = await response.clone().text();
      } catch {
        // Private evidence retains a null body when a response cannot be cloned.
      }
      wire.push({
        url: String(input instanceof Request ? input.url : input),
        requestBody: typeof init?.body === "string" ? init.body : null,
        responseBody,
      });
      return response;
    };
    const {
      createTranslatorService,
      TRANSLATOR_SECURITY_DETECTOR_KIND,
      TRANSLATOR_SECURITY_DETECTOR_VERSION,
      TRANSLATOR_VERSION,
      maskProtectedSpans,
    } = await import("../translator-service.js");
    const fixedRewriteIdentity = { provider: "github-copilot", model: "gpt-4o-mini" };
    const fixedJudgeIdentity = { provider: "github-copilot", model: "gemini-3.5-flash" };
    const fixedPass = { meaning: true, facts: true, decisions: true, severity: true, plainness: true };
    const runFixedPair = async (hashPrefix: string, verdict: typeof fixedPass) => {
      const row = reconstructed.rows.find((candidate) => candidate.sourceHash.startsWith(hashPrefix));
      assert(row, `missing reconstructed control ${hashPrefix}`);
      const protectedText = maskProtectedSpans(row.sourceText);
      let maskedCandidate = row.reconstructedCandidate;
      for (const { token, value } of protectedText.tokens) {
        assert(maskedCandidate.split(value).length - 1 === 1, `fixed control lost protected evidence: ${hashPrefix}`);
        maskedCandidate = maskedCandidate.replace(value, token);
      }
      const fixedService = createTranslatorService({
        minChars: 0,
        runModel: async () => ({
          text: maskedCandidate,
          finishReason: "stop",
          served: fixedRewriteIdentity,
        }),
        runJudge: async () => ({
          text: JSON.stringify(verdict),
          finishReason: "stop",
          served: fixedJudgeIdentity,
        }),
        onDiagnostic: () => {},
        onCircuitHealth: () => {},
      });
      return fixedService.translate({ entryId: `fixed-${hashPrefix}`, sessionId: "fixed-controls", text: row.sourceText });
    };
    const fixedAcceptResult = await runFixedPair("b10658ceb417", { ...fixedPass, meaning: false, facts: false });
    const fixedRejectResult = await runFixedPair("36723d6a9dfb", fixedPass);
    const controls = {
      mustAccept: fixedAcceptResult.status === "translated"
        && fixedAcceptResult.warnings?.includes("meaning-judge-rejected") === true,
      mustReject: fixedRejectResult.status === "failed"
        && fixedRejectResult.reason === "safety-check:negated-direct-capability-changed",
    };
    const fixedControlResults = {
      mustAccept: {
        status: fixedAcceptResult.status,
        reason: fixedAcceptResult.status === "failed" ? fixedAcceptResult.reason : null,
        warnings: fixedAcceptResult.status === "translated" ? fixedAcceptResult.warnings ?? [] : [],
      },
      mustReject: {
        status: fixedRejectResult.status,
        reason: fixedRejectResult.status === "failed" ? fixedRejectResult.reason : null,
        warnings: fixedRejectResult.status === "translated" ? fixedRejectResult.warnings ?? [] : [],
      },
    };
    const service = createTranslatorService({ onDiagnostic: () => {}, onCircuitHealth: () => {} });
    const rows: Array<Record<string, unknown>> = [];
    const hashPrefix = process.env.TRANSLATOR_FROZEN_HASH_PREFIX;
    const skipLive = process.env.TRANSLATOR_SKIP_LIVE === "1";
    const selectedRows = skipLive
      ? []
      : hashPrefix
        ? baseline.rows.filter((row) => row.sourceHash.startsWith(hashPrefix))
        : baseline.rows;
    if (!skipLive) assert(selectedRows.length > 0, `no frozen row matches ${hashPrefix}`);

    for (const row of selectedRows) {
      const started = performance.now();
      const wireStart = wire.length;
      const result = await service.translate({
        entryId: `frozen-${row.sourceHash.slice(0, 12)}`,
        sessionId: `frozen-${row.seat}`,
        text: row.sourceText,
      });
      const candidateText = result.status === "translated" ? result.text : null;
      const summary = {
        seat: row.seat,
        sourceHash: row.sourceHash,
        charCount: row.charCount,
        status: result.status,
        reason: result.status === "failed" ? result.reason : null,
        warnings: result.status === "translated" ? result.warnings ?? [] : [],
        stage1Identity: result.servedModels.stage1,
        stage2Identity: result.servedModels.stage2,
        latencyMs: Math.round(performance.now() - started),
        sourceText: row.sourceText,
        candidateText,
        wireCalls: wire.slice(wireStart).filter((call) => call.url.includes("/chat/completions")),
      };
      rows.push(summary);
      console.log(JSON.stringify({
        seat: summary.seat,
        sourceHash: row.sourceHash.slice(0, 12),
        status: summary.status,
        reason: summary.reason,
        warnings: summary.warnings,
        stage1Identity: summary.stage1Identity,
        stage2Identity: summary.stage2Identity,
        latencyMs: summary.latencyMs,
      }));
    }

    const perSeat = EXPECTED_SEATS.filter((seat, index) => EXPECTED_SEATS.indexOf(seat) === index).map((seat) => {
      const seatRows = rows.filter((row) => row.seat === seat);
      return {
        seat,
        translated: seatRows.filter((row) => row.status === "translated").length,
        unchanged: seatRows.filter((row) => row.status === "unchanged").length,
        failed: seatRows.filter((row) => row.status === "failed").length,
        reachedStage2: seatRows.filter((row) => row.stage2Identity !== null).length,
      };
    });
    const liveSourceOutcomes = {
      mustAccept: rows.find((row) => String(row.sourceHash).startsWith("b10658ceb417"))?.status ?? null,
      mustReject: rows.find((row) => String(row.sourceHash).startsWith("36723d6a9dfb"))?.status ?? null,
    };
    const output = {
      cohortSha256: EXPECTED_COHORT_SHA256,
      baselineSha256: EXPECTED_BASELINE_SHA256,
      frozenRelease: cohort.release,
      translatorVersion: TRANSLATOR_VERSION,
      detectorKind: TRANSLATOR_SECURITY_DETECTOR_KIND,
      detectorVersion: TRANSLATOR_SECURITY_DETECTOR_VERSION,
      perSeat,
      controls,
      fixedControlResults,
      liveSourceOutcomes,
      rows,
    };
    const outputPath = process.env.TRANSLATOR_FROZEN_OUTPUT ?? join(tmpdir(), "pi-translator-frozen-cohort.json");
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ perSeat, controls, fixedControlResults, liveSourceOutcomes, outputPath, outputSha256: sha256(readFileSync(outputPath)) }));

    assert(controls.mustAccept, "b10658ceb417 fixed necessary must-accept pair failed");
    assert(controls.mustReject, "36723d6a9dfb fixed strongly corroborated necessary must-reject pair rendered");
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
