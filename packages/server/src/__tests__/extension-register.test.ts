/**
 * Tests for the shared bridge extension registration (server context).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { registerBridgeExtension, findBundledExtension } from "@blackbelt-technology/pi-dashboard-shared/bridge-register.js";
import { SettingsUnparseableError } from "@blackbelt-technology/pi-dashboard-shared/settings-io.js";

describe("bridge extension registration (server context)", () => {
  let tmpDir: string;
  let settingsPath: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-reg-test-"));
    settingsPath = path.join(tmpDir, ".pi", "agent", "settings.json");
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("findBundledExtension returns null when extension dir does not exist", () => {
    // Strategy 2 (require.resolve) would find the monorepo extension;
    // disable it for this test so we exercise Strategy 1 in isolation.
    const result = findBundledExtension(tmpDir, { resolvePackage: () => null });
    expect(result).toBeNull();
  });

  it("findBundledExtension finds extension under base dir", () => {
    const extDir = path.join(tmpDir, "packages", "extension");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "package.json"), "{}");
    expect(findBundledExtension(tmpDir)).toBe(extDir);
  });

  it("registerBridgeExtension adds extension to empty settings file", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{}");

    registerBridgeExtension("/test/extension");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.packages).toContain("/test/extension");
  });

  it("does NOT clobber a malformed settings.json — throws + preserves the file (mode-I fix)", () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const corrupt = "not valid json{{{";
    fs.writeFileSync(settingsPath, corrupt);
    // PREVIOUS behavior (the bug): "start fresh" → the next write CLOBBERED every
    // other settings.json key (defaultProvider/model/thinking/pluginBridges/
    // workflows). This was live-witnessed twice during D6 (dl-4565/4566). The safe
    // behavior is to REFUSE: throw SettingsUnparseableError and leave the real
    // (concurrently-written / corrupt) file untouched, so nothing is clobbered.
    expect(() => registerBridgeExtension("/test/extension")).toThrow(SettingsUnparseableError);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(corrupt); // NOT clobbered
  });

  it("should not crash when settings directory does not exist", () => {
    // HOME points to tmpDir but .pi/agent/ doesn't exist
    registerBridgeExtension("/test/extension");
    // Should create the directory and write
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.packages).toContain("/test/extension");
  });
});
