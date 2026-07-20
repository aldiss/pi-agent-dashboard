/**
 * Thread-durability — the per-row lock (design v3.6 §C1.1 / N1).
 *
 * ONE serialization domain: every row mutation AND every claim-state
 * transition acquires `<outbox-dir>/<delivery_id>.lock/` before
 * read→validate→write→release. The lock is a DIRECTORY created with
 * `mkdir` (atomic: `EEXIST` ⇒ contended). Inside it an owner-token file
 * (`owner`) holds `{pid, host, nonce, ts}` so only the owner releases and a
 * stale lock can be reaped safely.
 *
 * Stale-reap predicate (conservative — NEVER reaps a live owner):
 *   reapable(token) ⇔
 *        now - token.ts ≥ ttlMs        (past the TTL)
 *     ∧  token.host === thisHost       (same host — cross-host liveness is
 *                                        unknowable, so a cross-host lock is
 *                                        NEVER reaped)
 *     ∧  ¬isProcessAlive(token.pid)    (owner provably gone; a reused-PID that
 *                                        happens to be alive reads as alive ⇒
 *                                        NOT reaped — a false-positive-alive is
 *                                        the safe direction)
 *   A missing/unparseable token past the TTL is a leaked lock (a well-behaved
 *   owner always writes its token immediately after mkdir) and is reaped by
 *   lock-dir mtime.
 *
 * The global drain lease selects the scanner/attempt-owner only; it NEVER
 * substitutes for this per-row lock (N1).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { isProcessAlive } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";

/** Persisted owner-token — identifies the lock holder for release + reap. */
export interface OwnerToken {
  pid: number;
  host: string;
  nonce: string;
  ts: number;
}

/** Opaque handle returned by {@link RowLockManager.acquire}. */
export interface RowLockHandle {
  delivery_id: string;
  lockDir: string;
  token: OwnerToken;
}

/** Thrown when a lock cannot be acquired within the retry budget. */
export class RowLockContendedError extends Error {
  constructor(public readonly delivery_id: string) {
    super(`row lock contended for delivery_id=${delivery_id}`);
    this.name = "RowLockContendedError";
  }
}

export interface RowLockOpts {
  pid?: number;
  host?: string;
  nonce?: () => string;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Age at which a same-host, dead-owner lock becomes reapable (default 30s). */
  ttlMs?: number;
  /** Acquire retries before giving up (default 50). */
  maxRetries?: number;
  /** Backoff between retries (default 20ms). */
  backoffMs?: number;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const OWNER_FILE = "owner";

/**
 * Per-row lock manager over an outbox directory. Tracks locally-held rows so
 * the store can assert "lock held" before every write (the runtime half of
 * the exhaustive-lock check).
 */
export class RowLockManager {
  private readonly outboxDir: string;
  private readonly pid: number;
  private readonly host: string;
  private readonly nonceFn: () => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** delivery_id → token.nonce of a lock this manager currently holds. */
  private readonly held = new Map<string, string>();

  constructor(outboxDir: string, opts: RowLockOpts = {}) {
    this.outboxDir = outboxDir;
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? os.hostname();
    this.nonceFn = opts.nonce ?? (() => randomUUID());
    this.isAlive = opts.isAlive ?? ((pid) => isProcessAlive(pid));
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 50;
    this.backoffMs = opts.backoffMs ?? 20;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  lockDirFor(delivery_id: string): string {
    return path.join(this.outboxDir, `${delivery_id}.lock`);
  }

  /** True iff THIS manager currently holds the row lock (runtime lock-check). */
  isHeldLocally(delivery_id: string): boolean {
    return this.held.has(delivery_id);
  }

  /**
   * Acquire the per-row lock. mkdir-atomic; on `EEXIST` attempt a stale-reap
   * and retry with backoff. Throws {@link RowLockContendedError} after the
   * retry budget.
   */
  async acquire(delivery_id: string): Promise<RowLockHandle> {
    const lockDir = this.lockDirFor(delivery_id);
    fs.mkdirSync(this.outboxDir, { recursive: true });

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        fs.mkdirSync(lockDir); // atomic; EEXIST ⇒ contended
        const token: OwnerToken = {
          pid: this.pid,
          host: this.host,
          nonce: this.nonceFn(),
          ts: this.now(),
        };
        // Write the owner-token durably so a reaper on another process can
        // read a complete record (never a torn token).
        const tokenPath = path.join(lockDir, OWNER_FILE);
        const fd = fs.openSync(tokenPath, "w", 0o644);
        try {
          fs.writeSync(fd, JSON.stringify(token));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.held.set(delivery_id, token.nonce);
        return { delivery_id, lockDir, token };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Contended — try to reap a stale holder, then back off and retry.
        this.reapIfStale(delivery_id);
        if (attempt < this.maxRetries) await this.sleep(this.backoffMs);
      }
    }
    throw new RowLockContendedError(delivery_id);
  }

  /**
   * Release a lock. Only the owner (matching nonce) removes the dir; if the
   * on-disk token no longer matches (we were reaped and someone else holds
   * it), we drop our local tracking WITHOUT deleting their lock.
   */
  release(handle: RowLockHandle): void {
    const onDisk = this.readToken(handle.delivery_id);
    this.held.delete(handle.delivery_id);
    if (onDisk && onDisk.nonce !== handle.token.nonce) {
      // A reaper took over — not ours to delete.
      return;
    }
    this.removeLockDir(handle.lockDir);
  }

  /** Read + parse the owner-token, or null if missing/unparseable. */
  readToken(delivery_id: string): OwnerToken | null {
    const tokenPath = path.join(this.lockDirFor(delivery_id), OWNER_FILE);
    try {
      const raw = fs.readFileSync(tokenPath, "utf-8");
      const parsed = JSON.parse(raw) as OwnerToken;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.host === "string" &&
        typeof parsed.nonce === "string" &&
        typeof parsed.ts === "number"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Reap the lock for `delivery_id` iff it is stale. Returns true if a lock
   * was reaped. Conservative: never reaps a live or cross-host owner.
   */
  reapIfStale(delivery_id: string): boolean {
    const lockDir = this.lockDirFor(delivery_id);
    if (!fs.existsSync(lockDir)) return false;

    const token = this.readToken(delivery_id);
    if (token === null) {
      // Malformed/absent token — a well-behaved owner writes it immediately.
      // Reap only if the lock dir itself is older than the TTL (leaked lock).
      if (this.lockDirAgeMs(lockDir) >= this.ttlMs) {
        this.removeLockDir(lockDir);
        return true;
      }
      return false;
    }

    if (!this.isReapable(token)) return false;
    this.removeLockDir(lockDir);
    return true;
  }

  /** The reap predicate — see the module doc-comment. Pure over its inputs. */
  private isReapable(token: OwnerToken): boolean {
    if (this.now() - token.ts < this.ttlMs) return false; // not past TTL
    if (token.host !== this.host) return false; // cross-host: unknowable → keep
    if (this.isAlive(token.pid)) return false; // owner alive → keep
    return true; // past TTL, same host, provably dead
  }

  private lockDirAgeMs(lockDir: string): number {
    try {
      const st = fs.statSync(lockDir);
      return this.now() - st.mtimeMs;
    } catch {
      return 0;
    }
  }

  private removeLockDir(lockDir: string): void {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best-effort — a concurrent reaper may have removed it already */
    }
  }
}
