/**
 * Thread-durability — atomic durable write (design v3.6 §C1.1).
 *
 * The write half of the per-row critical section: a unique-per-writer tmp
 * file + `fsync(file)` + `rename` + `fsync(dir)`. This is the crash-durable
 * upgrade of `packages/server/src/json-store.ts` (which does tmp+rename but
 * NOT fsync) — the design mandates the fsyncs so a row survives power-loss and
 * a partial write is never observed under the rename.
 *
 * Unique-per-writer tmp name (`<name>.<pid>.<nonce>.tmp`) so two writers in
 * the same directory never collide on the tmp path (the per-row lock already
 * serializes writers to the SAME row; the unique tmp additionally protects
 * cross-row writers sharing the outbox dir and any non-locked call site).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Options for {@link atomicWriteFileSync} — injectable for tests. */
export interface AtomicWriteOpts {
  /** Process id stamped into the tmp name (default `process.pid`). */
  pid?: number;
  /** Unique nonce stamped into the tmp name (default `randomUUID()`). */
  nonce?: string;
  /** File mode applied to the tmp file before rename (e.g. `0o600`). */
  mode?: number;
}

/**
 * Atomically write `data` to `filePath`, durably:
 *   1. `mkdir -p` the parent dir.
 *   2. write to a unique tmp (`<name>.<pid>.<nonce>.tmp`).
 *   3. `fsync` the tmp file (flush contents before the rename).
 *   4. `rename` tmp → target (atomic replace on POSIX + Windows).
 *   5. `fsync` the directory (flush the rename itself).
 *
 * On any failure the tmp file is best-effort unlinked so a crashed write
 * leaves no orphan. The rename is the linearization point: a reader sees
 * either the old file or the fully-written new file, never a torn write.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  opts: AtomicWriteOpts = {},
): void {
  const dir = path.dirname(filePath);
  const pid = opts.pid ?? process.pid;
  const nonce = opts.nonce ?? randomUUID();
  const tmpPath = `${filePath}.${pid}.${nonce}.tmp`;

  fs.mkdirSync(dir, { recursive: true });

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w", opts.mode ?? 0o644);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // (3) flush file contents to disk
    fs.closeSync(fd);
    fd = undefined;
    if (opts.mode !== undefined) fs.chmodSync(tmpPath, opts.mode);
    fs.renameSync(tmpPath, filePath); // (4) atomic replace
    fsyncDir(dir); // (5) flush the rename
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closing on the error path */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* tmp may not exist — best-effort cleanup */
    }
    throw err;
  }
}

/**
 * `fsync` a directory so a preceding `rename` is itself durable. Some
 * platforms (notably Windows) refuse to open a directory for fsync — that is
 * not fatal to correctness (the rename is still atomic), so directory-fsync
 * failures are swallowed while file-fsync failures propagate.
 */
export function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = fs.openSync(dir, "r");
    fs.fsyncSync(dfd);
  } catch {
    /* directory fsync unsupported on this platform — rename is still atomic */
  } finally {
    if (dfd !== undefined) {
      try {
        fs.closeSync(dfd);
      } catch {
        /* best-effort */
      }
    }
  }
}
