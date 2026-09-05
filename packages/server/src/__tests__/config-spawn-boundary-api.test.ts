import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { readConfigRedacted, writeConfigPartial } from "../config-api.js";

vi.mock("../model-proxy/registry-singleton.js", () => ({ refreshModelRegistry: vi.fn(async () => {}) }));

describe("spawn boundary config writes", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-config-api-"));
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

  it("persists explicit null, preserves it on partial updates, and marks delegation changes restart-required", () => {
    write({ auth: { secret: "secret", operatorUsers: ["owner"], localBridgeOperator: "owner" } });
    expect(writeConfigPartial({ auth: { localBridgeOperator: null } })).toMatchObject({ success: true, restartRequired: true });
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
    expect(writeConfigPartial({ auth: { allowedUsers: ["owner"] } }).success).toBe(true);
    expect(loadConfig().auth?.localBridgeOperator).toBeNull();
    expect(loadConfig().auth?.secret).toBe("secret");
    expect(writeConfigPartial({ auth: { localBridgeOperator: null } }).restartRequired).toBe(false);
    expect(writeConfigPartial({ auth: { localBridgeOperator: "owner" } })).toMatchObject({ success: true, restartRequired: true });
    expect(loadConfig().auth?.localBridgeOperator).toBe("owner");
  });

  it("redacts a secret-only auth block while retaining the configured signing key", () => {
    write({ auth: { secret: "secret" } });
    expect(readConfigRedacted().auth?.secret).toBe("***");
    expect(writeConfigPartial({ auth: { secret: "***", localBridgeOperator: null } }).success).toBe(true);
    expect(loadConfig().auth).toMatchObject({ secret: "secret", localBridgeOperator: null });
  });

  it.each([false, 0, "", "   ", [], {}].map((value) => [value]))("rejects bad delegation selector %j without changing disk", (localBridgeOperator) => {
    write({ auth: { secret: "secret", localBridgeOperator: null } });
    const before = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ auth: { localBridgeOperator } })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("validates the merged roster and delegate on either field changing", () => {
    write({ auth: { operatorUsers: ["owner"], localBridgeOperator: "owner" } });
    const before = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ auth: { localBridgeOperator: "other" } })).toMatchObject({ success: false, validationError: true });
    expect(writeConfigPartial({ auth: { operatorUsers: ["other"] } })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(writeConfigPartial({ auth: { operatorUsers: ["other"], localBridgeOperator: "other" } }).success).toBe(true);
  });

  it.each(["owner", [123], [" "]].map((value) => [value]))("rejects malformed operator roster %j with browser auth off", (operatorUsers) => {
    write({ auth: { secret: "secret", requireBrowserAuth: false, operatorUsers: ["owner"] } });
    const before = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ auth: { operatorUsers } })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("round-trips bridge listener and enforcement settings with restart markers", () => {
    write({ piHost: "127.0.0.1", bridge: { requireToken: false, future: "preserved" } });
    expect(writeConfigPartial({ piHost: "0.0.0.0", bridge: { requireToken: true } })).toMatchObject({ success: true, restartRequired: true });
    expect(loadConfig()).toMatchObject({ piHost: "0.0.0.0", bridge: { requireToken: true } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).bridge.future).toBe("preserved");
    expect(writeConfigPartial({ bridge: {} }).restartRequired).toBe(false);
    expect(loadConfig().bridge?.requireToken).toBe(true);
    expect(writeConfigPartial({ piHost: "0.0.0.0", bridge: { requireToken: true } }).restartRequired).toBe(false);
    expect(writeConfigPartial({ bridge: { requireToken: false } }).restartRequired).toBe(true);
  });

  it.each(["true", 0, null])("rejects malformed requireToken %j without changing disk", (requireToken) => {
    write({ bridge: { requireToken: true } });
    const before = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ bridge: { requireToken } })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each(["", null, 12])("rejects malformed piHost %j without changing disk", (piHost) => {
    write({ piHost: "127.0.0.1" });
    const before = fs.readFileSync(file, "utf8");
    expect(writeConfigPartial({ piHost })).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
