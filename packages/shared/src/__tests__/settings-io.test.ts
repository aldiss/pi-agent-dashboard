/**
 * Mode-I / racy-settings clobber regression (Stage-2 (e)).
 *
 * The bug: a "catch-from-{}" read (`try{JSON.parse}catch{settings={}}`) followed
 * by a write ERASES every other settings.json key when the file is briefly
 * unparseable (a concurrent/partial write). Live-witnessed twice during D6.
 *
 * Discrimination (positive + negative control in one file):
 *   - POSITIVE CONTROL: with VALID settings, the writer adds its key AND
 *     preserves every other key (proves the write path is real).
 *   - THE FIX: with an EXISTING-but-UNPARSEABLE settings.json, the writer
 *     refuses to write — the real (corrupt) bytes are preserved verbatim,
 *     NEVER overwritten with `{}` + one key.
 * An implementation with the old catch-from-{} bug fails the "file UNCHANGED"
 * assertion (the file would become `{}` + the single new key).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readSettingsOrThrow,
  atomicWriteSettings,
  updateSettings,
  SettingsUnparseableError,
} from "../settings-io.js";
import { registerBridgeExtension } from "../bridge-register.js";
import { registerPluginBridge } from "../plugin-bridge-register.js";

function settingsPathFor(home: string): string {
  return path.join(home, ".pi", "agent", "settings.json");
}
function writeRaw(home: string, raw: string): void {
  const p = settingsPathFor(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, raw);
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-io-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("settings-io: readSettingsOrThrow discriminates absent/empty/valid/unparseable", () => {
  it("absent file → {} (fresh is legitimate)", () => {
    expect(readSettingsOrThrow(settingsPathFor(home))).toEqual({});
  });
  it("empty / whitespace-only file → {} (no keys to clobber)", () => {
    writeRaw(home, "   \n\t");
    expect(readSettingsOrThrow(settingsPathFor(home))).toEqual({});
  });
  it("valid JSON object → parsed", () => {
    writeRaw(home, JSON.stringify({ defaultModel: "x", packages: ["a"] }));
    expect(readSettingsOrThrow(settingsPathFor(home))).toEqual({ defaultModel: "x", packages: ["a"] });
  });
  it("EXISTS + non-empty + UNPARSEABLE → THROWS (never returns {})", () => {
    writeRaw(home, '{ "defaultModel": "x", "packages": [ "a"'); // truncated mid-write
    expect(() => readSettingsOrThrow(settingsPathFor(home))).toThrow(SettingsUnparseableError);
  });
  it("non-object root (array) → THROWS", () => {
    writeRaw(home, "[1,2,3]");
    expect(() => readSettingsOrThrow(settingsPathFor(home))).toThrow(SettingsUnparseableError);
  });
});

describe("settings-io: atomicWriteSettings is atomic + leaves no temp", () => {
  it("writes valid JSON and cleans up its temp file", () => {
    const p = settingsPathFor(home);
    atomicWriteSettings(p, { defaultProvider: "gh", packages: ["a"] });
    expect(JSON.parse(fs.readFileSync(p, "utf-8"))).toEqual({ defaultProvider: "gh", packages: ["a"] });
    const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
  it("updateSettings skips the write when the mutator returns false", () => {
    writeRaw(home, JSON.stringify({ a: 1 }));
    const before = fs.statSync(settingsPathFor(home)).mtimeMs;
    updateSettings(settingsPathFor(home), () => false);
    expect(JSON.parse(fs.readFileSync(settingsPathFor(home), "utf-8"))).toEqual({ a: 1 });
    // (mtime may or may not change on some FSes; the content invariant is the load-bearing one)
    void before;
  });
  it("updateSettings throws (no write) on an unparseable existing file", () => {
    const corrupt = '{ "a": ';
    writeRaw(home, corrupt);
    expect(() => updateSettings(settingsPathFor(home), (s) => ({ ...s, b: 2 }))).toThrow(SettingsUnparseableError);
    expect(fs.readFileSync(settingsPathFor(home), "utf-8")).toBe(corrupt); // untouched
  });
});

describe("mode-I clobber — registerBridgeExtension (packages[])", () => {
  it("POSITIVE CONTROL — valid settings: adds the bridge, PRESERVES every other key", () => {
    writeRaw(
      home,
      JSON.stringify(
        { defaultProvider: "gh", defaultModel: "opus", thinking: "xhigh", packages: ["/existing/ext"] },
        null,
        2,
      ),
    );
    registerBridgeExtension("/new/bridge", { homedir: home });
    const after = JSON.parse(fs.readFileSync(settingsPathFor(home), "utf-8"));
    expect(after.defaultProvider).toBe("gh"); // NOT clobbered
    expect(after.defaultModel).toBe("opus"); // NOT clobbered
    expect(after.thinking).toBe("xhigh"); // NOT clobbered
    expect(after.packages).toContain("/new/bridge"); // added
    expect(after.packages).toContain("/existing/ext"); // kept
  });
  it("THE FIX — unparseable settings: THROWS + real file preserved verbatim (never clobbered to {})", () => {
    const corrupt = '{ "defaultProvider": "gh", "defaultModel": "opus", "packages": [ "/exist'; // partial write
    writeRaw(home, corrupt);
    expect(() => registerBridgeExtension("/new/bridge", { homedir: home })).toThrow(SettingsUnparseableError);
    expect(fs.readFileSync(settingsPathFor(home), "utf-8")).toBe(corrupt); // untouched — the whole point
  });
  it("absent settings → creates fresh containing the bridge", () => {
    registerBridgeExtension("/new/bridge", { homedir: home });
    const after = JSON.parse(fs.readFileSync(settingsPathFor(home), "utf-8"));
    expect(after.packages).toContain("/new/bridge");
  });
});

describe("mode-I clobber — registerPluginBridge (dashboardPluginBridges), boot-safe", () => {
  it("POSITIVE CONTROL — valid settings: adds the bridge, PRESERVES every other key", () => {
    writeRaw(home, JSON.stringify({ defaultProvider: "gh", workflows: { a: 1 } }, null, 2));
    const r = registerPluginBridge("flows", "/rel/bridge", { homedir: home });
    expect(r.type).toBe("ok");
    const after = JSON.parse(fs.readFileSync(settingsPathFor(home), "utf-8"));
    expect(after.defaultProvider).toBe("gh"); // NOT clobbered
    expect(after.workflows).toEqual({ a: 1 }); // NOT clobbered
    expect((after.dashboardPluginBridges as Record<string, string>)["dashboard-flows"]).toBe("/rel/bridge");
  });
  it("THE FIX — unparseable settings: returns {type:'skipped'} + file preserved (never clobbered, never throws)", () => {
    const corrupt = '{ "defaultProvider": "gh", "workflows": { "a"';
    writeRaw(home, corrupt);
    const r = registerPluginBridge("flows", "/rel/bridge", { homedir: home });
    expect(r.type).toBe("skipped"); // boot-safe: does not throw (server.ts calls it unwrapped)
    expect(fs.readFileSync(settingsPathFor(home), "utf-8")).toBe(corrupt); // untouched
  });
});
