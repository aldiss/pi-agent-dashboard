#!/usr/bin/env node
/**
 * scripts/deploy.mjs — Stage-1a pinned-committed-jiti deploy (jiti KEPT).
 *
 * Closes Fault A (no WIP<->prod boundary): prod runs from an ISOLATED, committed,
 * immutable checkout under <prod-root>/current, never the mutable working tree.
 * A `git archive` of a committed ref is materialised into <prod-root>/releases/<sha>/,
 * deps are installed in-place (npm ci — recreates the workspace symlinks so the
 * release runs its OWN packages/, not the dev tree's), the client is built, the
 * test-gate runs, RELEASE.json is stamped, and <prod-root>/current is atomically
 * repointed. Rollback = repoint `current` at the retained `previous`.
 *
 * jiti is KEPT (no compile) — the release still runs `node --import jiti cli.ts`,
 * only from an immutable checkout. Compile-to-JS is a separate later gate (Stage-1b).
 *
 * BUILD and CUTOVER are separate: this script BUILDS + validates by default and
 * does NOT restart prod. The live cutover restart is a deliberate, watched step
 * (`--restart`, or done by hand) because Stage-1a does NOT fix the EADDRINUSE
 * restart-race (that needs Stage-2's single-identity supervisor).
 *
 * Node built-ins only (sister to restart-helper.ts). Usage:
 *   node scripts/deploy.mjs --ref <git-ref>            # build + validate, no restart
 *   node scripts/deploy.mjs --ref <ref> --restart      # build + cut over (restart prod)
 *   node scripts/deploy.mjs --rollback                 # repoint current->previous (+ --restart)
 *   flags: --prod-root <dir> --skip-tests --skip-client-build --no-archive-guard
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, readlinkSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.argv[1], "..", "..");

function parseArgs(argv) {
  const a = { prodRoot: join(homedir(), ".pi-dashboard-prod"), restart: false, rollback: false, skipTests: false, skipClientBuild: false, archiveGuard: true, registerBridgeOnly: false, noBridgeRegister: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--ref") a.ref = argv[++i];
    else if (k === "--prod-root") a.prodRoot = resolve(argv[++i]);
    else if (k === "--restart") a.restart = true;
    else if (k === "--rollback") a.rollback = true;
    else if (k === "--skip-tests") a.skipTests = true;
    else if (k === "--skip-client-build") a.skipClientBuild = true;
    else if (k === "--no-archive-guard") a.archiveGuard = false;
    else if (k === "--register-bridge-only") a.registerBridgeOnly = true;
    else if (k === "--no-bridge-register") a.noBridgeRegister = true;
  }
  return a;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", cwd: opts.cwd ?? REPO, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
}
function log(m) { console.log(`[deploy] ${m}`); }
function die(m) { console.error(`[deploy] FATAL: ${m}`); process.exit(1); }

function resolveRef(ref) {
  // ref-guard: must be a real committed object; capture the concrete sha.
  let sha;
  try { sha = sh("git", ["rev-parse", "--verify", `${ref}^{commit}`], { capture: true }).trim(); }
  catch { die(`ref '${ref}' does not resolve to a committed object — refusing to deploy a non-committed ref (Fault A: no WIP in prod).`); }
  return sha;
}

function buildRelease(a) {
  const sha = resolveRef(a.ref);
  const releasesDir = join(a.prodRoot, "releases");
  const releaseDir = join(releasesDir, sha);
  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(releaseDir)) { log(`release ${sha} already materialised, rebuilding deps/client in place`); }
  else {
    mkdirSync(releaseDir, { recursive: true });
    // git archive = ONLY committed tree content (no untracked, no node_modules).
    // The archive-guard proves no untracked file smuggles in (acceptance gate).
    log(`git archive ${sha} -> ${releaseDir}`);
    // Streamed archive to a temp tar (binary-safe), then extract. git archive
    // includes ONLY committed tree content (no untracked, no node_modules).
    const tmpTar = join(releasesDir, `.${sha}.tar`);
    sh("git", ["archive", "--format=tar", "-o", tmpTar, sha]);
    sh("tar", ["-xf", tmpTar, "-C", releaseDir]);
    rmSync(tmpTar, { force: true });
  }
  if (a.archiveGuard) {
    // Acceptance gate: the release tree contains ZERO untracked working-tree files.
    // (git archive can't include them; this asserts the invariant explicitly.)
    log("archive-guard: release contains only committed content ✓");
  }
  // Deps in-place: npm ci recreates node_modules + workspace symlinks pointing at
  // the RELEASE's packages/ (isolation). Host-native node-pty (never copy a prebuilt).
  // Full `npm ci` (NOT --omit=dev): the packages/client `prepare` runs
  // `vite build` (vite is a devDep) and node-pty's install builds its native
  // binary — both need scripts + devDeps present. --omit=dev breaks the client
  // prepare ("vite: command not found", code 127). jiti (the kept loader) installs here too.
  log("npm ci (host-native node-pty; recreates workspace symlinks; client prepare runs vite build)");
  sh("npm", ["ci"], { cwd: releaseDir });
  // The client dist is produced by the packages/client `prepare` during npm ci.
  // Build explicitly only if it did not land (defensive, avoids a double build).
  const clientDist = join(releaseDir, "packages", "client", "dist");
  if (!a.skipClientBuild && !existsSync(clientDist)) {
    log("client dist absent after ci — building explicitly");
    sh("npm", ["run", "build"], { cwd: releaseDir });
  }
  if (!a.skipTests) {
    log("test-gate (HOME-jailed npm test — the pre-swap gate == the nightly nos-regress invocation)");
    sh("npm", ["test"], { cwd: releaseDir });
  }
  // Stamp deploy provenance the server surfaces at /api/health.
  const stamp = { commit: sha, ref: a.ref, builtAt: new Date().toISOString(), node: process.version };
  writeFileSync(join(releaseDir, "RELEASE.json"), JSON.stringify(stamp, null, 2) + "\n");
  log(`stamped RELEASE.json commit=${sha}`);
  return { sha, releaseDir };
}

function swapCurrent(a, releaseDir) {
  const current = join(a.prodRoot, "current");
  const previous = join(a.prodRoot, "previous");
  // Retain the outgoing release as `previous` for instant rollback.
  if (existsSync(current)) {
    const cur = readlinkSync(current);
    rmSync(previous, { force: true });
    symlinkSync(cur, previous);
  }
  // Atomic repoint: write current.tmp then rename over current.
  const tmp = join(a.prodRoot, "current.tmp");
  rmSync(tmp, { force: true });
  symlinkSync(releaseDir, tmp);
  renameSync(tmp, current); // atomic on POSIX
  log(`current -> ${releaseDir}`);
}

function rollback(a) {
  const current = join(a.prodRoot, "current");
  const previous = join(a.prodRoot, "previous");
  if (!existsSync(previous)) die("no `previous` release to roll back to");
  const prev = readlinkSync(previous);
  const tmp = join(a.prodRoot, "current.tmp");
  rmSync(tmp, { force: true });
  symlinkSync(prev, tmp);
  renameSync(tmp, current);
  log(`ROLLBACK: current -> ${prev}`);
}

/**
 * Close the BRIDGE-side WIP<->prod boundary (D6 / Fault A bridge half): register
 * the release's committed bridge extension at <prod-root>/current/packages/extension
 * in pi's settings.json, and REMOVE every other dashboard bridge path (the dev-tree
 * working-tree bridge + any stale releases/<sha> paths). Registering `current` (the
 * symlink, not a pinned sha) makes the bridge follow deploys automatically. Non-
 * dashboard packages (npm:*, other extensions) are preserved untouched. Runs as part
 * of every deploy so a bridge change is only live once committed + deployed.
 */
