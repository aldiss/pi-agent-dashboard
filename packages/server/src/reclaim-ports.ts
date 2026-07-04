/**
 * Reclaim-on-start (Stage-2 (a)/(d)) — the single-identity supervisor's port guard.
 *
 * THE WITNESSED ZOMBIE (2026-07-04 rollback, dl-4551): `launchctl unload`
 * orphaned the grandchild listener, which KEPT :8000/:9999; the reload's
 * listener then EADDRINUSE'd → was suppressed → two server trees. Root cause: a
 * respawn had NO port-holder reclaim (that safety net existed only in cmdStop,
 * and restart-helper read a non-existent dashboard.pid).
 *
 * THE FIX: BEFORE binding, resolve who actually holds the port — an external OS
 * fact (`lsof -sTCP:LISTEN`, sister to driver-liveness "trust the port, not the
 * indirected handle") — kill that orphan AND its process group (the launchd
 * wrapper / node launcher / jiti listener / rotate-logger all share one PGID, so
 * a GROUP kill reaps the whole tree cleanly), verify the port is free, THEN
 * bind. This makes every future restart wedge-proof regardless of the
 * wrapper↔listener identity split.
 */
import {
  findPortHolders as platformFindPortHolders,
  isProcessAlive as platformIsProcessAlive,
  killPidWithGroup as platformKillPidWithGroup,
  killProcess as platformKillProcess,
} from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { execSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";

export interface ReclaimDeps {
  /** LISTEN-holders of a port (default: platform lsof/netstat). */
  findHolders?: (port: number) => number[];
  /** Liveness probe (default: kill-0). */
  isAlive?: (pid: number) => boolean;
  /** Group signal to `-pgid` (default: platform killPidWithGroup). */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  /** Direct pid kill SIGTERM→SIGKILL (default: platform killProcess). */
  killPid?: (pid: number) => Promise<void>;
  /** Exec for `ps -o pgid=` (default: platform execSync). */
  exec?: (cmd: string) => string;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Our own pid — never reclaim ourselves (default process.pid). */
  self?: number;
  /** SIGTERM→SIGKILL grace per holder (default 2000ms). */
  graceMs?: number;
}

export interface ReclaimResult {
  port: number;
  reclaimed: number[];
  freed: boolean;
}

/** Resolve a pid's process-group id via `ps -o pgid=`. Null on any failure. */
export function resolvePgid(pid: number, exec: (cmd: string) => string): number | null {
  try {
    const out = exec(`ps -o pgid= -p ${pid}`).trim();
    const pgid = parseInt(out, 10);
    return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

interface ResolvedDeps {
  isAlive: (pid: number) => boolean;
  killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  killPid: (pid: number) => Promise<void>;
  exec: (cmd: string) => string;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  ownPgid: number | null;
  graceMs: number;
}

/**
 * Kill an orphan port-holder + its process group. Resolve the PGID, SIGTERM the
 * group, wait, SIGKILL the group if still alive; if the PGID cannot be resolved
 * (or matches OUR group — a defensive guard), fall back to a direct pid kill of
 * just the holder so we never signal our own tree.
 */
async function killHolderAndGroup(pid: number, deps: ResolvedDeps): Promise<void> {
  const { exec, isAlive, sleep, log, killGroup, killPid, ownPgid, graceMs } = deps;
  const pgid = resolvePgid(pid, exec);

  if (pgid === null || (ownPgid !== null && pgid === ownPgid)) {
    if (pgid !== null) {
      log(`[reclaim] pid ${pid} shares our process group ${pgid} — direct-killing just the holder`);
    }
    await killPid(pid); // SIGTERM→SIGKILL, single pid only
    return;
  }

  try {
    killGroup(pgid, "SIGTERM");
  } catch {
    /* group may already be gone */
  }
  const steps = Math.ceil(graceMs / 100);
  for (let i = 0; i < steps; i++) {
    await sleep(100);
    if (!isAlive(pid)) return;
  }
  try {
    killGroup(pgid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(150);
  // Last resort: the listener survived the group kill — kill the pid directly.
  if (isAlive(pid)) await killPid(pid);
}

/**
 * Reclaim-on-start. For each port, kill any orphan LISTEN-holder (+ its group)
 * that is not us, then VERIFY the port is free. Throws if a port is still held
 * after reclaim — the caller MUST fail loud (never silently bind-race into a
 * zombie); the supervisor then restarts and reclaims again.
 */
export async function reclaimPorts(ports: number[], deps: ReclaimDeps = {}): Promise<ReclaimResult[]> {
  const findHolders = deps.findHolders ?? ((p) => platformFindPortHolders(p));
  const isAlive = deps.isAlive ?? ((pid) => platformIsProcessAlive(pid));
  const killGroup = deps.killGroup ?? ((pgid, sig) => platformKillPidWithGroup(pgid, sig));
  const killPid =
    deps.killPid ??
    (async (pid) => {
      await platformKillProcess(pid);
    });
  const exec = deps.exec ?? ((cmd) => execSync(cmd, { encoding: "utf-8" }) as unknown as string);
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m) => console.error(m));
  const self = deps.self ?? process.pid;
  const graceMs = deps.graceMs ?? 2000;
  const ownPgid = resolvePgid(self, exec);

  const resolved: ResolvedDeps = { isAlive, killGroup, killPid, exec, sleep, log, ownPgid, graceMs };
  const results: ReclaimResult[] = [];

  for (const port of ports) {
    const holders = findHolders(port).filter((h) => h !== self);
    const reclaimed: number[] = [];
    for (const holder of holders) {
      log(`[reclaim] :${port} held by orphan pid ${holder} — reclaiming (kill-by-group)`);
      await killHolderAndGroup(holder, resolved);
      reclaimed.push(holder);
    }
    const stillHeld = findHolders(port).filter((h) => h !== self);
    if (stillHeld.length > 0) {
      throw new Error(
        `[reclaim] :${port} STILL held after reclaim by pid(s) ${stillHeld.join(", ")} — refusing to bind (fail loud)`,
      );
    }
    if (reclaimed.length) log(`[reclaim] :${port} reclaimed + verified free (killed ${reclaimed.join(", ")})`);
    results.push({ port, reclaimed, freed: true });
  }
  return results;
}
