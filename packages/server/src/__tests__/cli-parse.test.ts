/**
 * Tests for CLI argument parsing.
 */
import { describe, it, expect, afterEach } from "vitest";
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