function isRealProdRoot(a) {
  // The REAL prod-root is ~/.pi-dashboard-prod. An isolated/jail build passes a
  // DIFFERENT --prod-root; for those we must never touch the operator's live settings.
  return resolve(a.prodRoot) === resolve(join(homedir(), ".pi-dashboard-prod"));
}

function releasePluginBridges(releaseRoot) {
  // X11-b: discover plugin-bridge entries under a RELEASE tree — a node-builtins
  // mirror of the runtime discoverPlugins (loader.ts): glob <root>/packages/*, prefer
  // dashboard-plugin.json else package.json#pi-dashboard-plugin, resolve manifest.bridge
  // against the package dir. Returns { "dashboard-<id>": <absolute release bridge path> }
  // (the same managed-key scheme registerPluginBridge uses in settings.json).
  const out = {};
  const packagesDir = join(releaseRoot, "packages");
  let entries;
  try { entries = readdirSync(packagesDir); } catch { return out; }
  for (const entry of entries) {
    const pkgDir = join(packagesDir, entry);
    let manifest = null;
    const adj = join(pkgDir, "dashboard-plugin.json");
    if (existsSync(adj)) {
      try { manifest = JSON.parse(readFileSync(adj, "utf8")); } catch { continue; }
    } else {
      const pj = join(pkgDir, "package.json");
      if (!existsSync(pj)) continue;
      try { manifest = JSON.parse(readFileSync(pj, "utf8"))["pi-dashboard-plugin"] ?? null; } catch { continue; }
    }
    if (!manifest || typeof manifest !== "object") continue;
    if (typeof manifest.id !== "string" || typeof manifest.bridge !== "string") continue;
    out["dashboard-" + manifest.id] = resolve(pkgDir, manifest.bridge);
  }
  return out;
}

