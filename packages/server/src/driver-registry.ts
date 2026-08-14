/**
 * driver-registry — the dashboard-SERVER's thin FS wrapper around the driver
 * registry at `~/.pi/orchestration-state/cell-driver-registry.json`, which
 * `spawn-driver` writes at spawn. Sister of `audience-registry.ts`: same shape
 * (FS read + short-TTL cache + a COARSE change-watch that invalidates), same
 * degrade-never-throw posture.
 *
 * Why it exists: the sidebar's `classifyTier` inferred driver-ness from `cwd`
 * (`nos-cells/` or a `-driver` path segment) and from a compound-PascalCase
 * name regex. Both are proxies. Drivers are spawned into ARBITRARY working
 * directories and are often named with a single capital (`Seatwright`), so
 * live drivers fell through to the `other` bucket. The registry is the
 * authoritative signal and is consulted here instead of guessed at.
 *
 * registry-refresh: on a registry CHANGE the cache is invalidated and callers
 * re-derive `isRegisteredDriver` for known sessions, so a session that
 * registered BEFORE its registry row was written self-corrects. Coarse + cheap,
 * mirroring the audience-registry fold.
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ExternalSessionDriver } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

/** Canonical registry path (the NOS §19 driver/cell registry). */
export const DRIVER_REGISTRY_PATH = join(
  os.homedir(),
  ".pi",
  "orchestration-state",
  "cell-driver-registry.json",
);

/** Short cache TTL — one scan reuses a single read across many sessions. */
export const DEFAULT_DRIVER_REGISTRY_TTL_MS = 5000;

/**
 * Candidate lookup keys for a session name, most-specific first.
 *
 * A live driver's dashboard name often carries a mesh status-string suffix
 * (`Docket-2 — HOLD-WARM (Joan-directed…)`, `Stage2Architect — Stage-2 DONE…`
 * — both measured own-hand against the running dashboard, both registered
 * drivers). The identity is the leading segment before the " — " separator, so
 * exact-match alone would miss them. Only the em-dash separator is handled:
 * that is the shape that actually occurs, and the standing-crew name regex in
 * `session-grouping.ts` already keys on the same one.
 *
 * Pure — exported for tests.
 */
export function driverLookupKeys(name: string | undefined): string[] {
  if (!name) return [];
  const trimmed = name.trim();
  if (trimmed === "") return [];
  const keys = [trimmed.toLowerCase()];
  const sepIdx = trimmed.indexOf(" — ");
  if (sepIdx > 0) {
    const head = trimmed.slice(0, sepIdx).trim().toLowerCase();
    if (head !== "" && head !== keys[0]) keys.push(head);
  }
  return keys;
}

/**
 * Index every name the registry knows, lowercased + trimmed.
 *
 * Indexes the row KEY (always equal to `real_name` in the live registry, but
 * both are read so a divergent row still resolves) plus `tmux`, which differs
 * from the key on a handful of rows (`Docket` → tmux `Docket-5`, `Harry` →
 * `harry-live-20`). Rows are indexed regardless of `state`: a driver that
 * ended is still a driver, and `Docket-2` is `state=ended` in the registry
 * while its session is live on the dashboard right now — an alive-only index
 * would miss it, and a dead driver dropping back into `other` is the same
 * defect this fixes.
 *
 * Pure — exported for tests.
 */
export function indexDriverNames(parsed: unknown): Set<string> {
  const names = new Set<string>();
  const drivers = (parsed as { drivers?: unknown } | null)?.drivers;
  if (drivers === null || typeof drivers !== "object") return names;

  const add = (v: unknown): void => {
    if (typeof v !== "string") return;
    const key = v.trim().toLowerCase();
    if (key !== "") names.add(key);
  };

  for (const [key, row] of Object.entries(drivers as Record<string, unknown>)) {
    add(key);
    if (row !== null && typeof row === "object") {
      const r = row as { real_name?: unknown; tmux?: unknown };
      add(r.real_name);
      add(r.tmux);
    }
  }
  return names;
}

