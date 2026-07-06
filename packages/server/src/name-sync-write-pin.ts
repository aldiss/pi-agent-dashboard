/**
 * W4 — name-sync write-pin (row-hygiene lane; EXTENSION of da753bd name-canon).
 *
 * F5 false-green: a raw `POST /api/session/:id/rename` returns 200 + a visible
 * rename but does NOT write the registry `operatorPinnedName` pin, so the
 * launchd-scheduled `pi-dashboard-name-sync` re-derives the display from the
 * registry `name (+ statusMessage)` ~120 s later and CLOBBERS the rename.
 *
 * The WORKING path (`~/bin/pi-rename`) writes the pin FIRST (atomic
 * write-temp + rename), then POSTs. This module lifts that atomic write into
 * the server so the dashboard rename route ALSO sets the pin — single source of
 * truth = the registry `operatorPinnedName`. `pi-dashboard-name-sync` already
 * honors the pin over the auto-derived name.
 *
 * All I/O is injectable so the find-by-sessionId + atomic-write logic is unit-
 * testable against an in-memory / tmp fixture.
 *
 * See change: name-sync-write-pin.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { messengerRegistryDir } from "./driver-liveness.js";

export interface WritePinResult {
  ok: boolean;
  /** Registry file (basename) that was written, when matched. */
  file?: string;
  /** Why the write did not happen (never fatal to the caller). */
  reason?: "no-registry-dir" | "no-matching-entry" | "write-failed";
}

/**
 * Find the registry entry whose `sessionId === sessionId` and atomically set
 * (or, when `pinnedName` is empty/undefined, clear) its `operatorPinnedName`.
 *
 * Atomic-write discipline mirrors `pi-rename`: write a temp sibling then
 * `rename` over the original (rename is atomic on POSIX), preserving the file
 * mode. Best-effort + non-fatal: a miss returns `{ok:false, reason}` — the
 * caller (rename route) still succeeds; only the durability pin is skipped.
 *
 * @param registryDir override for tests; defaults to the canonical messenger dir.
 */
export function writeOperatorPin(
  sessionId: string,
  pinnedName: string | undefined,
  registryDir: string = messengerRegistryDir(),
): WritePinResult {
  if (!sessionId) return { ok: false, reason: "no-matching-entry" };

  let files: string[];
  try {
    files = readdirSync(registryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { ok: false, reason: "no-registry-dir" };
  }

  for (const file of files) {
    const full = join(registryDir, file);
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // skip unreadable/partial entry
    }
    if (entry.sessionId !== sessionId) continue;

    // Matched. Set or clear the pin.
    const trimmed = typeof pinnedName === "string" ? pinnedName.trim() : "";
    if (trimmed) {
      entry.operatorPinnedName = trimmed;
    } else {
      delete entry.operatorPinnedName; // --unpin semantics: revert to auto-derived
    }

    try {
      // Preserve mode (macOS/BSD + Linux both via statSync().mode); fall back to
      // 0o644 on any stat failure (matches pi-rename's fallback).
      let mode = 0o644;
      try {
        mode = statSync(full).mode & 0o777;
      } catch {
        /* keep 0o644 */
      }
      // Temp sibling in the SAME dir so `rename` stays on one filesystem (atomic).
      const tmp = join(registryDir, `.${file}.tmp-${process.pid}`);
      writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode });
      try {
        chmodSync(tmp, mode);
      } catch {
        /* best-effort mode preserve */
      }
      renameSync(tmp, full);
      return { ok: true, file };
    } catch {
      return { ok: false, reason: "write-failed", file };
    }
  }

  return { ok: false, reason: "no-matching-entry" };
}

/**
 * Read the registry `operatorPinnedName` for a sessionId (the canonical pin).
 * `undefined` when no entry matches / no dir / no pin. Used by the meta-vs-
 * registry consistency check.
 */
export function readOperatorPin(
  sessionId: string,
  registryDir: string = messengerRegistryDir(),
): string | undefined {
  if (!sessionId) return undefined;
  let files: string[];
  try {
    files = readdirSync(registryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8")) as Record<string, unknown>;
      if (entry.sessionId === sessionId) {
        return typeof entry.operatorPinnedName === "string" ? entry.operatorPinnedName : undefined;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Meta-vs-registry consistency check (W4 (b)). Given the dashboard row's name
 * and the registry pin, decide whether they diverge — the detection missing
 * today (F5). "Divergent" = a registry pin exists AND differs from the row name.
 * A row with no pin (never pinned) is NOT divergent. Pure, so callers can log
 * loud on `divergent`.
 */
export interface ConsistencyResult {
  divergent: boolean;
  rowName?: string;
  registryPin?: string;
}

export function checkNamePinConsistency(
  rowName: string | undefined,
  registryPin: string | undefined,
): ConsistencyResult {
  const divergent =
    typeof registryPin === "string" &&
    registryPin.length > 0 &&
    registryPin !== (rowName ?? "");
  return {
    divergent,
    ...(rowName !== undefined ? { rowName } : {}),
    ...(registryPin !== undefined ? { registryPin } : {}),
  };
}
