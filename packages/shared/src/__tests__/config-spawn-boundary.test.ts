import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";

describe("spawn boundary config", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-config-"));
    fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
    file = path.join(home, ".pi", "dashboard", "config.json");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(value: unknown) {
    fs.writeFileSync(file, JSON.stringify(value));
  }

  it("defaults the bridge listener to loopback without requiring tokens", () => {
    expect(loadConfig()).toMatchObject({ piHost: "127.0.0.1", bridge: { requireToken: false } });
    write({ piHost: "::1", bridge: { requireToken: true } });
    expect(loadConfig({ startup: true })).toMatchObject({ piHost: "::1", bridge: { requireToken: true } });
  });

  it.each([false, true])("preserves explicit delegation disable with browser auth %s", (requireBrowserAuth) => {
    write({ auth: { requireBrowserAuth, localBridgeOperator: null } });
    expect(loadConfig({ startup: true }).auth?.localBridgeOperator).toBeNull();
  });

  it("preserves a configured operator and secret when browser auth is off", () => {
    write({ auth: { secret: "signing-secret", requireBrowserAuth: false, operatorUsers: ["owner"], localBridgeOperator: "owner" } });
    expect(loadConfig({ startup: true }).auth).toMatchObject({ secret: "signing-secret", operatorUsers: ["owner"], localBridgeOperator: "owner" });
  });

  it("preserves secret-only and operators-only auth blocks", () => {
    write({ auth: { secret: "signing-secret" } });
    expect(loadConfig().auth?.secret).toBe("signing-secret");
    write({ auth: { operatorUsers: ["owner"] } });
    expect(loadConfig().auth?.operatorUsers).toEqual(["owner"]);
    write({ auth: { localBridgeOperator: "owner" } });
    expect(loadConfig().auth?.localBridgeOperator).toBe("owner");
  });

  it("keeps an absent or empty auth block absent", () => {
    write({ auth: {} });
    expect(loadConfig().auth).toBeUndefined();
    write({ auth: { secret: "   " } });
    expect(loadConfig().auth).toBeUndefined();
  });

  it.each([false, 0, 4, "", "   ", [], {}].map((value) => [value]))("refuses malformed delegation selector %j at startup and disables it at runtime", (localBridgeOperator) => {
    write({ auth: { localBridgeOperator } });
    expect(() => loadConfig({ startup: true })).toThrow(/localBridgeOperator/);
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
  });

  it("refuses a configured delegate outside a nonempty operator roster", () => {
    write({ auth: { operatorUsers: ["owner"], localBridgeOperator: "other" } });
    expect(() => loadConfig({ startup: true })).toThrow(/localBridgeOperator/);
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
    write({ auth: { operatorUsers: ["Owner"], localBridgeOperator: " owner " } });
    expect(loadConfig({ startup: true }).auth?.localBridgeOperator).toBe("owner");
  });

  it.each(["owner", [123], [" "]].map((value) => [value]))("does not downgrade malformed operator roster %j to synthetic delegation", (operatorUsers) => {
    write({ auth: { requireBrowserAuth: false, operatorUsers } });
    expect(() => loadConfig({ startup: true })).toThrow(/operatorUsers/);
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
  });

  it.each(["true", "false", 0, null, [], {}].map((value) => [value]))("refuses malformed token-enforcement value %j without silently disabling it", (requireToken) => {
    write({ bridge: { requireToken } });
    expect(() => loadConfig({ startup: true })).toThrow(/requireToken/);
    expect(loadConfig().bridge?.requireToken).toBe(true);
  });

  it.each([0, null, ""])("refuses invalid listener host %j instead of binding unexpectedly", (piHost) => {
    write({ piHost });
    expect(() => loadConfig({ startup: true })).toThrow(/piHost/);
    expect(loadConfig().piHost).toBe("127.0.0.1");
  });

  it.each(["localBridgeOperator", "requireToken", "operatorUsers"])("refuses malformed JSON carrying %s and keeps runtime spawn disabled", (key) => {
    fs.writeFileSync(file, `{ "auth": { "${key}": null } broken`);
    expect(() => loadConfig({ startup: true })).toThrow(/UNPARSEABLE/);
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
    expect(loadConfig().bridge?.requireToken).toBe(true);
  });
});