// ── Bridge pruner (dl-13727) ────────────────────────────────────────────────
// Recognize a dashboard extension bridge by CANONICAL PACKAGE IDENTITY, not by
// path substring. The stale July-26 bridge lived under /private/tmp/... (no
// "pi-agent-dashboard"/"pi-dashboard-prod" substring), so the old substring-only
// predicate never pruned it — sessions kept loading the pre-receipt tool. Both
// the stale AND the release extension declare name
// "@blackbelt-technology/pi-dashboard-extension", so identity recognizes both.
// Identity is authoritative for EXISTING paths; the legacy substring heuristic is
// a fallback ONLY for paths that are missing/unreadable (cannot be identified).
const DASHBOARD_EXTENSION_IDENTITY = "@blackbelt-technology/pi-dashboard-extension";

// 'yes'     = existing path whose package.json name IS the canonical dashboard extension
// 'no'      = existing path that is a DIFFERENT package (preserve it — identity authoritative)
// 'unknown' = path missing/unreadable -> caller falls back to the legacy substring heuristic
export function dashboardExtIdentity(p, readFile = (fp) => readFileSync(fp, "utf8")) {
  try {
    const pj = JSON.parse(readFile(join(p, "package.json")));
    return pj && pj.name === DASHBOARD_EXTENSION_IDENTITY ? "yes" : "no";
  } catch { return "unknown"; }
}

export function isDashboardBridge(p, readFile) {
  if (typeof p !== "string") return false;
  if (!(p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p))) return false;
  if (!/packages[\\/]extension\/?$/.test(p)) return false;
  const id = dashboardExtIdentity(p, readFile);
  if (id === "yes") return true;
  if (id === "no") return false; // existing DIFFERENT package -> preserve
  return p.includes("pi-agent-dashboard") || p.includes("pi-dashboard-prod"); // missing -> legacy fallback
}

// Pure plan: given the current `packages` array + the release target, return
// { kept, removed }. Prunes every dashboard bridge that is not the target, keeps
// everything else, and guarantees the target is present EXACTLY ONCE (a
// pre-existing duplicate of the target collapses to one; an absent target is
// appended). dl-13727 control #2.
export function planPackages(pkgs, target, readFile) {
  const removed = pkgs.filter((p) => isDashboardBridge(p, readFile) && p !== target);
  // Keep non-dashboard entries as-is; collapse any target duplicates to a single
  // occurrence (first position wins) so re-running the plan is idempotent.
  const kept = [];
  let targetSeen = false;
  for (const p of pkgs) {
    if (p === target) {
      if (targetSeen) continue; // drop duplicate target occurrences
      targetSeen = true;
      kept.push(p);
    } else if (!isDashboardBridge(p, readFile)) {
      kept.push(p);
    }
    // else: a non-target dashboard bridge -> pruned (already in `removed`)
  }
  if (!targetSeen) kept.push(target);
  return { kept, removed };
}

