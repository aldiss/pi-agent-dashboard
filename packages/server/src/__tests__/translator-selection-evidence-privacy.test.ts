import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranslationSelectionEvidence,
  type TranslationSelectionEvidence,
} from "../translator-selection.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const SOURCE_TOKEN = "PRIVATE_SOURCE_TOKEN_7fc0d2";
const CANDIDATE_TOKEN = "PRIVATE_CANDIDATE_TOKEN_39ab81";
const SYSTEM_TOKEN = "PRIVATE_SYSTEM_TOKEN_bcf219";
const RAW_MODEL_TOKEN = "PRIVATE_RAW_MODEL_TOKEN_5a771e";
const WARNING_TOKEN = "PRIVATE_WARNING_TOKEN_a84f20";
const PRIVATE_TOKENS = [SOURCE_TOKEN, CANDIDATE_TOKEN, SYSTEM_TOKEN, RAW_MODEL_TOKEN, WARNING_TOKEN] as const;
const REWRITE_IDENTITY = { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" };
const CLAIM_IDENTITY = { provider: "github-copilot", model: "gemini-3.5-flash" };

function transportEvidence() {
  return {
    wireReasoningEffort: "minimal",
    rawUsage: { promptTokens: 211, completionTokens: 23, reasoningTokens: null, totalTokens: 234 },
    hiddenResidualTokens: 0,
    guardDisposition: "passed",
    stage: "claim-extract",
    servedIdentity: CLAIM_IDENTITY,
    finishReason: SYSTEM_TOKEN,
  };
}

function scoreEvidence() {
  return {
    depth: 0.75,
    coverage: 0.9,
    sourceDepth: {
      jargonPerHundredWords: 20,
      meanWordsPerSentence: 14,
      residual: [SOURCE_TOKEN],
      wordCount: 20,
      sentenceCount: 2,
    },
    candidateDepth: {
      jargonPerHundredWords: 5,
      meanWordsPerSentence: 9,
      residual: [CANDIDATE_TOKEN],
      wordCount: 18,
      sentenceCount: 2,
    },
    detectedIssues: ["negation-changed"],
    hardIssues: [],
  };
}

function fixtureEvidence(
  sourceHash = "a".repeat(64),
  transportCount = 1,
): TranslationSelectionEvidence {
  const transports = Array.from({ length: transportCount }, transportEvidence);
  return {
    schemaVersion: "translator-selection-evidence-v1",
    recordedAt: "2026-08-19T00:00:00.000Z",
    sourceHash,
    sourceText: `source ${SOURCE_TOKEN}`,
    translatorVersion: "dashboard-plain-english-v3",
    scoringVersion: "depth-coverage-conservative-hard-issues-v2",
    selectionVersion: "claim-reviewed-revoice-warning-selection-v1",
    minCoverage: 0.85,
    depthPreferenceThreshold: 0,
    detectorKind: "deterministic",
    detectorVersion: "evaluator-instruction-v1",
    contracts: [{
      rung: "revoice",
      version: "depth-rung-revoice-v2",
      systemPrompt: `system ${SYSTEM_TOKEN}`,
      selectable: false,
    }],
    candidates: [{
      rung: "revoice",
      promptVersion: "depth-rung-revoice-v2",
      systemPrompt: `system ${SYSTEM_TOKEN}`,
      selectable: false,
      rawText: `raw ${RAW_MODEL_TOKEN}`,
      text: `candidate ${CANDIDATE_TOKEN}`,
      finishReason: RAW_MODEL_TOKEN,
      servedIdentity: REWRITE_IDENTITY,
      error: null,
      securityDetection: {
        kind: "deterministic",
        version: "evaluator-instruction-v1",
        hardFail: false,
        codes: [],
      },
      score: scoreEvidence(),
    }],
    claimEntailment: {
      status: "passed",
      revoiceEligible: true,
      reason: null,
      issues: [],
      claimQaVersion: "claim-question-answer-v1",
      claimCount: 2,
      extractionPromptVersion: "claim-extraction-v3-terse-category-batches-4",
      evaluationPromptVersion: "claim-candidate-evaluation-v2-single-answer",
      extractionIdentity: CLAIM_IDENTITY,
      evaluationIdentity: CLAIM_IDENTITY,
      extractionFinishReason: SOURCE_TOKEN,
      evaluationFinishReason: "stop",
      extractionIdentities: [CLAIM_IDENTITY],
      evaluationIdentities: [CLAIM_IDENTITY],
      extractionFinishReasons: [SOURCE_TOKEN],
      evaluationFinishReasons: ["stop"],
      extractionTransports: transports,
      evaluationTransports: [],
      claims: [
        { id: "c1", category: "decision", question: `question ${SOURCE_TOKEN}`, answer: `answer ${SOURCE_TOKEN}` },
        { id: "c2", category: "blocker", question: `question ${SOURCE_TOKEN}`, answer: `answer ${SOURCE_TOKEN}` },
      ],
      candidateEvaluation: {
        evaluatorInstructionDetected: false,
        answers: [
          { id: "c1", answer: `answer ${CANDIDATE_TOKEN}` },
          { id: "c2", answer: `answer ${CANDIDATE_TOKEN}` },
        ],
      },
    },
    decision: {
      kind: "selected",
      rung: "revoice",
      text: `decision ${CANDIDATE_TOKEN}`,
      reason: "deepest-faithful-survivor",
      score: scoreEvidence(),
      warningCodeCounts: {
        "meaning-judge-rejected": 1,
        [WARNING_TOKEN]: 99,
      },
      warnings: [WARNING_TOKEN],
    },
  };
}

function tokenCount(text: string, token: string): number {
  return text.split(token).length - 1;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

interface FileFingerprint {
  exists: boolean;
  sha256: string | null;
  bytes: number | null;
}

interface LocatedFileFingerprint extends FileFingerprint {
  path: string;
}

function fingerprint(path: string): FileFingerprint {
  if (!existsSync(path)) return { exists: false, sha256: null, bytes: null };
  const bytes = readFileSync(path);
  return { exists: true, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function locatedFingerprint(path: string): LocatedFileFingerprint {
  return { path, ...fingerprint(path) };
}

function timestampedPrivatePattern(kind: "active" | "archive"): RegExp {
  return new RegExp(
    `^translator-selection-evidence-\\d{8}T\\d{9}Z-${kind}-v1-RAW-PRIVATE(?:-\\d{3})?\\.jsonl$`,
    "u",
  );
}

function oversizedV2Bytes(fill: number): Buffer {
  const bytes = Buffer.alloc(MAX_LOG_BYTES + 4_096, fill);
  Buffer.from('{"schemaVersion":"translator-selection-evidence-v2",', "utf8").copy(bytes);
  bytes[bytes.length - 1] = 0x0a;
  return bytes;
}

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("production translation selection evidence privacy and retention", () => {
  it("validates the search instrument before proving planted private tokens are absent", async () => {
    await withTempDir("translator-evidence-private-", async (dir) => {
      const path = join(dir, "translator-selection-evidence.jsonl");
      const evidence = { ...fixtureEvidence(), sourceHash: SOURCE_TOKEN } satisfies TranslationSelectionEvidence;
      const positiveControl = JSON.stringify(evidence);
      const positiveCounts = Object.fromEntries(PRIVATE_TOKENS.map((token) => [token, tokenCount(positiveControl, token)]));
      expect(Object.values(positiveCounts).every((count) => count > 0)).toBe(true);

      await appendTranslationSelectionEvidence(path, evidence);

      const persisted = readFileSync(path, "utf8");
      const persistedCounts = Object.fromEntries(PRIVATE_TOKENS.map((token) => [token, tokenCount(persisted, token)]));
      console.info(`[translator-evidence-search-proof] ${JSON.stringify({ positiveCounts, persistedCounts })}`);
      expect(Object.values(persistedCounts)).toEqual(Array(PRIVATE_TOKENS.length).fill(0));
      expect(persisted).toContain('"schemaVersion":"translator-selection-evidence-v2"');
      expect(persisted).toContain('"sourceHash":null');
      for (const forbiddenKey of [
        "sourceText",
        "rawText",
        "text",
        "systemPrompt",
        "question",
        "answer",
        "answers",
        "rawTexts",
        "warnings",
      ]) {
        expect(persisted).not.toContain(`"${forbiddenKey}":`);
      }
      expect(persisted).toContain('"residualCount":1');
      expect(persisted).toContain('"finishReason":"unknown"');
      expect(persisted).toContain('"warningCodeCounts":{"meaning-judge-rejected":1}');
    });
  });

  it("atomically quarantines legacy v1 bytes without changing hash or byte count", async () => {
    await withTempDir("translator-evidence-quarantine-", async (dir) => {
      const evidenceDir = join(dir, "dashboard");
      const path = join(evidenceDir, "translator-selection-evidence.jsonl");
      const privateDir = join(evidenceDir, "_private-text");
      mkdirSync(privateDir, { recursive: true, mode: 0o755 });
      chmodSync(evidenceDir, 0o755);
      chmodSync(privateDir, 0o755);
      const legacyBytes = Buffer.from(`${JSON.stringify(fixtureEvidence())}\n`, "utf8");
      writeFileSync(path, legacyBytes, { mode: 0o644 });
      chmodSync(path, 0o644);
      const before = { sha256: sha256(legacyBytes), bytes: legacyBytes.byteLength };

      await appendTranslationSelectionEvidence(path, fixtureEvidence("b".repeat(64)));

      const privateFiles = readdirSync(privateDir);
      const quarantinedName = privateFiles.find((name) => timestampedPrivatePattern("active").test(name));
      expect(quarantinedName).toBeDefined();
      if (!quarantinedName) throw new Error("missing-timestamped-active-quarantine");
      const quarantinedPath = join(privateDir, quarantinedName);
      const quarantinedBytes = readFileSync(quarantinedPath);
      const after = { sha256: sha256(quarantinedBytes), bytes: quarantinedBytes.byteLength };
      const modes = {
        evidenceDirectory: mode(evidenceDir),
        privateDirectory: mode(privateDir),
        active: mode(path),
        quarantined: mode(quarantinedPath),
      };
      console.info(`[translator-evidence-quarantine-proof] ${JSON.stringify({ before, after, modes })}`);
      expect(after).toEqual(before);
      expect(quarantinedBytes.equals(legacyBytes)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain('"schemaVersion":"translator-selection-evidence-v2"');
      expect(mode(evidenceDir)).toBe(0o700);
      expect(mode(privateDir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
      expect(mode(quarantinedPath)).toBe(0o600);
    });
  });

  it("rejects pre-existing over-cap active and archive files without changing either", async () => {
    await withTempDir("translator-evidence-overcap-existing-", async (dir) => {
      const path = join(dir, "translator-selection-evidence.jsonl");
      const archivePath = `${path}.1`;
      writeFileSync(path, oversizedV2Bytes(0x41), { mode: 0o600 });
      writeFileSync(archivePath, oversizedV2Bytes(0x42), { mode: 0o600 });
      const before = { active: locatedFingerprint(path), archive: locatedFingerprint(archivePath) };
      let disposition = "completed";

      try {
        await appendTranslationSelectionEvidence(path, fixtureEvidence("d".repeat(64)));
      } catch (error) {
        disposition = error instanceof Error ? error.message : "unknown-error";
      }

      const after = { active: locatedFingerprint(path), archive: locatedFingerprint(archivePath) };
      console.info(`[translator-evidence-overcap-preservation-proof] ${JSON.stringify({ disposition, before, after })}`);
      expect(disposition).toBe("translation-selection-evidence-preexisting-over-cap");
      expect(after).toEqual(before);
    });
  });

  it("uses collision-safe UTC timestamped RAW-PRIVATE names for active and archive legacy files", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-19T12:34:56.789Z"));
    try {
      await withTempDir("translator-evidence-quarantine-collision-", async (dir) => {
        const path = join(dir, "translator-selection-evidence.jsonl");
        const archivePath = `${path}.1`;
        const privateDir = join(dir, "_private-text");
        mkdirSync(privateDir, { mode: 0o700 });
        const before: FileFingerprint[] = [];
        let disposition = "completed";

        for (let cycle = 0; cycle < 2; cycle += 1) {
          const activeLegacy = Buffer.from(
            `${JSON.stringify(fixtureEvidence((cycle + 4).toString().repeat(64)))}\n`,
            "utf8",
          );
          const archiveLegacy = Buffer.from(
            `${JSON.stringify(fixtureEvidence((cycle + 6).toString().repeat(64)))}\n`,
            "utf8",
          );
          writeFileSync(path, activeLegacy, { mode: 0o600 });
          writeFileSync(archivePath, archiveLegacy, { mode: 0o600 });
          before.push(fingerprint(path), fingerprint(archivePath));
          try {
            await appendTranslationSelectionEvidence(path, fixtureEvidence((cycle + 8).toString().repeat(64)));
          } catch (error) {
            disposition = error instanceof Error ? error.message : "unknown-error";
            break;
          }
        }

        const privateFiles = readdirSync(privateDir);
        const activeNames = privateFiles.filter((name) => timestampedPrivatePattern("active").test(name)).sort();
        const archiveNames = privateFiles.filter((name) => timestampedPrivatePattern("archive").test(name)).sort();
        const after = [...activeNames, ...archiveNames]
          .map((name) => fingerprint(join(privateDir, name)))
          .sort((left, right) => (left.sha256 ?? "").localeCompare(right.sha256 ?? ""));
        const sortedBefore = [...before]
          .sort((left, right) => (left.sha256 ?? "").localeCompare(right.sha256 ?? ""));
        console.info(`[translator-evidence-timestamped-quarantine-proof] ${JSON.stringify({
          disposition,
          activeNames,
          archiveNames,
          before: sortedBefore,
          after,
        })}`);
        expect(disposition).toBe("completed");
        expect(activeNames).toHaveLength(2);
        expect(archiveNames).toHaveLength(2);
        expect(new Set([...activeNames, ...archiveNames]).size).toBe(4);
        expect(after).toEqual(sortedBefore);
        expect(existsSync(archivePath)).toBe(false);
        expect(readFileSync(path, "utf8")).toContain('"schemaVersion":"translator-selection-evidence-v2"');
        expect(mode(privateDir)).toBe(0o700);
        for (const name of [...activeNames, ...archiveNames]) expect(mode(join(privateDir, name))).toBe(0o600);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the real 10 MiB cap across two rotations and retains exactly one archive", async () => {
    await withTempDir("translator-evidence-rotation-", async (dir) => {
      const path = join(dir, "translator-selection-evidence.jsonl");
      const archivePath = `${path}.1`;
      const firstHash = "1".repeat(64);
      const secondHash = "2".repeat(64);
      const thirdHash = "3".repeat(64);
      const transportCount = 20_000;

      await appendTranslationSelectionEvidence(path, fixtureEvidence(firstHash, transportCount));
      const firstSize = statSync(path).size;
      expect(firstSize).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(firstSize * 2).toBeGreaterThan(MAX_LOG_BYTES);

      await appendTranslationSelectionEvidence(path, fixtureEvidence(secondHash, transportCount));
      expect(existsSync(archivePath)).toBe(true);
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(statSync(archivePath).size).toBeLessThanOrEqual(MAX_LOG_BYTES);

      await appendTranslationSelectionEvidence(path, fixtureEvidence(thirdHash, transportCount));
      const active = readFileSync(path, "utf8");
      const archive = readFileSync(archivePath, "utf8");
      const archiveNames = readdirSync(dir).filter((name) => name.startsWith(`${basename(path)}.`));
      const privateTokenMatches = PRIVATE_TOKENS.reduce(
        (total, token) => total + tokenCount(active, token) + tokenCount(archive, token),
        0,
      );
      const proof = {
        capBytes: MAX_LOG_BYTES,
        activeBytes: statSync(path).size,
        archiveBytes: statSync(archivePath).size,
        archiveCount: archiveNames.length,
        activeHasThird: active.includes(thirdHash),
        archiveHasSecond: archive.includes(secondHash),
        archiveHasFirst: archive.includes(firstHash),
        privateTokenMatches,
        modes: {
          directory: mode(dir),
          active: mode(path),
          archive: mode(archivePath),
        },
      };
      console.info(`[translator-evidence-rotation-proof] ${JSON.stringify(proof)}`);
      expect(proof.activeBytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(proof.archiveBytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(archiveNames).toEqual([basename(archivePath)]);
      expect(proof.activeHasThird).toBe(true);
      expect(proof.archiveHasSecond).toBe(true);
      expect(proof.archiveHasFirst).toBe(false);
      expect(proof.privateTokenMatches).toBe(0);
      expect(mode(path)).toBe(0o600);
      expect(mode(archivePath)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    });
  }, 30_000);

  it("rejects an oversized sanitized record before it can violate the cap", async () => {
    await withTempDir("translator-evidence-oversized-", async (dir) => {
      const path = join(dir, "translator-selection-evidence.jsonl");
      const oversized = fixtureEvidence("f".repeat(64), 40_000);

      await expect(appendTranslationSelectionEvidence(path, oversized))
        .rejects.toThrow("translation-selection-evidence-record-too-large");
      expect(existsSync(path)).toBe(false);
    });
  });

  it("repairs permissive evidence directory mode and creates a private active file", async () => {
    await withTempDir("translator-evidence-modes-", async (dir) => {
      const evidenceDir = join(dir, "dashboard");
      const path = join(evidenceDir, "translator-selection-evidence.jsonl");
      mkdirSync(evidenceDir, { mode: 0o755 });
      chmodSync(evidenceDir, 0o755);

      await appendTranslationSelectionEvidence(path, fixtureEvidence());

      const proof = { directoryMode: mode(evidenceDir), activeMode: mode(path) };
      console.info(`[translator-evidence-mode-proof] ${JSON.stringify(proof)}`);
      expect(proof).toEqual({ directoryMode: 0o700, activeMode: 0o600 });
    });
  });

  it("serializes concurrent appenders through the stable evidence lock", async () => {
    await withTempDir("translator-evidence-concurrent-", async (dir) => {
      const path = join(dir, "translator-selection-evidence.jsonl");
      const hashes = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(64, "0"));

      await Promise.all(hashes.map((hash) => appendTranslationSelectionEvidence(path, fixtureEvidence(hash))));

      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(hashes.length);
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
      expect(mode(path)).toBe(0o600);
    });
  });
});
