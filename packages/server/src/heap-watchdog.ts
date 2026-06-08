/**
 * Heap watchdog — periodic WARN/ERROR logging as the V8 heap approaches its
 * hard cap. The event store's count-only LRU bounds object count but not the
 * serialized-byte floor; this watchdog gives an early, actionable signal before
 * a `FATAL ERROR: Reached heap limit` (which orphans bridges) instead of after.
 *
 * It reads the LIVE V8 cap via `v8.getHeapStatistics().heap_size_limit`, so it
 * is correct regardless of how `--max-old-space-size` is set (plist NODE_OPTIONS,
 * config, or Node default). It only logs — it never restarts the process; a
 * graceful auto-restart is an operator-ratified plist change (see remediation
 * shipped-report), deliberately out of band from this additive signal.
 */
import v8 from "node:v8";

export type HeapWatchdogLevel = "ok" | "warn" | "error";

export interface HeapReading {
  heapUsed: number;
  heapLimit: number;
}

export interface HeapWatchdogStatus {
  level: HeapWatchdogLevel;
  /** heapUsed / heapLimit in [0, 1]. */
  ratio: number;
  heapUsed: number;
  heapLimit: number;
}

export interface HeapWatchdogOptions {
  /** Poll interval in ms. Default 60_000. */
  intervalMs?: number;
  /** Ratio at which to emit a WARNING. Default 0.70. */
  warnRatio?: number;
  /** Ratio at which to emit an ERROR. Default 0.85. */
  errorRatio?: number;
  /** Heap reader — injectable for tests. Defaults to live V8 stats. */
  readHeap?: () => HeapReading;
  /** Optional extra context (e.g. event-store bytes) folded into the log line. */
  getContext?: () => Record<string, number | string>;
  /** Log sinks — default to console.warn / console.error (sister to crash-safety). */
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

const MB = 1024 * 1024;

function defaultReadHeap(): HeapReading {
  const stats = v8.getHeapStatistics();
  return { heapUsed: stats.used_heap_size, heapLimit: stats.heap_size_limit };
}

/** Classify a heap reading against the WARN/ERROR thresholds. Pure. */
export function classifyHeap(
  reading: HeapReading,
  warnRatio: number,
  errorRatio: number,
): HeapWatchdogStatus {
  const { heapUsed, heapLimit } = reading;
  const ratio = heapLimit > 0 ? heapUsed / heapLimit : 0;
  let level: HeapWatchdogLevel = "ok";
  if (ratio >= errorRatio) level = "error";
  else if (ratio >= warnRatio) level = "warn";
  return { level, ratio, heapUsed, heapLimit };
}

export interface HeapWatchdog {
  /** Take one reading, log if over threshold, and return the status. */
  check(): HeapWatchdogStatus;
  /** Begin periodic checks. Idempotent. */
  start(): void;
  /** Stop periodic checks and release the timer. Idempotent. */
  stop(): void;
}

export function createHeapWatchdog(options: HeapWatchdogOptions = {}): HeapWatchdog {
  const intervalMs = options.intervalMs ?? 60_000;
  const warnRatio = options.warnRatio ?? 0.70;
  const errorRatio = options.errorRatio ?? 0.85;
  const readHeap = options.readHeap ?? defaultReadHeap;
  const getContext = options.getContext;
  const warn = options.warn ?? ((m) => console.warn(m));
  const error = options.error ?? ((m) => console.error(m));

  let timer: ReturnType<typeof setInterval> | null = null;
  // Only log on threshold-band CHANGES to avoid spamming the log every interval.
  let lastLevel: HeapWatchdogLevel = "ok";

  function format(status: HeapWatchdogStatus): string {
    const pct = (status.ratio * 100).toFixed(1);
    const used = (status.heapUsed / MB).toFixed(0);
    const limit = (status.heapLimit / MB).toFixed(0);
    let line = `[heap-watchdog] heapUsed ${used} MB / ${limit} MB (${pct}% of V8 cap)`;
    if (getContext) {
      try {
        const ctx = getContext();
        const parts = Object.entries(ctx).map(([k, v]) => `${k}=${v}`);
        if (parts.length) line += ` · ${parts.join(" ")}`;
      } catch { /* context is best-effort; never let it break the watchdog */ }
    }
    return line;
  }

  function check(): HeapWatchdogStatus {
    const status = classifyHeap(readHeap(), warnRatio, errorRatio);
    // Log on entering the warn band (from ok OR de-escalating from error), or
    // re-log every check while in the error band (urgent). Descents to ok are
    // silent. Staying in warn logs once, not every interval (no spam).
    if (status.level === "error") {
      error(format(status));
    } else if (status.level === "warn" && lastLevel !== "warn") {
      warn(format(status));
    }
    lastLevel = status.level;
    return status;
  }

  return {
    check,
    start() {
      if (timer) return;
      timer = setInterval(check, intervalMs);
      // Do not keep the event loop alive solely for the watchdog.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
