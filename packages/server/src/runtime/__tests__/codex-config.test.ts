import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexConfig } from "../codex-config.js";

describe("managed Codex config", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses only dashboard-owned home and keeps inherited secrets out of config", () => {
    const parentEnv = { PATH: "/fixture/bin", CODEX_HOME: "/operator/home", CODEX_THREAD_ID: "parent-thread", OPENAI_API_KEY: "fixture-secret" };
    const prepared = prepareCodexConfig({ enabled: true }, parentEnv);
    expect(prepared.home).toBe(path.join(home, ".pi", "dashboard", "codex-home"));
    expect(prepared.env.CODEX_HOME).toBe(prepared.home);
    expect(prepared.env.OPENAI_API_KEY).toBe("fixture-secret");
    expect(prepared.env.CODEX_THREAD_ID).toBeUndefined();
    expect(parentEnv.CODEX_THREAD_ID).toBe("parent-thread");
    expect(parentEnv.CODEX_HOME).toBe("/operator/home");
    const config = fs.readFileSync(path.join(prepared.home, "config.toml"), "utf8");
    expect(config).toContain('base_url = "https://api.openai.com/v1"');
    expect(config).toContain('env_key = "OPENAI_API_KEY"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).not.toContain("fixture-secret");
    expect(config).not.toMatch(/^model =/m);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("writes configured model/provider without modifying thread state", () => {
    const prepared = prepareCodexConfig({ enabled: true, model: "fixture-model", modelProvider: "fixture-provider", baseUrl: "http://127.0.0.1:4567/v1", envKey: "FIXTURE_API_KEY", reasoningEffort: "high", modelCatalogJson: "/fixture/catalog.json" }, { FIXTURE_API_KEY: "private-value" });
    const written = fs.readFileSync(path.join(prepared.home, "config.toml"), "utf8");
    expect(written).toContain('model = "fixture-model"');
    expect(written).toContain('[model_providers."fixture-provider"]');
    expect(written).toContain('model_reasoning_effort = "high"');
    expect(written).not.toContain("private-value");
    fs.writeFileSync(path.join(prepared.home, "thread-state"), "preserved");
    prepareCodexConfig({ enabled: true, model: "next-model" }, {});
    expect(fs.readFileSync(path.join(prepared.home, "thread-state"), "utf8")).toBe("preserved");
    expect(fs.readdirSync(prepared.home).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("quotes configuration strings and refuses non-response APIs and credential URLs", () => {
    expect(() => prepareCodexConfig({ enabled: true, baseUrl: "https://user:secret@example.com/v1" }, {})).toThrow(/baseUrl/);
    expect(() => prepareCodexConfig({ enabled: true, envKey: "bad key" }, {})).toThrow(/envKey/);
    expect(() => prepareCodexConfig({ enabled: true, wireApi: "chat" } as any, {})).toThrow(/wireApi/);
    expect(() => prepareCodexConfig({ enabled: false }, {})).toThrow(/disabled/);
    expect(fs.existsSync(path.join(home, ".pi", "dashboard", "codex-home"))).toBe(false);
  });
});
