import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { writeConfigPartial } from "../config-api.js";

vi.mock("../model-proxy/registry-singleton.js", () => ({ refreshModelRegistry: vi.fn(async () => {}) }));

describe("Codex runtime config writes", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-api-"));
    fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
    file = path.join(home, ".pi", "dashboard", "config.json");
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("preserves omitted runtime settings and requires restart on actual changes", () => {
    fs.writeFileSync(file, JSON.stringify({ auth: { secret: "preserve" }, runtimes: { codex: { enabled: true, model: "original", envKey: "FIXTURE_KEY" }, future: { untouched: true } } }));
    expect(writeConfigPartial({ runtimes: { codex: { model: "next" } } })).toMatchObject({ success: true, restartRequired: true });
    expect(loadConfig().runtimes?.codex).toMatchObject({ enabled: true, model: "next", envKey: "FIXTURE_KEY" });
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk.auth.secret).toBe("preserve");
    expect(disk.runtimes.future).toEqual({ untouched: true });
    expect(writeConfigPartial({ runtimes: { codex: { model: "next" } } }).restartRequired).toBe(false);
  });
  it("rejects malformed runtime changes without mutating disk", () => {
    fs.writeFileSync(file, JSON.stringify({ runtimes: { codex: { enabled: false } } }));
    const prior = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ runtimes: { codex: { enabled: "true" } } })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(prior);
  });
});
