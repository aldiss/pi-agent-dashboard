/**
 * Shared bridge extension registration for pi's settings.json.
 * Used by both the server and Electron app to register the dashboard
 * bridge extension so pi sessions can discover and load it.
 *
 * Single source of truth — replaces the near-identical implementations
 * in packages/server/src/extension-register.ts and
 * packages/electron/src/lib/bridge-register.ts.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { readSettingsOrThrow, atomicWriteSettings } from "./settings-io.js";

/**
 * Check that a candidate path is a valid, stable extension directory.
 * Returns true when the directory exists, contains a package.json, and
 * is NOT under /tmp/.mount_* (unstable AppImage mount).
 */
function isValidExtensionPath(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  if (!fs.existsSync(path.join(candidate, "package.json"))) return false;
  if (candidate.includes("/tmp/.mount_")) {
    console.warn(
      "[dashboard] AppImage detected — extension path is temporary, skipping registration:",
      candidate,
    );
    return false;
  }
  return true;
}

/**
 * Optional dependency injection for `findBundledExtension`. Tests pass
 * `{ resolvePackage: () => null }` to disable the node-resolver fallback.
 */
export interface FindExtensionDeps {
  /**
   * Resolve `@blackbelt-technology/pi-dashboard-extension/package.json`
   * via Node's module resolver. Return the absolute package.json path
   * or null. Defaults to `createRequire(import.meta.url).resolve(...)`.
   */
  resolvePackage?: () => string | null;
}

function defaultResolvePackage(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve("@blackbelt-technology/pi-dashboard-extension/package.json");
  } catch {
    return null;
  }
}

/**
 * Find the bundled extension directory.
 *
 * Resolution order:
 *   1. Monorepo layout: `<baseDir>/packages/extension/`.
 *   2. Node module resolution: `@blackbelt-technology/pi-dashboard-extension/package.json`
 *      via `require.resolve` from this module. Works in ANY install layout
 *      (flat `node_modules/`, scoped, nested, pnpm, npm-g). This is the
 *      canonical identity-based lookup and the only reliable strategy
 *      when pi-dashboard is installed via `npm i -g`.
 *
 * Returns null if both strategies fail, the resolved directory doesn't
 * have a package.json, or the path is under /tmp/.mount_* (AppImage).
 *
 * See change: unified-bootstrap-install.
 */
export function findBundledExtension(
  baseDir: string,
  deps: FindExtensionDeps = {},
): string | null {
  // Strategy 1: monorepo sibling layout.
  const monorepoCandidate = path.resolve(baseDir, "packages", "extension");
  if (isValidExtensionPath(monorepoCandidate)) return monorepoCandidate;

  // Strategy 2: Node module resolver. This works for the `npm i -g
  // pi-dashboard` layout where the extension is shipped as a runtime dep
  // of pi-dashboard-server.
  const resolver = deps.resolvePackage ?? defaultResolvePackage;
  const extPkgJson = resolver();
  if (extPkgJson) {
    const extDir = path.dirname(extPkgJson);
    if (isValidExtensionPath(extDir)) return extDir;
  }

  return null;
}

/** Optional overrides for testing / multi-HOME scenarios. */
export interface BridgeRegisterOptions {
  /**
   * Override the HOME used to locate settings.json. When omitted,
   * falls back to `$HOME || $USERPROFILE || os.homedir()` (existing behavior).
   */
  homedir?: string;
}

/**
 * Register an extension path in pi's settings.json packages array.
 *
 * Non-destructive cleanup: only removes dashboard-related paths
 * that point to non-existent directories or directories without package.json.
 * Existing valid registrations (dev, global, other bundled) are preserved.
 *
 * No-op if the path is already registered.
 */
export function registerBridgeExtension(
  extensionPath: string,
  opts: BridgeRegisterOptions = {},
): void {
  // Compute at call time so tests can override HOME
  const home = opts.homedir
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? os.homedir();
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");

  // Read STRICTLY (mode-I clobber fix): absent/empty settings.json → a fresh
  // `{}` is legitimate, but an existing-yet-UNPARSEABLE settings.json THROWS
  // (SettingsUnparseableError) instead of starting from `{}`. A concurrent or
  // partial write must NEVER be overwritten with a fresh object — that is the
  // clobber that erased provider/model/thinking/pluginBridges/workflows keys.
  // Both callers are wrapped (cli.ts bootstrap try/catch → bridgeRegistrationError;
  // server.ts try/catch → loud log + continue), so the throw is surfaced, not fatal.
  const settings = readSettingsOrThrow(settingsPath);

  const packages = Array.isArray(settings.packages) ? settings.packages as string[] : [];

  // Already registered?
  if (packages.includes(extensionPath)) return;

  // Non-destructive cleanup: only remove broken dashboard paths
  const cleaned = packages.filter((p) => {
    if (typeof p !== "string") return true;
    const isLocalPath = p.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(p);
    if (!isLocalPath) return true;
    // Only consider dashboard-related paths for cleanup
    // Normalize: lowercase + collapse spaces/hyphens so "PI Dashboard" matches "pi-dashboard"
    const normalized = p.toLowerCase().replace(/[\s_-]/g, "");
    if (!normalized.includes("pidashboard") && !normalized.includes("piagentdashboard")) return true;
    // Keep paths that point to existing directories with a package.json
    try {
      return fs.existsSync(p) && fs.existsSync(path.join(p, "package.json"));
    } catch {
      return false; // Can't check — treat as stale
    }
  });

  cleaned.push(extensionPath);
  settings.packages = cleaned;

  // Atomic write (unique temp + fsync + rename) via the canonical settings
  // writer — never a bare writeFileSync, never a fixed-name temp that races.
  atomicWriteSettings(settingsPath, settings);
  console.log(`[dashboard] Registered bridge extension in pi settings: ${extensionPath}`);
}
