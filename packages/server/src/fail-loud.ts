/**
 * Fail-loud crash policy (Stage-2 (b)/(c)/S5) — replaces the suppress-all net.
 *
 * WHY (Fault B): `installCrashSafetyNet()` swallowed EVERY uncaughtException /
 * unhandledRejection and never exited. Its comment claimed "the daemon harness
 * restarts on real crashes" — but a suppressed fault emits NO exit code, so the
 * supervisor saw a healthy process and NEVER restarted. That is exactly how a
 * gateway bind failure became a silent zombie (ESTABLISHED sockets, no rows, no
 * restart) for a week.
 *
 * The policy here is DEGRADE-THEN-CRASH:
 *   - a fatal fault CRASHES the process on purpose (the supervisor + reclaim-on-
 *     start restart a CLEAN instance — the crash IS the recovery), BUT
 *   - teardown runs FIRST (flush meta, kill PTYs, stop editors, delete tunnel,
 *     release home-lock) so a crash never orphans children or loses debounced
 *     writes (a bare `process.exit` would bypass all of it).
 *
 * EXIT-CODE CONTRACT (so launchd KeepAlive={SuccessfulExit:false} can tell them
 * apart):
 *   - exit(1)  = crash          → supervisor RESPAWNS (self-heal).
 *   - exit(0)  = intentional    → supervisor does NOT respawn. Used by the idle
 *                timer AND by the crash-budget breaker (a crash-LOOP halts by
 *                exiting 0 so it is not respawned into the same failure).
 *
 * CRASH-BUDGET BREAKER (S5): KeepAlive + ThrottleInterval(10s) + a persistent
 * fault = an infinite 10s respawn loop. `checkCrashBudget()` reads a persisted
 * crash log at startup; if too many crashes happened in a short window it halts
 * (exit 0, no respawn) with a loud line, converting a loop into a clean stop
 * that needs a human — never a silent hot spin.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface FailLoudOptions {
  /** Graceful teardown to run BEFORE exiting (server.stop). Time-boxed. */
  teardown?: () => Promise<void> | void;
  /** Max time to wait for teardown before exiting anyway (default 5000ms). */
  timeoutMs?: number;
  /** Injectable exit (tests). Defaults to process.exit. */
  exit?: (code: number) => never;
  /** Injectable logger (tests). Defaults to console.error. */
  log?: (msg: string) => void;
  /** Path to the persisted crash log (default ~/.pi/dashboard/crash-log.jsonl). */
  crashLogPath?: string;
  /** Record this crash to the crash log before exiting (default true). */
  record?: boolean;
}

export function defaultCrashLogPath(): string {
  return path.join(os.homedir(), ".pi", "dashboard", "crash-log.jsonl");
}

let crashing = false;

/** Test-only: reset the process-global re-entrancy guard between cases. */
export function __resetFailLoudForTests(): void {
  crashing = false;
}

/** Append a crash timestamp to the persisted crash log (best-effort). */
export function recordCrash(reason: string, crashLogPath = defaultCrashLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
    fs.appendFileSync(crashLogPath, JSON.stringify({ ts: Date.now(), reason: reason.slice(0, 200) }) + "\n");
  } catch {
    /* best-effort — never let crash-logging block the crash */
  }
}

/**
 * DEGRADE-THEN-CRASH: log loud → record the crash → run teardown (time-boxed)
 * → exit(code). Re-entrant-safe (a fault during teardown does not recurse).
 */
export async function failLoudCrash(
  code: number,
  reason: string,
  opts: FailLoudOptions = {},
): Promise<never> {
  const exit = opts.exit ?? ((c: number) => process.exit(c) as never);
  const log = opts.log ?? ((m: string) => console.error(m));
  if (crashing) {
    // A second fault while already crashing — just exit, don't loop teardown.
    return exit(code);
  }
  crashing = true;
  if (opts.record !== false && code !== 0) {
    recordCrash(reason, opts.crashLogPath ?? defaultCrashLogPath());
  }
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (opts.teardown) {
    try {
      await Promise.race([
        Promise.resolve(opts.teardown()),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch (err) {
      log(`[fail-loud] teardown error during crash (continuing to exit ${code}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return exit(code);
}

/**
 * Install the process-level fail-loud net. Replaces installCrashSafetyNet's
 * silent suppress. On an otherwise-uncaught fault: log LOUD (full stack, never
 * "(suppressed)"), run teardown, exit(1) → the supervisor treats the crash as
 * the recovery.
 *
 * Per-seam boundaries (pi-gateway socket/register/bind, browser-gateway wss)
 * handle the KNOWN recoverable faults LOCALLY so they never reach this net;
 * what remains here is genuinely-unexpected and is correctly fatal.
 */
export function installFailLoudNet(opts: FailLoudOptions = {}): void {
  const log = opts.log ?? ((m: string) => console.error(m));
  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log(`[fail-loud] unhandledRejection — crashing for a clean supervised restart: ${err.stack || err.message}`);
    void failLoudCrash(1, `unhandledRejection: ${err.message}`, opts);
  });
  process.on("uncaughtException", (err: Error) => {
    log(`[fail-loud] uncaughtException — crashing for a clean supervised restart: ${err.stack || err.message}`);
    void failLoudCrash(1, `uncaughtException: ${err.message}`, opts);
  });
}

export interface CrashBudgetResult {
  /** True when too many crashes happened in the window → caller should halt. */
  tripped: boolean;
  /** Number of crashes counted inside the window. */
  count: number;
  windowMs: number;
  maxCrashes: number;
}

/**
 * Crash-budget breaker (S5). Reads the persisted crash log and counts crashes
 * within `windowMs`. When the count reaches `maxCrashes`, the caller SHOULD
 * halt (exit 0 → no respawn) rather than let launchd hot-loop the same fault.
 *
 * Pure w.r.t. `now` + `crashLogPath` for testability.
 */
export function checkCrashBudget(opts: {
  windowMs?: number;
  maxCrashes?: number;
  crashLogPath?: string;
  now?: number;
} = {}): CrashBudgetResult {
  const windowMs = opts.windowMs ?? 120_000; // 2 min
  const maxCrashes = opts.maxCrashes ?? 5;
  const crashLogPath = opts.crashLogPath ?? defaultCrashLogPath();
  const now = opts.now ?? Date.now();

  let count = 0;
  try {
    const raw = fs.readFileSync(crashLogPath, "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as { ts?: number };
        if (typeof rec.ts === "number" && now - rec.ts <= windowMs) count++;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no crash log yet — budget not tripped */
  }
  return { tripped: count >= maxCrashes, count, windowMs, maxCrashes };
}

/**
 * Prune crash-log entries older than `keepMs` (called on a healthy startup so
 * the log does not grow unbounded and old crashes don't count forever).
 */
export function pruneCrashLog(opts: { keepMs?: number; crashLogPath?: string; now?: number } = {}): void {
  const keepMs = opts.keepMs ?? 600_000; // 10 min
  const crashLogPath = opts.crashLogPath ?? defaultCrashLogPath();
  const now = opts.now ?? Date.now();
  try {
    const raw = fs.readFileSync(crashLogPath, "utf-8");
    const kept = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        try {
          const rec = JSON.parse(l) as { ts?: number };
          return typeof rec.ts === "number" && now - rec.ts <= keepMs;
        } catch {
          return false;
        }
      });
    fs.writeFileSync(crashLogPath, kept.length ? kept.join("\n") + "\n" : "");
  } catch {
    /* nothing to prune */
  }
}
