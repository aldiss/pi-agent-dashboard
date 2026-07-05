#!/usr/bin/env node
/**
 * scripts/deploy-bridge-isolation.test.mjs — own-hand proof for X11-a + X11-b
 * (deploy.mjs registerBridge jail-isolation + readFileSync clobber fix + release
 * plugin-bridge D6 treatment).
 *
 * Node built-ins only (sister to deploy.mjs). Runs deploy.mjs --register-bridge-only
 * as a child process against a throwaway HOME so the operator's REAL settings.json is
 * never touched. Proves, RED->GREEN:
 *
 *   RED (pre-fix, documented + reproduced live):
 *     - jail --prod-root build clobbered settings to {packages:[jail-path]} because
 *       (1) it wrote the REAL settings regardless of --prod-root and (2) readFileSync
 *       was never imported -> ReferenceError swallowed by the "absent file" catch ->
 *       every write started from {}.
 *     - dashboardPluginBridges kept a STICKY dev-tree path: the release server discovers
 *       the release plugin (cwd=release) but registerPluginBridge returns "conflict"
 *       (never overwrites) against the stale dev entry, so the dev path never left.
 *
 *   GREEN 1 isolated skip:      jail --prod-root -> settings BYTE-IDENTICAL (skip fired).
 *   GREEN 2 real append:        real --prod-root -> operator keys preserved + release
 *                               main bridge appended (readFileSync: read+append, not clobber).
 *   GREEN 3 --no-bridge-register: real --prod-root + flag -> settings BYTE-IDENTICAL.
 *   GREEN 4 die-on-unparseable: real --prod-root + corrupt settings -> deploy EXITS
 *                               NON-ZERO and does NOT clobber (guard now REACHABLE).
 *   GREEN 5 plugin-bridge D6:   real --prod-root + a release tree that ships a plugin ->
 *                               dashboardPluginBridges PINNED under the release + the
 *                               stale DEV-tree entry REMOVED + operator keys preserved.
 *
 * Usage: node scripts/deploy-bridge-isolation.test.mjs   (exit 0 = all pass)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), "deploy.mjs");
const OPERATOR_SETTINGS = {
  defaultProvider: "github-copilot",
  defaultModel: "claude-opus-4.8",
  thinking: "xhigh",
  packages: ["npm:@earendil-works/pi-workflows"],
};
const DEV_BRIDGE = "/Users/x/Misc/Documents/Copilot/pi-agent-dashboard/packages/flows-anthropic-bridge-plugin/src/bridge/index.ts";

let passed = 0;
let failed = 0;
const tmpHomes = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \u2713 ${msg}`); }
  else { failed++; console.error(`  \u2717 FAIL: ${msg}`); }
}

function seedHome(settings = OPERATOR_SETTINGS) {
  const home = mkdtempSync(join(tmpdir(), "x11-"));
  tmpHomes.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, ".pi-dashboard-prod"), { recursive: true });
  const p = join(home, ".pi", "agent", "settings.json");
  writeFileSync(p, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
  return { home, settingsPath: p };
}

// Build a minimal committed-style RELEASE tree with the main bridge + one plugin that
// ships a bridge manifest (package.json#pi-dashboard-plugin), and point current -> it.
function seedRelease(home) {
  const sha = "fakesha0000000000000000000000000000000000";
  const releaseDir = join(home, ".pi-dashboard-prod", "releases", sha);
  const pluginDir = join(releaseDir, "packages", "flows-anthropic-bridge-plugin");
  mkdirSync(join(pluginDir, "src", "bridge"), { recursive: true });
  mkdirSync(join(releaseDir, "packages", "extension"), { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
    name: "flows-anthropic-bridge-plugin",
    "pi-dashboard-plugin": { id: "flows-anthropic-bridge", bridge: "./src/bridge/index.ts" },
  }, null, 2));
  writeFileSync(join(pluginDir, "src", "bridge", "index.ts"), "export default {};\n");
  symlinkSync(releaseDir, join(home, ".pi-dashboard-prod", "current"));
  // deploy.mjs realpathSync's `current` (canonicalizes /var -> /private/var on macOS),
  // so the expected pinned path must be realpath-anchored to match exactly.
  return join(realpathSync(releaseDir), "packages", "flows-anthropic-bridge-plugin", "src", "bridge", "index.ts");
}

function runDeploy(home, args) {
  try {
    const out = execFileSync("node", [DEPLOY, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

// GREEN 1 — isolated (jail) --prod-root: settings must be BYTE-IDENTICAL (skip).
console.log("GREEN 1: isolated/jail --prod-root -> live settings untouched");
{
  const seed = { ...OPERATOR_SETTINGS, dashboardPluginBridges: { "dashboard-flows-anthropic-bridge": DEV_BRIDGE } };
  const { home, settingsPath } = seedHome(seed);
  const before = readFileSync(settingsPath, "utf8");
  const jail = join(home, "jail", ".pi-dashboard-stage3-jail");
  mkdirSync(jail, { recursive: true });
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", jail]);
  const after = readFileSync(settingsPath, "utf8");
  assert(r.code === 0, "deploy exits 0");
  assert(/SKIP settings\.json registration/.test(r.out), "logs the isolation SKIP");
  assert(before === after, "settings.json BYTE-IDENTICAL (dev plugin-bridge untouched in jail)");
}

// GREEN 2 — real --prod-root (no release tree): keys preserved + main bridge appended.
console.log("GREEN 2: real --prod-root -> keys preserved + main bridge appended");
{
  const { home, settingsPath } = seedHome();
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot]);
  assert(r.code === 0, "deploy exits 0");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert(after.defaultProvider === "github-copilot", "defaultProvider preserved");
  assert(after.defaultModel === "claude-opus-4.8", "defaultModel preserved");
  assert(after.thinking === "xhigh", "thinking preserved");
  assert(Array.isArray(after.packages) && after.packages.includes("npm:@earendil-works/pi-workflows"), "existing npm package preserved");
  assert(after.packages.some((p) => p.endsWith("/packages/extension")), "release main bridge appended to packages");
}

// GREEN 3 — real --prod-root + --no-bridge-register: byte-identical (explicit skip).
console.log("GREEN 3: real --prod-root + --no-bridge-register -> untouched (explicit skip)");
{
  const { home, settingsPath } = seedHome();
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const before = readFileSync(settingsPath, "utf8");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot, "--no-bridge-register"]);
  const after = readFileSync(settingsPath, "utf8");
  assert(r.code === 0, "deploy exits 0");
  assert(/SKIP settings\.json registration \(--no-bridge-register/.test(r.out), "logs the --no-bridge-register SKIP");
  assert(before === after, "settings.json BYTE-IDENTICAL");
}

// GREEN 4 — real --prod-root + corrupt settings: die non-zero, no clobber (guard reachable).
console.log("GREEN 4: real --prod-root + unparseable settings -> die non-zero, no clobber");
{
  const corrupt = '{ "defaultProvider": "github-copilot", "packages": [ ';
  const { home, settingsPath } = seedHome(corrupt);
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot]);
  const after = readFileSync(settingsPath, "utf8");
  assert(r.code !== 0, "deploy EXITS NON-ZERO (die on unparseable — guard now reachable)");
  assert(/did not parse/.test(r.out), "logs the refuse-to-clobber die message");
  assert(after === corrupt, "corrupt settings.json left UNTOUCHED (not clobbered)");
}

// GREEN 5 — X11-b: real --prod-root + a release plugin: dashboardPluginBridges PINNED
// under the release + stale DEV-tree entry REMOVED + operator keys preserved.
console.log("GREEN 5: real --prod-root -> plugin-bridge pinned under release, dev-tree removed");
{
  const seed = { ...OPERATOR_SETTINGS, dashboardPluginBridges: { "dashboard-flows-anthropic-bridge": DEV_BRIDGE } };
  const { home, settingsPath } = seedHome(seed);
  const expectedRelease = seedRelease(home);
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot]);
  assert(r.code === 0, "deploy exits 0");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const pinned = after.dashboardPluginBridges?.["dashboard-flows-anthropic-bridge"];
  assert(pinned === expectedRelease, `plugin-bridge PINNED under release (${pinned})`);
  assert(pinned && pinned.includes("/.pi-dashboard-prod/releases/"), "pinned path resolves under the release, not the dev tree");
  assert(pinned !== DEV_BRIDGE, "stale DEV-tree plugin-bridge path REMOVED");
  assert(after.defaultProvider === "github-copilot" && after.thinking === "xhigh", "operator keys preserved");
  assert(/plugin-bridge boundary: registered 1 release plugin-bridge/.test(r.out), "logs the release plugin-bridge registration");
  assert(/plugin-bridge boundary: removed 1 stale\/dev-tree/.test(r.out), "logs the stale dev-tree removal");
}

for (const h of tmpHomes) rmSync(h, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
