/**
 * Plugin bridge entry management in pi's settings.json.
 *
 * Manages `dashboard-<plugin-id>` keys in a dedicated
 * `dashboardPluginBridges` object inside settings.json.
 *
 * Rules:
 * - Only touches entries under the `dashboardPluginBridges` key.
 * - NEVER modifies user-owned `packages[]` entries.
 * - Uses atomic write (tmp + rename) for all updates.
 * - Detects path conflicts (existing entry with mismatched path).
 */
import path from "node:path";
import os from "node:os";
import { readSettingsOrThrow, atomicWriteSettings, SettingsUnparseableError } from "./settings-io.js";

export interface PluginBridgeRegisterOptions {
  homedir?: string;
}

export type PluginBridgeConflict =
  | { type: "ok" }
  | { type: "conflict"; existingPath: string; newPath: string }
  | { type: "skipped"; reason: string };

function getSettingsPath(homedir?: string): string {
  const home = homedir ?? process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".pi", "agent", "settings.json");
}

// Delegates to the canonical strict reader (settings-io): absent/empty → {},
// but an existing-yet-UNPARSEABLE settings.json THROWS SettingsUnparseableError
// instead of returning {} (the mode-I clobber fix). Every caller below catches
// it and SKIPS the write, so a concurrent/partial write is never overwritten
// with a fresh object.
function readSettings(settingsPath: string): Record<string, unknown> {
  return readSettingsOrThrow(settingsPath);
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  // Atomic write (unique temp + fsync + rename) via the canonical writer.
  atomicWriteSettings(settingsPath, settings);
}

function getManagedBridges(
  settings: Record<string, unknown>,
): Record<string, string> {
  const val = settings.dashboardPluginBridges;
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, string>;
  }
  return {};
}

const MANAGED_PREFIX = "dashboard-";

/**
 * Register a plugin's bridge entry in pi's settings.json.
 *
 * Returns { type: "conflict", existingPath, newPath } if a
 * `dashboard-<pluginId>` key already exists but points to a different path.
 * In that case the settings.json is NOT modified.
 *
 * Returns { type: "ok" } on success (including when the entry already matches).
 */
export function registerPluginBridge(
  pluginId: string,
  bridgePath: string,
  opts: PluginBridgeRegisterOptions = {},
): PluginBridgeConflict {
  const settingsPath = getSettingsPath(opts.homedir);
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if (err instanceof SettingsUnparseableError) {
      console.error(
        `[plugin-bridge] settings.json unparseable — SKIPPING registration of "${pluginId}" to avoid clobbering it: ${err.message}`,
      );
      return { type: "skipped", reason: err.message };
    }
    throw err;
  }
  const managed = getManagedBridges(settings);
  const key = MANAGED_PREFIX + pluginId;

  const existing = managed[key];
  if (existing) {
    if (existing === bridgePath) return { type: "ok" }; // already registered
    return { type: "conflict", existingPath: existing, newPath: bridgePath };
  }

  managed[key] = bridgePath;
  settings.dashboardPluginBridges = managed;
  writeSettings(settingsPath, settings);
  console.info(`[plugin-bridge] Registered bridge for plugin "${pluginId}": ${bridgePath}`);
  return { type: "ok" };
}

/**
 * Remove a plugin's bridge entry from pi's settings.json.
 * No-op if the entry does not exist.
 * NEVER touches entries without the `dashboard-` prefix.
 */
export function deregisterPluginBridge(
  pluginId: string,
  opts: PluginBridgeRegisterOptions = {},
): void {
  const settingsPath = getSettingsPath(opts.homedir);
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    if (err instanceof SettingsUnparseableError) {
      console.error(
        `[plugin-bridge] settings.json unparseable — SKIPPING deregistration of "${pluginId}" to avoid clobbering it: ${err.message}`,
      );
      return;
    }
    throw err;
  }
  const managed = getManagedBridges(settings);
  const key = MANAGED_PREFIX + pluginId;

  if (!(key in managed)) return; // nothing to remove

  delete managed[key];
  settings.dashboardPluginBridges = managed;
  writeSettings(settingsPath, settings);
  console.info(`[plugin-bridge] Deregistered bridge for plugin "${pluginId}"`);
}

/**
 * Register all plugins with bridge entries from the discovery list.
 * Returns a map of pluginId → conflict/ok result.
 * Plugins with conflicts are NOT registered; caller should surface via /api/health.
 */
export function registerAllPluginBridges(
  plugins: Array<{ pluginId: string; bridgePath: string }>,
  opts: PluginBridgeRegisterOptions = {},
): Record<string, PluginBridgeConflict> {
  const results: Record<string, PluginBridgeConflict> = {};
  for (const { pluginId, bridgePath } of plugins) {
    // Boot-safety: this runs UNWRAPPED at server.ts start(); a single plugin's
    // registration failure (unparseable settings, write error) must never crash
    // server boot. Log loud + mark skipped, never clobber, never throw upward.
    try {
      results[pluginId] = registerPluginBridge(pluginId, bridgePath, opts);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[plugin-bridge] registration failed for "${pluginId}" (non-fatal, skipped): ${reason}`);
      results[pluginId] = { type: "skipped", reason };
    }
  }
  return results;
}

/**
 * List all currently managed plugin bridge entries.
 */
export function listManagedBridges(
  opts: PluginBridgeRegisterOptions = {},
): Record<string, string> {
  const settingsPath = getSettingsPath(opts.homedir);
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    console.error(
      `[plugin-bridge] settings.json unparseable — listing zero managed bridges: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  return getManagedBridges(settings);
}