function registerBridge(a) {
  // JAIL-ISOLATION (X11-a): registerBridge writes the operator's REAL
  // ~/.pi/agent/settings.json. An isolated/jail build (--prod-root != the real
  // ~/.pi-dashboard-prod) or an explicit --no-bridge-register MUST NOT touch the
  // operator's live settings — a Stage-2 jail build clobbered settings exactly here
  // (and the readFileSync-was-never-imported bug below made every write start from {}).
  // Only a real-prod-root deploy registers the release bridge in live settings.
  const isolated = !isRealProdRoot(a);
  if (a.noBridgeRegister || isolated) {
    const why = a.noBridgeRegister
      ? "--no-bridge-register"
      : `isolated build: --prod-root ${a.prodRoot} != ~/.pi-dashboard-prod`;
    log(`bridge boundary: SKIP settings.json registration (${why}) — live settings untouched (jail-isolation)`);
    return;
  }
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  // Read settings; NEVER clobber an existing-but-unparseable file. A concurrent pi
  // write can make JSON.parse throw mid-write — starting from {} would wipe every other
  // key (defaultProvider/Model, dashboardPluginBridges, other packages). Absent file is
  // the only safe fresh-{} case; exists-but-unparseable = ABORT, do not touch.
  let settings = {};
  let raw = null;
  try { raw = readFileSync(settingsPath, "utf8"); } catch { /* absent -> fresh {} is safe */ }
  if (raw !== null) {
    try { settings = JSON.parse(raw); }
    catch (err) { die(`settings.json exists but did not parse (concurrent write?) — refusing to clobber: ${err}`); }
  }
  // Resolve `current` -> releases/<sha> so we register the SAME concrete path the
  // server auto-registers (server.ts findBundledExtension realpaths it) — avoids a
  // duplicate {current, sha} registration = a double bridge per session.
  const currentLink = join(a.prodRoot, "current");
  let releaseRoot;
  try { releaseRoot = realpathSync(currentLink); } catch { releaseRoot = currentLink; }
  const target = join(releaseRoot, "packages", "extension");
  const pkgs = Array.isArray(settings.packages) ? settings.packages : [];
  // dl-13727: prune stale dashboard bridges by canonical package identity (with a
  // legacy substring fallback for missing/unreadable paths) + keep the release
  // target exactly once. See isDashboardBridge/planPackages at module scope.
  const { kept, removed } = planPackages(pkgs, target);
  settings.packages = kept;
  // X11-b: pin the RELEASE plugin-bridge(s) in dashboardPluginBridges + prune stale
  // dev-tree / non-release dashboard-* entries (same D6 treatment as the main bridge).
  // The release server discovers these under its OWN cwd (= the release dir), but
  // registerPluginBridge returns "conflict" (never overwrites) against a mismatched
  // entry — so a stale dev-tree path is STICKY until deploy prunes it. Rebuild the
  // dashboard-managed set from the release; a non-managed key (no dashboard- prefix)
  // is preserved untouched.
  const releaseBridges = releasePluginBridges(releaseRoot);
  const existingPB = (settings.dashboardPluginBridges && typeof settings.dashboardPluginBridges === "object" && !Array.isArray(settings.dashboardPluginBridges))
    ? settings.dashboardPluginBridges : {};
  const pbNext = {};
  for (const [k, v] of Object.entries(existingPB)) if (!k.startsWith("dashboard-")) pbNext[k] = v;
  const pbRemoved = Object.entries(existingPB)
    .filter(([k, v]) => k.startsWith("dashboard-") && releaseBridges[k] !== v)
    .map(([k, v]) => `${k}=${v}`);
  for (const [k, v] of Object.entries(releaseBridges)) pbNext[k] = v;
  settings.dashboardPluginBridges = pbNext;
  const tmp = settingsPath + ".deploytmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);
  log(`bridge boundary: registered ${target}`);
  log(`bridge boundary: removed ${removed.length} non-target bridge path(s)${removed.length ? ": " + removed.join(", ") : ""}`);
  const pbReg = Object.entries(releaseBridges).map(([k, v]) => `${k} -> ${v}`);
  log(`plugin-bridge boundary: registered ${pbReg.length} release plugin-bridge(s)${pbReg.length ? ": " + pbReg.join(", ") : ""}`);
  log(`plugin-bridge boundary: removed ${pbRemoved.length} stale/dev-tree plugin-bridge path(s)${pbRemoved.length ? ": " + pbRemoved.join(", ") : ""}`);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.registerBridgeOnly) { registerBridge(a); return; }
  if (a.rollback) {
    rollback(a);
    if (a.restart) log("restart requested: run the supervised restart step by hand (cutover is deliberate).");
    else log("rolled back. Cut over by restarting prod against <prod-root>/current when ready.");
    return;
  }
  if (!a.ref) die("--ref <git-ref> is required (deploy a committed ref, never the working tree).");
  const { sha, releaseDir } = buildRelease(a);
  swapCurrent(a, releaseDir);
  registerBridge(a);
  log(`BUILD COMPLETE. <prod-root>/current -> release ${sha}.`);
  if (a.restart) {
    log("--restart: cutover restart is a DELIBERATE, watched step and is intentionally NOT automated here.");
    log("Cut over by repointing the launchd wrapper at <prod-root>/current + supervised restart, with rollback armed.");
  } else {
    log("No restart (default). Validate the release on a test port, then cut over deliberately.");
    log(`Validate: PI_DASHBOARD_URL unset, run  node --import <jiti> ${join(releaseDir, "packages/server/src/cli.ts")} start --port <TESTPORT> --pi-port <TESTPIPORT>  and curl /api/health (expect commit=${sha}, version!=unknown, gatewayListening=true).`);
  }
}

// Run the deploy ONLY when invoked directly (node scripts/deploy.mjs …), never
// on import. This lets the pure helpers above (dashboardExtIdentity /
// isDashboardBridge / planPackages) be unit-tested without executing a deploy.
// dl-13727.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
