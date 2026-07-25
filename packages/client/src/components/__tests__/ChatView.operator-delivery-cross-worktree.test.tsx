// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, reduceEvent } from "../../lib/event-reducer.js";
import { createMemoryEventStore } from "../../../../server/src/memory-event-store.js";
import { replayEntriesAsEvents } from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";
import type { ToolContext } from "../tool-renderers/index.js";

const SOURCE =
  "CODENAME-47 orchestration reports dl-11743 and §2A. Door-3: The final review failed. Trace 123e4567-e89b-12d3-a456-426614174000, commit 96d7a16b73708799b0c7867fac4a12328341eeb8. Decision: do not deploy. 3 tests passed; keep /tmp/report.json, --dry-run, and https://example.test/report.";
const PLAIN =
  "The final review failed. Do not deploy. 3 tests passed; keep /tmp/report.json, --dry-run, and https://example.test/report.";
const toolContext: ToolContext = { editors: [] };
const producerWorktree = process.env.OPERATOR_VOICE_WORKTREE;
const execFileAsync = promisify(execFile);

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveProducerModule(): string {
  if (!producerWorktree) {
    throw new Error("OPERATOR_VOICE_WORKTREE must be set by the client Vitest config");
  }
  const sourceModule = path.join(
    producerWorktree,
    "pi-extensions/pi-operator-voice/src/operator-delivery.ts",
  );
  const fixtureModule = path.join(
    producerWorktree,
    "pi-extensions/pi-operator-voice/src/operator-delivery.mjs",
  );
  const modulePath = existsSync(sourceModule)
    ? sourceModule
    : existsSync(fixtureModule)
    ? fixtureModule
    : undefined;
  if (!modulePath) {
    throw new Error(`Operator-voice producer module is missing under ${producerWorktree}`);
  }
  return modulePath;
}

function verifyFixtureIntegrity(modulePath: string): void {
  if (!modulePath.endsWith(".mjs")) return;
  const manifestPath = path.join(producerWorktree!, "fixture-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Operator-voice fixture manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bundleSha256?: string;
    lexiconSha256?: string;
  };
  const lexiconPath = path.join(
    producerWorktree!,
    "pi-extensions/pi-operator-voice/operator-lexicon.json",
  );
  expect(sha256File(modulePath)).toBe(manifest.bundleSha256);
  expect(sha256File(lexiconPath)).toBe(manifest.lexiconSha256);
}

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(cleanup);

describe("real producer to dashboard DOM proof", () => {
  it("renders the real producer envelope after dashboard storage without source jargon", async () => {
    const modulePath = resolveProducerModule();
    verifyFixtureIntegrity(modulePath);
    const tsxLoader = createRequire(path.join(process.cwd(), "package.json")).resolve("tsx");
    const materializeScript = [
      "import { pathToFileURL } from 'node:url';",
      "const [modulePath, source, plain] = process.argv.slice(1);",
      "const producer = await import(pathToFileURL(modulePath).href);",
      "const delivery = await producer.materializeOperatorDelivery(source, { rewrite: async () => plain, verifySemantics: async () => true });",
      "process.stdout.write(JSON.stringify(delivery));",
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      tsxLoader,
      "--input-type=module",
      "-e",
      materializeScript,
      modulePath,
      SOURCE,
      PLAIN,
    ], { timeout: 10_000 });
    const operatorDelivery = JSON.parse(stdout) as unknown;
    expect(operatorDelivery).toMatchObject({
      status: "ready",
      text: PLAIN,
      checks: { plain: true, anchorsPreserved: true },
    });

    const persistedEntry = {
      id: "entry-1",
      type: "message",
      timestamp: new Date(3).toISOString(),
      message: {
          role: "assistant",
          audience: "operator",
          content: [{ type: "text", text: SOURCE }],
          operatorDelivery,
      },
    };
    const replayFrames = replayEntriesAsEvents("cross-worktree", [persistedEntry]);
    const store = createMemoryEventStore(() => false);
    for (const frame of replayFrames) store.insertEvent("cross-worktree", frame.event);
    const replayed = store.getEvents("cross-worktree", 1);
    expect(replayed.some(({ event }) =>
      (event.data.message as any)?.operatorDelivery?.status === "ready",
    )).toBe(true);

    const state = replayed.reduce(
      (current, stored) => reduceEvent(current, stored.event),
      createInitialState(),
    );
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    expect(container.textContent).toContain("The final review failed.");
    expect(container.textContent).toContain("Do not deploy.");
    expect(container.textContent).toContain("3 tests passed");
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("§2A");
    expect(container.textContent).not.toContain("CODENAME-47");
    expect(container.textContent).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(container.textContent).not.toContain("96d7a16b73708799b0c7867fac4a12328341eeb8");
  });
});