function indexCellDrivers(parsed: unknown): ExternalSessionDriver[] {
  const drivers = (parsed as { drivers?: unknown } | null)?.drivers;
  if (drivers === null || typeof drivers !== "object" || Array.isArray(drivers)) return [];

  const result: ExternalSessionDriver[] = [];
  for (const row of Object.values(drivers as Record<string, unknown>)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as { real_name?: unknown; tmux?: unknown; cell?: unknown };
    if (typeof record.real_name !== "string" || record.real_name.trim() === "") continue;
    result.push({
      realName: record.real_name.trim(),
      tmux:
        typeof record.tmux === "string" && record.tmux.trim() !== ""
          ? record.tmux.trim()
          : null,
      cell:
        typeof record.cell === "string" && record.cell.trim() !== ""
          ? record.cell.trim()
          : null,
    });
  }
  return result;
}

interface DriverRegistrySnapshot {
  names: Set<string>;
  drivers: ExternalSessionDriver[];
}

export interface DriverRegistry {
  /** The cached name index; re-reads once the TTL lapses. Empty when unreadable. */
  getDriverNames(nowMs?: number): ReadonlySet<string>;
  /** Canonical driver records from the same cached registry snapshot. */
  getCellDrivers(nowMs?: number): ExternalSessionDriver[];
  /** Whether `name` is a registered driver. `false` on a missing/unreadable registry. */
  isRegisteredDriver(name: string | undefined, nowMs?: number): boolean;
  /** Drop the cache (fired on a registry-CHANGE watch event). */
  invalidate(): void;
  /** Coarse watch: fire `onChange` once per registry-CHANGE (invalidates first). */
  startWatch(onChange: () => void): void;
  stopWatch(): void;
}

export interface DriverRegistryOptions {
  registryPath?: string;
  ttlMs?: number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Injected reader (tests). A throw is treated as an unreadable registry. */
  readFile?: (path: string) => string;
}

export function createDriverRegistry(opts: DriverRegistryOptions = {}): DriverRegistry {
  const registryPath = opts.registryPath ?? DRIVER_REGISTRY_PATH;
  const ttlMs = opts.ttlMs ?? DEFAULT_DRIVER_REGISTRY_TTL_MS;
  const clock = opts.now ?? Date.now;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let cached: DriverRegistrySnapshot | undefined;
  let cachedAt = 0;
  let watcher: FSWatcher | undefined;

  function readAndIndex(): DriverRegistrySnapshot {
    try {
      const parsed = JSON.parse(readFile(registryPath));
      return { names: indexDriverNames(parsed), drivers: indexCellDrivers(parsed) };
    } catch {
      // Missing / unreadable / parse-failure → empty index → every session
      // reports `false` and the cwd/name heuristics in `classifyTier` still
      // apply. Degrade to today's behaviour; never throw.
      return { names: new Set<string>(), drivers: [] };
    }
  }

  function getSnapshot(nowMs: number): DriverRegistrySnapshot {
    if (cached && nowMs - cachedAt < ttlMs) return cached;
    cached = readAndIndex();
    cachedAt = nowMs;
    return cached;
  }

  function getDriverNames(nowMs: number = clock()): ReadonlySet<string> {
    return getSnapshot(nowMs).names;
  }

  function getCellDrivers(nowMs: number = clock()): ExternalSessionDriver[] {
    return getSnapshot(nowMs).drivers;
  }

  function isRegisteredDriver(name: string | undefined, nowMs: number = clock()): boolean {
    const keys = driverLookupKeys(name);
    if (keys.length === 0) return false;
    const known = getDriverNames(nowMs);
    return keys.some((k) => known.has(k));
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
      // The registry may not exist yet; a later create won't be watched, but the
      // TTL re-read still picks up content once present. Coarse + cheap.
    }
  }

  function stopWatch(): void {
    watcher?.close();
    watcher = undefined;
  }

  return {
    getDriverNames,
    getCellDrivers,
    isRegisteredDriver,
    invalidate,
    startWatch,
    stopWatch,
  };
}

/** Production singleton — lazily reads the real registry path + caches. */
export const driverRegistry = createDriverRegistry();
