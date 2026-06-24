/**
 * Driver liveness resolution (Track 4, Fix L — false-ended-while-alive fix).
 *
 * The bug: `session-bootstrap.ts` restore() hard-codes every reconstructed
 * session to `status:"ended", hidden:true` on server (re)start, with NO
 * liveness check. A live pi/tmux driver whose dashboard server restarted (or
 * whose WS disconnected) is therefore false-marked ended and hidden — it
 * vanishes from the default list while its process is still alive. Empirically
 * 4/15 live mesh drivers were false-ended at one sample (Faye/Lane/Perf/Rusty).
 *
 * The truth-source (Bert d20, dl-1744 + dl-1758, empirically sealed dl-1761):
 * `kill -0` on a live pid is the ONLY ground-truth — a cached status or a
 * heartbeat snapshot mis-calls the dynamic false-ended set (busy drivers get
 * rescued, quiet-but-alive drivers like Don stay ghosted; heartbeat-freshness
 * would false-NEGATIVE the quiet ones). The pid lives in the MESSENGER registry
 * (`~/.pi/agent/messenger/registry/<Name>.json`), keyed by name, carrying
 * `pid` + `sessionId`. The bind is UUID-keyed: registry `sessionId === session.id`.
 *
 * Mechanism: registry-first → for the discovered session, find the registry
 * entry whose `sessionId === session.id` → `kill -0` its pid → if alive, the
 * session is LIVE (restore active/visible + the registry's clean name); else
 * keep ended+hidden.
 *
 * - C2 (pid-reuse guard): the `sessionId === id` UUID-match scopes the pid
 *   tightly — a recycled pid only false-positives if it ALSO carries the exact
 *   matching sessionId, which it won't. (v1.1 hardening, not built: process
 *   start-time vs session.startedAt cross-check.)
 * - C3 (heartbeat is display-only): liveness is decided by `kill -0`, NEVER by
 *   the registry's `activity.lastActivityAt`. The dynamic false-ended set is
 *   exactly why a heartbeat snapshot is insufficient.
 * - Source-scope: callers apply this ONLY to pi/tmux drivers
 *   (`source !== "claude-code"`). CC sessions are correctly ended+hidden
 *   (read-only historical views) and must NOT be resurrected.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DriverLiveness {
  /** True iff a messenger-registry entry binds by sessionId AND its pid is kill-0 alive. */
  alive: boolean;
  /** The registry's clean themed-name (e.g. "Don") when alive — overrides the stale session_info name. */
  name?: string;
}

/** Canonical messenger-registry dir. Overridable for tests via PI_MESSENGER_REGISTRY_DIR. */
export function messengerRegistryDir(): string {
  return process.env.PI_MESSENGER_REGISTRY_DIR || join(homedir(), ".pi", "agent", "messenger", "registry");
}

/** kill(pid, 0): true iff the process exists and is signalable (alive). Reuse-scoped by the caller's sessionId match. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return err?.code === "EPERM";
  }
}

/**
 * Resolve whether the discovered session id corresponds to a LIVE driver, via
 * the messenger registry UUID-join + kill -0. Returns `{alive:false}` on any
 * miss (no registry, no sessionId match, dead pid) — fail-safe to the existing
 * ended+hidden default.
 */
export function resolveDriverLiveness(sessionId: string): DriverLiveness {
  if (!sessionId) return { alive: false };
  let files: string[];
  try {
    files = readdirSync(messengerRegistryDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return { alive: false }; // no registry dir → nothing to bind; keep the ended default
  }
  for (const file of files) {
    let entry: any;
    try {
      entry = JSON.parse(readFileSync(join(messengerRegistryDir(), file), "utf8"));
    } catch {
      continue; // skip an unreadable/partial registry file
    }
    if (entry?.sessionId === sessionId) {
      // UUID-join hit. kill -0 the pid (C2: the sessionId match scopes pid-reuse).
      if (typeof entry.pid === "number" && pidAlive(entry.pid)) {
        return { alive: true, name: typeof entry.name === "string" ? entry.name : undefined };
      }
      return { alive: false }; // bound but dead → genuinely ended
    }
  }
  return { alive: false }; // no entry binds this session id → not a live mesh driver
}

/**
 * Batched liveness resolver — reads the messenger registry directory ONCE and
 * returns a closure that resolves any number of session ids against that single
 * snapshot. Semantically identical to calling `resolveDriverLiveness(id)` per id
 * (same UUID-join + kill-0, same C2/C3 guards, same fail-safe-to-ended), but it
 * does ONE `readdirSync` + N `readFileSync` per snapshot instead of per id.
 *
 * The runtime rescan (WI-1) re-resolves liveness for every ended pi/tmux row on
 * a ~15s timer; with hundreds of ended rows the per-id variant would re-scan the
 * registry hundreds of times per tick. This collapses that to one scan/tick.
 *
 * kill-0 (`pidAlive`) is still evaluated lazily at query time so a pid that dies
 * mid-tick is not falsely reported alive from a stale read.
 * See change: handover-reliability-wi1 (WI-3 liveness re-resolution on a timer).
 */
export function createLivenessSnapshot(): (sessionId: string) => DriverLiveness {
  // sessionId → {pid,name} for every readable registry entry that carries a
  // sessionId. Built once; pidAlive() is still called per query (see above).
  const bySessionId = new Map<string, { pid: unknown; name: unknown }>();
  let files: string[];
  try {
    files = readdirSync(messengerRegistryDir()).filter((f) => f.endsWith(".json"));
  } catch {
    // No registry dir → every query fails safe to ended.
    return () => ({ alive: false });
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(messengerRegistryDir(), file), "utf8"));
      if (entry && typeof entry.sessionId === "string" && !bySessionId.has(entry.sessionId)) {
        bySessionId.set(entry.sessionId, { pid: entry.pid, name: entry.name });
      }
    } catch {
      continue; // skip an unreadable/partial registry file
    }
  }
  return (sessionId: string): DriverLiveness => {
    if (!sessionId) return { alive: false };
    const entry = bySessionId.get(sessionId);
    if (!entry) return { alive: false };
    if (typeof entry.pid === "number" && pidAlive(entry.pid)) {
      return { alive: true, name: typeof entry.name === "string" ? entry.name : undefined };
    }
    return { alive: false };
  };
}
