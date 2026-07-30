/**
 * Spool emitter — the producer hop for obsidian-daily-voice-record.
 *
 * On a VERIFIED-NON-EMPTY transcription this writes the note-writing engine's
 * exact spool contract and wakes the engine once. It is deliberately:
 *
 *   - NON-REGRESSIVE. Every failure here is swallowed. A spool problem must
 *     never change what the operator sees for their dictation; transcription
 *     succeeded, and that result is returned regardless.
 *   - CONTRACT-ONLY. It writes the transcript bytes, the audio bytes and the
 *     sidecar JSON, and nothing else. No transcript or audio is logged
 *     anywhere outside the spool contract.
 *   - VAULT-SAFE. It never chooses the operator's real vault. The engine's own
 *     activation seam stays inert unless an explicit allowed-root is configured.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface SpoolEmitConfig {
  /** Spool directory the engine drains. Emission is skipped when unset. */
  readonly spoolDir?: string;
  /** Engine gateway binary. Wake is skipped when unset. */
  readonly enginePath?: string;
  /** Vault the engine writes into. Wake is skipped when unset. */
  readonly vaultRoot?: string;
  /** Engine replay-guard state file. */
  readonly guardPath?: string;
  /** Exact operator-confirmed production root. Omitted ⇒ activation inert. */
  readonly allowedRoot?: string;
}

const sha256 = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

/** Extract the transcript field without mutating or re-encoding its bytes. */
export function transcriptBytesFrom(body: string): Buffer | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const t = (parsed as { transcript?: unknown }).transcript;
    if (typeof t !== "string" || t.trim().length === 0) return null;
    return Buffer.from(t, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write one spool entry. Returns the entry id, or null when nothing was
 * written. Never throws.
 */
export function emitSpoolEntry(
  responseBody: string,
  audio: Buffer,
  cfg: SpoolEmitConfig,
  now: Date = new Date(),
): string | null {
  try {
    if (cfg.spoolDir === undefined) return null;
    const transcript = transcriptBytesFrom(responseBody);
    if (transcript === null) return null;
    if (audio.length === 0) return null;

    const id = `vi-${now.getTime().toString(36)}-${Math.floor(
      now.getTime() % 1000,
    )
      .toString()
      .padStart(3, "0")}`;

    mkdirSync(cfg.spoolDir, { recursive: true });
    const tPath = join(cfg.spoolDir, `${id}.txt`);
    const aPath = join(cfg.spoolDir, `${id}.webm`);
    writeFileSync(tPath, transcript);
    writeFileSync(aPath, audio);

    const entry = {
      id,
      seq: 1,
      capture: {
        utcMillis: now.getTime(),
        tzOffsetMinutes: -now.getTimezoneOffset(),
      },
      transcriptPath: tPath,
      transcriptSha256: sha256(transcript),
      audioPath: aPath,
      audioSha256: sha256(audio),
      audioSize: audio.length,
      audioRelPath: `audio/${id}.webm`,
      backendStatus: 200,
    };

    // Write the sidecar atomically LAST, so a drain can never observe an entry
    // whose transcript or audio is not yet fully on disk.
    const tmp = join(cfg.spoolDir, `.${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(entry, null, 1));
    renameSync(tmp, join(cfg.spoolDir, `${id}.json`));
    return id;
  } catch {
    return null;
  }
}

/** Wake the engine once. Never throws; never blocks the response. */
export function wakeEngine(cfg: SpoolEmitConfig): boolean {
  try {
    if (
      cfg.enginePath === undefined ||
      cfg.vaultRoot === undefined ||
      cfg.spoolDir === undefined ||
      cfg.guardPath === undefined
    ) {
      return false;
    }
    const args = [
      "--vault",
      cfg.vaultRoot,
      "--spool",
      cfg.spoolDir,
      "--guard",
      cfg.guardPath,
    ];
    if (cfg.allowedRoot !== undefined) args.push("--allowed-root", cfg.allowedRoot);
    const child = spawn(cfg.enginePath, args, {
      detached: true,
      stdio: "ignore",
    });
    // spawn reports a bad executable ASYNCHRONOUSLY on a later tick, so it
    // escapes the try/catch around this call and would reach the server's
    // fail-loud net as an uncaughtException. Swallow it here: a misconfigured
    // engine must never affect the operator's transcription.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Read emitter config from env. All-unset ⇒ emitter is inert. */
export function spoolConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SpoolEmitConfig {
  return {
    spoolDir: env.OBSIDIAN_VOICE_SPOOL_DIR,
    enginePath: env.OBSIDIAN_VOICE_ENGINE,
    vaultRoot: env.OBSIDIAN_VOICE_VAULT,
    guardPath: env.OBSIDIAN_VOICE_GUARD,
    allowedRoot: env.OBSIDIAN_VOICE_ALLOWED_ROOT,
  };
}
