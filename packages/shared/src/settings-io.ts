/**
 * Safe, concurrency-tolerant reader/writer for pi's `~/.pi/agent/settings.json`.
 *
 * WHY THIS EXISTS (mode-I / racy-settings clobber, dl-4565/4566):
 * pi itself, the dashboard server, and various scripts ALL write settings.json
 * with no concurrency protection. The chronic bug is the "catch-from-{}" read:
 *
 *     let settings = {};
 *     try { settings = JSON.parse(readFileSync(path)); } catch { \/* start fresh *\/ }
 *     settings.packages = [...];            // ← writes {} + our one key
 *     writeFileSync(path, JSON.stringify(settings));   // ← CLOBBERS every other key
 *
 * When a *concurrent* writer leaves the file mid-write (or it is briefly
 * unparseable), the catch swallows the parse error, `settings` stays `{}`, and
 * the next write ERASES defaultProvider / defaultModel / thinking /
 * pluginBridges / workflows. This was live-witnessed twice during D6.
 *
 * The fix is a strict read that distinguishes three cases:
 *   - file ABSENT       → `{}` is legitimate (genuinely fresh) → return `{}`.
 *   - file EMPTY        → no keys to clobber → return `{}`.
 *   - file EXISTS + non-empty + UNPARSEABLE → THROW. NEVER start from `{}`.
 *     (a partial/concurrent write or real corruption — the caller must skip the
 *     write, not overwrite real content with `{}`.)
 *
 * paired with an atomic write (unique temp + fsync + rename) so a reader never
 * observes a half-written file.
 *
 * This is the single canonical settings.json I/O primitive; new writers SHOULD
 * route through it (safety by CODE, not discipline). See NOS §16.1 racy-settings.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Thrown by {@link readSettingsOrThrow} when settings.json EXISTS and is
 * non-empty but cannot be parsed as a JSON object. Callers MUST treat this as
 * "do not write" — writing would clobber the real (concurrently-written or
 * merely-corrupt) file with a fresh `{}`.
 */
export class SettingsUnparseableError extends Error {
  readonly settingsPath: string;
  readonly cause?: unknown;
  constructor(settingsPath: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? "");
    super(
      `settings.json exists but is not parseable JSON (${settingsPath})` +
        (detail ? `: ${detail}` : "") +
        " — refusing to overwrite it with a fresh object (would clobber real keys).",
    );
    this.name = "SettingsUnparseableError";
    this.settingsPath = settingsPath;
    this.cause = cause;
  }
}

/**
 * Read settings.json into an object.
 *
 *   - ABSENT (ENOENT)            → `{}` (genuinely fresh — safe to write).
 *   - EMPTY / whitespace-only    → `{}` (no keys to clobber — safe to write).
 *   - EXISTS, non-empty, PARSES  → the parsed object.
 *   - EXISTS, non-empty, UNPARSEABLE (or non-object root) → throws
 *     {@link SettingsUnparseableError}. NEVER returns `{}` for this case.
 *   - Other read errors (e.g. EACCES) → rethrown (never silently `{}`).
 *
 * The load-bearing contract: a caller that catches nothing and blindly writes
 * the return value can NEVER clobber a real-but-unparseable file, because this
 * throws instead of handing back `{}`.
 */
export function readSettingsOrThrow(settingsPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}; // absent = fresh
    throw err; // permission / other read error — do NOT clobber by returning {}
  }

  const trimmed = raw.trim();
  if (!trimmed) return {}; // empty file = fresh (nothing to clobber)

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // File EXISTS with real content but is not valid JSON: a concurrent/partial
    // write or corruption. Refuse — never overwrite it with `{}`.
    throw new SettingsUnparseableError(settingsPath, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsUnparseableError(settingsPath, "root is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Atomically write settings.json: write to a per-process, collision-safe temp
 * file, fsync it to disk, then `rename` into place (atomic on the same
 * filesystem). A concurrent reader therefore observes either the old complete
 * file or the new complete file — never a truncated one.
 *
 * On any failure the temp file is cleaned up and the error is rethrown; the
 * live settings.json is left untouched.
 */
export function atomicWriteSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
): void {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  // Unique temp so two concurrent writers never share the same temp path
  // (fixed `.tmp` names race; the last rename wins, but neither corrupts).
  const unique = `${process.pid}.${Date.now().toString(36)}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  const tmp = `${settingsPath}.tmp.${unique}`;
  const body = JSON.stringify(settings, null, 2) + "\n";
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, settingsPath);
  } catch (err) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist */
    }
    throw err;
  }
}

/**
 * Safe read-modify-write of settings.json. Reads via {@link readSettingsOrThrow}
 * (so an unparseable existing file throws BEFORE any write — never clobbered),
 * applies `mutate`, then {@link atomicWriteSettings}.
 *
 * `mutate` may either mutate the object in place and return it, return a new
 * object to persist, or return `false` / `undefined` to signal "no change —
 * skip the write entirely" (so a no-op never rewrites the file and never races).
 *
 * Propagates {@link SettingsUnparseableError} to the caller; the caller decides
 * whether to abort (scripts) or log-loud-and-skip (long-lived server).
 */
export function updateSettings(
  settingsPath: string,
  mutate: (settings: Record<string, unknown>) => Record<string, unknown> | false | void,
): void {
  const settings = readSettingsOrThrow(settingsPath);
  const result = mutate(settings);
  if (result === false || result === undefined) return; // explicit no-op → no write
  atomicWriteSettings(settingsPath, result);
}
