import { BlockList, isIP } from "node:net";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function explicitUrl(name: string, protocols: ReadonlySet<string>): URL {
  let parsed: URL;
  try { parsed = new URL(requiredEnv(name)); }
  catch { throw new Error(`${name} must be a valid URL`); }
  if (!protocols.has(parsed.protocol)) throw new Error(`${name} uses forbidden protocol ${parsed.protocol}`);
  if (!parsed.port) throw new Error(`${name} must contain an explicit port`);
  return parsed;
}

const evidenceDir = requiredEnv("BUILD1_EVIDENCE_DIR");
const dashboardUrl = explicitUrl("BUILD1_DASHBOARD_URL", new Set(["http:", "https:"]));
const gatewayUrl = explicitUrl("BUILD1_GATEWAY_URL", new Set(["ws:", "wss:"]));
const bindHost = requiredEnv("BUILD1_BIND_HOST").replace(/^\[|\]$/gu, "");
const unsafeBindHosts = new BlockList();
unsafeBindHosts.addAddress("0.0.0.0", "ipv4");
unsafeBindHosts.addSubnet("127.0.0.0", 8, "ipv4");
unsafeBindHosts.addAddress("::", "ipv6");
unsafeBindHosts.addAddress("::1", "ipv6");
unsafeBindHosts.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
const bindFamily = isIP(bindHost);
if (bindFamily === 0 || unsafeBindHosts.check(bindHost, bindFamily === 6 ? "ipv6" : "ipv4")) {
  throw new Error("BUILD1_BIND_HOST must be a non-wildcard, non-loopback literal IP address");
}
if (gatewayUrl.hostname.replace(/^\[|\]$/gu, "") !== bindHost) {
  throw new Error("BUILD1_GATEWAY_URL hostname must equal BUILD1_BIND_HOST");
}

export default defineConfig({
  testDir: ".",
  testMatch: "ask-user-natural-healthy.spec.ts",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(evidenceDir, "playwright-report") }],
  ],
  outputDir: path.join(evidenceDir, "playwright-output"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: dashboardUrl.href,
    browserName: "chromium",
    headless: false,
    viewport: { width: 1440, height: 1000 },
    trace: "on",
    screenshot: "on",
    video: "on",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "operator-reachable-chromium" }],
});
