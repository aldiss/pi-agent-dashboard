import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { writeConfigPartial } from "../config-api.js";

describe("guestCellGrants config integrity", () => {
  let home: string;
  let priorHome: string | undefined;
  let configFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cell-grants-config-"));
    fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(home, ".pi", "dashboard", "config.json");
    priorHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(auth: Record<string, unknown>) {
    fs.writeFileSync(configFile, JSON.stringify({ auth }, null, 2));
  }

  it("parses an empty or populated map and keeps the auth block relevant", () => {
    write({
      secret: "test",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: ["owner"],
      guestCellGrants: {},
    });
    expect(loadConfig({ startup: true }).auth?.guestCellGrants).toEqual({});

    write({
      secret: "test",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: ["owner"],
      guestCellGrants: { Friend: ["cell-a", "cell-b"] },
    });
    expect(loadConfig({ startup: true }).auth?.guestCellGrants).toEqual({ Friend: ["cell-a", "cell-b"] });
  });

  it.each([
    ["scalar", "cell-a"],
    ["array root", []],
    ["empty selector", { "": ["cell-a"] }],
    ["scalar cells", { friend: "cell-a" }],
    ["empty cell", { friend: [""] }],
    ["non-string cell", { friend: [12] }],
  ])("startup refuses malformed grants: %s", (_label, guestCellGrants) => {
    write({
      secret: "test",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: ["owner"],
      guestCellGrants,
    });
    expect(() => loadConfig({ startup: true })).toThrow(/guestCellGrants/i);
  });

  it("startup refuses unparseable JSON carrying the guestCellGrants security key", () => {
    fs.writeFileSync(configFile, '{ "auth": { "guestCellGrants": { "friend": ["cell-a"] } } broken');
    expect(() => loadConfig({ startup: true })).toThrow(/guestCellGrants|UNPARSEABLE/i);
  });

  it("startup refuses grants without browser auth or without a usable operator", () => {
    write({ secret: "test", providers: {}, operatorUsers: ["owner"], guestCellGrants: {} });
    expect(() => loadConfig({ startup: true })).toThrow(/requireBrowserAuth/i);

    write({ secret: "test", providers: {}, requireBrowserAuth: true, guestCellGrants: {} });
    expect(() => loadConfig({ startup: true })).toThrow(/operatorUsers/i);

    write({
      secret: "test",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: [],
      guestCellGrants: {},
    });
    expect(() => loadConfig({ startup: true })).toThrow(/operatorUsers/i);
  });

  it("partial write persists grants, preserves prior grants when omitted, and marks changes restart-required", () => {
    write({
      secret: "do-not-drop",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: ["owner"],
      guestCellGrants: { friend: ["cell-a"] },
    });

    const changed = writeConfigPartial({ auth: { guestCellGrants: { friend: ["cell-b"] } } });
    expect(changed).toMatchObject({ success: true, restartRequired: true });
    let disk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(disk.auth.secret).toBe("do-not-drop");
    expect(disk.auth.operatorUsers).toEqual(["owner"]);
    expect(disk.auth.guestCellGrants).toEqual({ friend: ["cell-b"] });

    const omitted = writeConfigPartial({ auth: { allowedUsers: ["owner", "friend"] } });
    expect(omitted.success).toBe(true);
    disk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(disk.auth.guestCellGrants).toEqual({ friend: ["cell-b"] });

    const same = writeConfigPartial({ auth: { guestCellGrants: { friend: ["cell-b"] } } });
    expect(same.restartRequired).toBe(false);
  });

  it("write rejects malformed or uncoupled grants without changing disk", () => {
    write({
      secret: "test",
      providers: {},
      requireBrowserAuth: true,
      operatorUsers: ["owner"],
    });
    const before = fs.readFileSync(configFile, "utf8");
    const malformed = writeConfigPartial({ auth: { guestCellGrants: { friend: [""] } } });
    expect(malformed).toMatchObject({ success: false, validationError: true });
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);

    write({ secret: "test", providers: {}, requireBrowserAuth: false, operatorUsers: ["owner"] });
    const uncoupled = writeConfigPartial({ auth: { guestCellGrants: {} } });
    expect(uncoupled).toMatchObject({ success: false, validationError: true });
  });
});
