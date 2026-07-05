#!/usr/bin/env node
/**
 * scripts/deploy-bridge-isolation.test.mjs — own-hand proof for X11-a
 * (deploy.mjs registerBridge jail-isolation + the readFileSync clobber fix).
 *
 * Node built-ins only (sister to deploy.mjs). Runs deploy.mjs --register-bridge-only
 * as a child process against a throwaway HOME so the operator's REAL settings.json is
 * never touched. Proves, RED->GREEN:
 *
 *   RED (pre-fix, documented): a jail --prod-root build clobbered settings to
 *       {packages:[jail-path]} because (1) it wrote the REAL settings regardless of
 *       --prod-root and (2) readFileSync was never imported -> ReferenceError swallowed
 *       by the "absent file" catch -> every write started from {}.
 *
 *   GREEN 1 (isolated skip):   jail --prod-root  -> settings BYTE-IDENTICAL (skip fired).
 *   GREEN 2 (real append):     real --prod-root  -> operator keys PRESERVED + release
 *                              bridge appended (readFileSync now works: read+append, not clobber).
 *   GREEN 3 (--no-bridge-register): real --prod-root + flag -> settings BYTE-IDENTICAL (skip).
 *   GREEN 4 (die-on-unparseable): real --prod-root + corrupt settings -> deploy EXITS
 *                              NON-ZERO and does NOT clobber (the die guard is now REACHABLE).
 *
 * Usage: node scripts/deploy-bridge-isolation.test.mjs   (exit 0 = all pass)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), "deploy.mjs");
const OPERATOR_SETTINGS = {
  defaultProvider: "github-copilot",
  defaultModel: "claude-opus-4.8",
  thinking: "xhigh",
  dashboardPluginBridges: { "dashboard-flows-anthropic-bridge": "/dev/tree/path/index.ts" },
  packages: ["npm:@earendil-works/pi-workflows"],
};

let passed = 0;
let failed = 0;
const tmpHomes = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  \u2713 ${msg}`); }
  else { failed++; console.error(`  \u2717 FAIL: ${msg}`); }
}

function seedHome(settings = OPERATOR_SETTINGS) {
  const home = mkdtempSync(join(tmpdir(), "x11a-"));
  tmpHomes.push(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, ".pi-dashboard-prod"), { recursive: true });
  const p = join(home, ".pi", "agent", "settings.json");
  writeFileSync(p, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
  return { home, settingsPath: p };
}

function runDeploy(home, args) {
  try {
    const out = execFileSync("node", [DEPLOY, ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

// GREEN 1 — isolated (jail) --prod-root: settings must be BYTE-IDENTICAL (skip).
console.log("GREEN 1: isolated/jail --prod-root -> live settings untouched");
{
  const { home, settingsPath } = seedHome();
  const before = readFileSync(settingsPath, "utf8");
  const jail = join(home, "jail", ".pi-dashboard-stage3-jail");
  mkdirSync(jail, { recursive: true });
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", jail]);
  const after = readFileSync(settingsPath, "utf8");
  assert(r.code === 0, "deploy exits 0");
  assert(/SKIP settings\.json registration/.test(r.out), "logs the isolation SKIP");
  assert(before === after, "settings.json is BYTE-IDENTICAL (no clobber, no write)");
}

// GREEN 2 — real --prod-root: operator keys preserved + release bridge appended.
console.log("GREEN 2: real --prod-root -> keys preserved + bridge appended (read+append)");
{
  const { home, settingsPath } = seedHome();
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot]);
  assert(r.code === 0, "deploy exits 0");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert(after.defaultProvider === "github-copilot", "defaultProvider preserved");
  assert(after.defaultModel === "claude-opus-4.8", "defaultModel preserved");
  assert(after.thinking === "xhigh", "thinking preserved");
  assert(after.dashboardPluginBridges && after.dashboardPluginBridges["dashboard-flows-anthropic-bridge"] === "/dev/tree/path/index.ts", "dashboardPluginBridges preserved");
  assert(Array.isArray(after.packages) && after.packages.includes("npm:@earendil-works/pi-workflows"), "existing npm package preserved");
  assert(after.packages.some((p) => p.endsWith("/packages/extension")), "release bridge appended to packages");
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
  assert(before === after, "settings.json is BYTE-IDENTICAL");
}

// GREEN 4 — real --prod-root + corrupt settings: die non-zero, no clobber (guard reachable).
console.log("GREEN 4: real --prod-root + unparseable settings -> die non-zero, no clobber");
{
  const corrupt = '{ "defaultProvider": "github-copilot", "packages": [ '; // truncated / invalid JSON
  const { home, settingsPath } = seedHome(corrupt);
  const realProdRoot = join(home, ".pi-dashboard-prod");
  const r = runDeploy(home, ["--register-bridge-only", "--prod-root", realProdRoot]);
  const after = readFileSync(settingsPath, "utf8");
  assert(r.code !== 0, "deploy EXITS NON-ZERO (die on unparseable — guard now reachable)");
  assert(/did not parse/.test(r.out), "logs the refuse-to-clobber die message");
  assert(after === corrupt, "corrupt settings.json left UNTOUCHED (not clobbered)");
}

for (const h of tmpHomes) rmSync(h, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
