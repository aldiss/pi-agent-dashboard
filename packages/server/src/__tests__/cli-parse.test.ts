/**
 * Tests for CLI argument parsing.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, buildConfig } from "../cli.js";

describe("parseArgs", () => {
  it("returns null subcommand with no args", () => {
    const result = parseArgs([]);
    expect(result.subcommand).toBeNull();
    expect(result.flags).toEqual({});
  });

  it("parses start subcommand", () => {
    const result = parseArgs(["start"]);
    expect(result.subcommand).toBe("start");
  });

  it("parses stop subcommand", () => {
    const result = parseArgs(["stop"]);
    expect(result.subcommand).toBe("stop");
  });

  it("parses restart subcommand", () => {
    const result = parseArgs(["restart"]);
    expect(result.subcommand).toBe("restart");
  });

  it("parses status subcommand", () => {
    const result = parseArgs(["status"]);
    expect(result.subcommand).toBe("status");
  });

  it("parses upgrade-pi subcommand (unified-bootstrap-install §8)", () => {
    const result = parseArgs(["upgrade-pi"]);
    expect(result.subcommand).toBe("upgrade-pi");
  });

  it("parses upgrade-pi with --port flag", () => {
    const result = parseArgs(["upgrade-pi", "--port", "9090"]);
    expect(result.subcommand).toBe("upgrade-pi");
    expect(result.flags.port).toBe(9090);
  });

  it("parses subcommand with flags", () => {
    const result = parseArgs(["start", "--port", "3000", "--pi-port", "4000"]);
    expect(result.subcommand).toBe("start");
    expect(result.flags.port).toBe(3000);
    expect(result.flags.piPort).toBe(4000);
  });

  it("parses flags without subcommand (foreground mode)", () => {
    const result = parseArgs(["--port", "3000", "--dev"]);
    expect(result.subcommand).toBeNull();
    expect(result.flags.port).toBe(3000);
    expect(result.flags.dev).toBe(true);
  });

  it("parses --no-tunnel flag", () => {
    const result = parseArgs(["start", "--no-tunnel"]);
    expect(result.subcommand).toBe("start");
    expect(result.flags.tunnel).toBe(false);
  });

  it("parses --fixture flag (deterministic e2e/visual testing)", () => {
    const result = parseArgs(["start", "--fixture"]);
    expect(result.subcommand).toBe("start");
    expect(result.flags.fixtureMode).toBe(true);
  });

  it("parses resurrect subcommand with positional session id (Component B CLI)", () => {
    const result = parseArgs(["resurrect", "019f140a"]);
    expect(result.subcommand).toBe("resurrect");
    expect(result.resurrectId).toBe("019f140a");
  });

  it("parses resurrect with id AND a flag (id captured, flag parsed)", () => {
    const result = parseArgs(["resurrect", "019f140a", "--port", "8010"]);
    expect(result.subcommand).toBe("resurrect");
    expect(result.resurrectId).toBe("019f140a");
    expect(result.flags.port).toBe(8010);
  });

  it("resurrect without an id leaves resurrectId undefined (handler errors)", () => {
    const result = parseArgs(["resurrect"]);
    expect(result.subcommand).toBe("resurrect");
    expect(result.resurrectId).toBeUndefined();
  });

  it("ignores unknown args", () => {
    const result = parseArgs(["start", "--unknown", "value"]);
    expect(result.subcommand).toBe("start");
    expect(result.flags).toEqual({});
  });

  it("does not treat flag values as subcommands", () => {
    const result = parseArgs(["--port", "3000"]);
    expect(result.subcommand).toBeNull();
    expect(result.flags.port).toBe(3000);
  });
});

describe("buildConfig — fixtureMode wiring (real-e2e sandbox isolation)", () => {
  // The ServerConfig.fixtureMode field is consumed by createServer (mDNS-advertise
  // OFF, browser OFF, zrok OFF, bootstrap-install OFF) but NO boot path ever
  // populated it — the "Gated by PI_DASHBOARD_FIXTURE_MODE=1" contract was
  // documented-not-wired. These lock the wiring the real-e2e sandbox depends on
  // (design-pass §1.2 closure-#1: fixture ⇒ sandbox invisible to live mDNS).
  const ENV_KEY = "PI_DASHBOARD_FIXTURE_MODE";
  const saved = process.env[ENV_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("defaults fixtureMode to false when neither flag nor env is set", () => {
    delete process.env[ENV_KEY];
    expect(buildConfig({}).fixtureMode).toBe(false);
  });

  it("enables fixtureMode from PI_DASHBOARD_FIXTURE_MODE=1", () => {
    process.env[ENV_KEY] = "1";
    expect(buildConfig({}).fixtureMode).toBe(true);
  });

  it("enables fixtureMode from PI_DASHBOARD_FIXTURE_MODE=true", () => {
    process.env[ENV_KEY] = "true";
    expect(buildConfig({}).fixtureMode).toBe(true);
  });

  it("does NOT enable fixtureMode for a non-truthy env value", () => {
    process.env[ENV_KEY] = "0";
    expect(buildConfig({}).fixtureMode).toBe(false);
  });

  it("the --fixture flag wins over an unset env", () => {
    delete process.env[ENV_KEY];
    expect(buildConfig({ fixtureMode: true }).fixtureMode).toBe(true);
  });
});

describe("daemon spawn jiti resolution", () => {
  it("ToolResolver.resolveJiti either returns a file:// URL or null", async () => {
    // After change `unify-server-launch-ts-loader`, jiti resolution
    // is owned by `ToolResolver.resolveJiti()` which walks managed pi
    // → system pi → anchor → argv. Vitest's transitive `jiti` dep
    // makes resolution likely succeed under the test runner; either
    // outcome is valid — we just assert the contract: success returns
    // a `file://` URL, miss returns null (no throw).
    const { ToolResolver } = await import(
      "@blackbelt-technology/pi-dashboard-shared/platform/binary-lookup.js"
    );
    const url = new ToolResolver().resolveJiti();
    if (url !== null) {
      expect(url.startsWith("file://")).toBe(true);
    } else {
      expect(url).toBeNull();
    }
  });
});

// ── PUSHBACK-3 FIX-P3-6 (dual-review MINOR-4): {startup} scope on buildConfig ─────
// `buildConfig` runs `loadConfig({startup})` before the subcommand switch. A
// malformed auth config throws when `startup:true` (fail-CLOSED-REFUSE, correct
// for the server-STARTING verbs) but must NOT throw when `startup:false` (the
// availability verbs `stop`/`status` must still run — an operator who mis-edits
// the flag has to be able to stop the daemon + fix the config). This locks the
// scope so a malformed auth config bricks `start` (fail-closed) but not
// `stop`/`status` (available).
describe("buildConfig — {startup} scope (FIX-P3-6: malformed auth config bricks start, not stop/status)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-fix3-cli-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME;
    process.env.HOME = testDir;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("startup:true (start/restart/foreground) THROWS on a malformed auth security flag (fail-closed)", () => {
    // Red-arm: revert `main` to always `buildConfig(flags, {startup:true})` and
    // this stays correct; the availability test below is the one that flips.
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: "true" } }));
    expect(() => buildConfig({}, { startup: true })).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it("startup:false (stop/status/upgrade-pi/resurrect) does NOT throw on the same malformed config (degrades)", () => {
    // Red-arm: gate `{startup:true}` UNCONDITIONALLY (drop the FIX-P3-6 scoping)
    // → stop/status brick on a mis-edited flag → this throws → RED (the exact
    // availability regression the fix closes).
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: "true" } }));
    expect(() => buildConfig({}, { startup: false })).not.toThrow();
  });

  it("default (no opts) stays fail-closed (backward-compatible: every existing caller refuses a malformed flag)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: "true" } }));
    expect(() => buildConfig({})).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it("a VALID auth config builds cleanly under both scopes", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: true, secret: "s" } }));
    expect(() => buildConfig({}, { startup: true })).not.toThrow();
    expect(() => buildConfig({}, { startup: false })).not.toThrow();
  });
});

describe("parseArgs --help (dl-11991 regression guard)", () => {
  it("sets help=true for --help and does not treat it as a subcommand", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
    expect(result.subcommand).toBeNull();
  });
  it("sets help=true for the -h alias", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });
  it("does not set help for a normal invocation", () => {
    expect(parseArgs([]).help).toBeFalsy();
    expect(parseArgs(["start"]).help).toBeFalsy();
    expect(parseArgs(["status", "--port", "9090"]).help).toBeFalsy();
  });
  it("help wins even when combined with flags (never a silent fall-through to start)", () => {
    const result = parseArgs(["--help", "--port", "9090"]);
    expect(result.help).toBe(true);
    expect(result.subcommand).toBeNull();
  });
  it("recognizes -h after a subcommand too", () => {
    const result = parseArgs(["start", "-h"]);
    expect(result.help).toBe(true);
    expect(result.subcommand).toBe("start");
  });
});
