/**
 * audience-registry — the dashboard-SERVER's thin FS wrapper around the vendored
 * pure audience-core (door-3 build-item-2). Owns ONLY the impure part the core
 * leaves to the caller: the FS read of `~/.pi/orchestration-state/role-registry.json`,
 * a short-TTL cache, and a COARSE watch (once per registry-CHANGE, not per message).
 *
 * The audience derivation itself lives in the vendored core
 * (`deriveAudienceFromEnv` / `classifyLoad` / `hasUiFromSource`) — single source,
 * anti-drift with the pi-operator-voice extension, guarded by the golden corpus.
 *
 * registry-refresh (Bert's ratified fold): on a registry CHANGE the cache is
 * invalidated and callers re-derive `audience` for sessions going FORWARD
 * (future messages only — NOT retroactive; already-rendered rows are not
 * retro-held). This lets a standing-crew session established under a partial/
 * stale/unreadable registry self-correct `unknown \u2192 operator` once the registry
 * completes. Coarse + cheap by design.
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  classifyLoad,
  deriveAudienceFromEnv,
  hasUiFromSource,
  type Audience,
  type RegistryLoadResult,
} from "@blackbelt-technology/pi-dashboard-shared/vendor/operator-voice-audience/audience-core.js";

/** Canonical registry path (the NOS §16 sister role-registry). */
export const ROLE_REGISTRY_PATH = join(os.homedir(), ".pi", "orchestration-state", "role-registry.json");

/** Short cache TTL — one scan reuses a single read across many sessions. */
export const DEFAULT_REGISTRY_TTL_MS = 5000;

export interface AudienceRegistry {
  /** The cached, classified registry load; re-reads once the TTL lapses. */
  getRegistryLoad(nowMs?: number): RegistryLoadResult;
  /** Derive a session's audience from its `name` + `source` via the vendored core. */
  deriveSessionAudience(name: string | undefined, source: string | undefined, nowMs?: number): Audience;
  /** Drop the cache (fired on a registry-CHANGE watch event). */
  invalidate(): void;
  /** Coarse watch: fire `onChange` once per registry-CHANGE (invalidates first). */
  startWatch(onChange: () => void): void;
  stopWatch(): void;
}

export interface AudienceRegistryOptions {
  registryPath?: string;
  ttlMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injected reader (tests). A throw is treated as an unreadable registry. */
  readFile?: (path: string) => string;
}

export function createAudienceRegistry(opts: AudienceRegistryOptions = {}): AudienceRegistry {
  const registryPath = opts.registryPath ?? ROLE_REGISTRY_PATH;
  const ttlMs = opts.ttlMs ?? DEFAULT_REGISTRY_TTL_MS;
  const clock = opts.now ?? Date.now;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let cached: RegistryLoadResult | undefined;
  let cachedAt = 0;
  let watcher: FSWatcher | undefined;

  function readAndClassify(nowMs: number): RegistryLoadResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(registryPath));
    } catch {
      // Missing / unreadable / parse-failure \u2192 classifyLoad(null) = "unreadable"
      // (EMPTY_IDENTITY \u2192 even a standing member classifies `unknown`, which then
      // HOLDS per the unknown fail-open \u2014 the ratified safe direction).
      parsed = null;
    }
    return classifyLoad(parsed, nowMs);
  }

  function getRegistryLoad(nowMs: number = clock()): RegistryLoadResult {
    if (cached && nowMs - cachedAt < ttlMs) return cached;
    cached = readAndClassify(nowMs);
    cachedAt = nowMs;
    return cached;
  }

  function deriveSessionAudience(
    name: string | undefined,
    source: string | undefined,
    nowMs: number = clock(),
  ): Audience {
    // hasUI is consulted by the core ONLY on the unset-name (operator's own pane)
    // branch; a NAMED session ignores it. INTERACTIVE_SOURCES = {tui,terminal,zed}.
    return deriveAudienceFromEnv({ PI_AGENT_NAME: name }, hasUiFromSource(source), getRegistryLoad(nowMs));
  }

  function invalidate(): void {
    cached = undefined;
    cachedAt = 0;
  }

  function startWatch(onChange: () => void): void {
    if (watcher) return;
    try {
      watcher = watch(registryPath, () => {
        invalidate();
        onChange();
      });
    } catch {
      // The registry file may not exist yet; a later create won't be watched, but
      // the TTL re-read still picks up content once present. Coarse + cheap.
    }
  }

  function stopWatch(): void {
    watcher?.close();
    watcher = undefined;
  }

  return { getRegistryLoad, deriveSessionAudience, invalidate, startWatch, stopWatch };
}

/** Production singleton — lazily reads the real registry path + caches. */
export const audienceRegistry = createAudienceRegistry();
