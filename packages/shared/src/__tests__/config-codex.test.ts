import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";

describe("Codex runtime config", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-config-"));
    fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
    file = path.join(home, ".pi", "dashboard", "config.json");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaults Codex off without inventing model or backend choices", () => {
    expect(loadConfig().runtimes?.codex).toEqual({ enabled: false });
  });

  it("preserves explicit model/backend/env-name settings", () => {
    const codex = { enabled: true, model: "fixture", modelProvider: "local", baseUrl: "http://localhost:4567/v1", envKey: "FIXTURE_KEY", modelCatalogJson: "/fixture/catalog.json", reasoningEffort: "custom-effort", wireApi: "responses" };
    fs.writeFileSync(file, JSON.stringify({ runtimes: { codex } }));
    expect(loadConfig({ startup: true }).runtimes?.codex).toEqual(codex);
  });

  it.each([
    { enabled: "true" }, { enabled: true, envKey: "BAD KEY" }, { enabled: true, baseUrl: "file:///tmp/backend" },
    { enabled: true, wireApi: "chat" }, { enabled: true, model: 123 },
  ])("refuses malformed config %j at startup and disables runtime on background reads", codex => {
    fs.writeFileSync(file, JSON.stringify({ runtimes: { codex } }));
    expect(() => loadConfig({ startup: true })).toThrow(/runtimes.codex/);
    expect(loadConfig().runtimes?.codex.enabled).toBe(false);
  });
});
