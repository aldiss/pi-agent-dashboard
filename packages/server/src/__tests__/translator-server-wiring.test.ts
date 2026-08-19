import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  createTranslatorService,
  type ModelRunRequest,
  type ModelRunResult,
} from "../translator-service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(HERE, "../server.ts");
const SOURCE = "The exact-fetch packet-transfer remains blocked because Lane refused deployment, and no approvals exist.";
const REVOICE = "Lane rejected the launch. Nobody approved it, so the work remains blocked.";
const REWRITE_IDENTITY = { provider: "github-copilot", model: "gpt-5.4-mini-2026-03-17" };
const JUDGE_IDENTITY = { provider: "github-copilot", model: "gemini-3.5-flash" };
const JUDGE_PASS = { meaning: true, facts: true, decisions: true, severity: true, plainness: true };

interface ProductionTranslatorFlags {
  enableDepthRungSelection: boolean;
  enableRevoiceClaimGate: boolean;
}

function readBooleanProperty(literal: ts.ObjectLiteralExpression, name: string): boolean | undefined {
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== name) continue;
    if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
  }
  return undefined;
}

function productionTranslatorFlags(): ProductionTranslatorFlags {
  const source = ts.createSourceFile(
    SERVER_PATH,
    readFileSync(SERVER_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const optionLiterals: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "createTranslatorService") {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) optionLiterals.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const options = optionLiterals[0];
  if (optionLiterals.length !== 1 || !options) {
    throw new Error(`expected one production createTranslatorService object literal, found ${optionLiterals.length}`);
  }
  return {
    enableDepthRungSelection: readBooleanProperty(options, "enableDepthRungSelection") ?? false,
    enableRevoiceClaimGate: readBooleanProperty(options, "enableRevoiceClaimGate") ?? false,
  };
}

function completed(text: string, served: ModelRunResult["served"]): ModelRunResult {
  return { text, finishReason: "stop", ...(served ? { served } : {}) };
}

describe("production translator server wiring", () => {
  it("enables both depth selection and the revoice claim gate at the actual server call site", async () => {
    const flags = productionTranslatorFlags();
    const claimStages: ModelRunRequest["stage"][] = [];
    const runEntailment = vi.fn(async (request: ModelRunRequest): Promise<ModelRunResult> => {
      claimStages.push(request.stage);
      throw new Error("claim-gate-reached");
    });
    const service = createTranslatorService({
      ...flags,
      minChars: 0,
      runModel: async (request) => completed(
        request.rung === "revoice" ? REVOICE : request.text,
        REWRITE_IDENTITY,
      ),
      runEntailment,
      runJudge: async () => completed(JSON.stringify(JUDGE_PASS), JUDGE_IDENTITY),
      persistEvidence: () => {},
      onDiagnostic: () => {},
    });

    await service.translate({ entryId: "server-wiring", sessionId: "s", text: SOURCE });

    expect({
      ...flags,
      claimExtractReached: claimStages.includes("claim-extract"),
    }).toEqual({
      enableDepthRungSelection: true,
      enableRevoiceClaimGate: true,
      claimExtractReached: true,
    });
  });
});
