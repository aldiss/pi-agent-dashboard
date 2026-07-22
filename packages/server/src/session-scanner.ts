/**
 * Session scanner — discovers all sessions by scanning
 * `~/.pi/agent/sessions/` and reading `.meta.json` sidecars.
 * Falls back to `.jsonl` parsing for sessions without cached meta.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { DashboardSession, SessionSource } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { type SessionMeta, metaPath, readSessionMeta, writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { condenseForFirstMessage } from "@blackbelt-technology/pi-dashboard-shared/skill-block-parser.js";
import type { Audience } from "@blackbelt-technology/pi-dashboard-shared/vendor/operator-voice-audience/audience-core.js";
import { audienceRegistry } from "./audience-registry.js";
import { extractSessionStats } from "./session-stats-reader.js";

function getSessionsDir(): string {
  return join(os.homedir(), ".pi", "agent", "sessions");
}

/** Extract session ID (UUID) from a filename like `<ts>_<uuid>.jsonl` */
function extractSessionId(filename: string): string | null {
  // Format: 2026-03-30T21-39-43-034Z_c7ab4be9-78d1-4764-8197-dbf74fea8bf4.jsonl
  const base = filename.replace(/\.jsonl$/, "").replace(/\.meta\.json$/, "");
  const underscoreIdx = base.indexOf("_");
  if (underscoreIdx === -1) return null;
  return base.slice(underscoreIdx + 1);
}

/** Extract startedAt from a filename timestamp like `2026-03-30T21-39-43-034Z` */
function extractTimestamp(filename: string): number {
  const base = filename.replace(/\.jsonl$/, "").replace(/\.meta\.json$/, "");
  const underscoreIdx = base.indexOf("_");
  if (underscoreIdx === -1) return Date.now();
  // Convert dashes back to colons in time part: 21-39-43-034Z → 21:39:43.034Z
  const tsRaw = base.slice(0, underscoreIdx);
  // Format: 2026-03-30T21-39-43-034Z
  // Need: 2026-03-30T21:39:43.034Z
  const isoStr = tsRaw
    .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, "$1:$2:$3.$4");
  const ts = new Date(isoStr).getTime();
  return isNaN(ts) ? Date.now() : ts;
}

/**
 * Read the events.jsonl mtime as a cold-start seed for `lastActivityAt`.
 * Returns `undefined` on stat failure — callers fall back to `startedAt` at
 * render time. See change: session-card-last-activity-badge.
 */
function readJsonlMtime(sessionFile: string): number | undefined {
  try {
    return statSync(sessionFile).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Build a DashboardSession from cached `.meta.json` data */
export function sessionFromMeta(
  sessionId: string,
  sessionFile: string,
  sessionDir: string,
  meta: SessionMeta,
  startedAt: number,
  deriveAudience: (name: string | undefined, source: string | undefined) => Audience = audienceRegistry.deriveSessionAudience,
): DashboardSession {
  const source = (meta.source as SessionSource) ?? "tui";
  return {
    id: sessionId,
    cwd: meta.cwd ?? "",
    name: meta.name,
    source,
    // door-3 (Item 1): derive audience from name + source via the vendored core.
    // Evaluate on the SAME resolved source the scanner uses (missing → "tui") so
    // display + audience stay consistent; hasUI is derived from source inside the
    // deriver (INTERACTIVE_SOURCES={tui,terminal,zed} — zed included so the start-
    // derive matches the extension's end-stamp). See change: operator-voice-buffer-hold.
    audience: deriveAudience(meta.name, source),
    // FIX-C3 (Pete row-019f6e9b, dl-8874): a persisted session with `endedAt` set is a
    // GENUINE end — reactivation clears it (register → `endedAt: undefined`; live-
    // rescue + resurrection-sweep → `endedAt: null`, the wire-safe clear), so `endedAt`
    // present (`!= null`) ⟹ ended. Normalize on restore
    // so a stale `meta.status` ("idle"/"active" left behind by a clean-shutdown that did
    // not rewrite status) never renders a cleanly-ended session as active. The cold path
    // keys on `endedAt` because `.meta.json` does not persist `bridgeDisconnectReason`;
    // the live-snapshot clean-shutdown signal is normalized at the projection layer.
    status:
      meta.endedAt != null
        ? "ended"
        : ((meta.status as DashboardSession["status"]) ?? "ended"),
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    startedAt: meta.startedAt ?? startedAt,
    endedAt: meta.endedAt,
    // Seed last-activity from events.jsonl mtime so the session-card relative-time
    // badge survives server restarts. See change: session-card-last-activity-badge.
    lastActivityAt: readJsonlMtime(sessionFile),
    tokensIn: meta.tokensIn ?? 0,
    tokensOut: meta.tokensOut ?? 0,
    cacheRead: meta.cacheRead,
    cacheWrite: meta.cacheWrite,
    cost: meta.cost ?? 0,
    contextTokens: meta.contextTokens,
    contextWindow: meta.contextWindow,
    sessionFile,
    sessionDir,
    hidden: meta.hidden ?? false,
    firstMessage: meta.firstMessage,
    attachedProposal: meta.attachedProposal,
    accessCellId: meta.accessCellId,
    // Restore unread bit from .meta.json so it survives server restart.
    // See change: session-card-unread-stripes.
    unread: meta.unread,
    // Restore unseen-server-error bit so a session that errored while
    // unattended survives server restart. See change: build-2-dashboard-v3.
    unseenServerError: meta.unseenServerError,
    dataUnavailable: false,
  };
}

export interface ScanResult {
  sessions: DashboardSession[];
  /** Session files whose .meta.json was created or updated (for logging) */
  cacheUpdates: number;
}

/**
 * Scan all session directories and return DashboardSession[] from cached meta.
 * For sessions without .meta.json or with stale cache, falls back to .jsonl parsing
 * and writes .meta.json for next time.
 */
export function scanAllSessions(sessionsDir?: string): ScanResult {
  const dir = sessionsDir ?? getSessionsDir();
  if (!existsSync(dir)) return { sessions: [], cacheUpdates: 0 };

  const sessions: DashboardSession[] = [];
  let cacheUpdates = 0;

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(dir).filter((d) => {
      try { return statSync(join(dir, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return { sessions: [], cacheUpdates: 0 };
  }

  for (const cwdDir of cwdDirs) {
    const cwdPath = join(dir, cwdDir);
    let files: string[];
    try {
      files = readdirSync(cwdPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const jsonlFile of files) {
      const sessionId = extractSessionId(jsonlFile);
      if (!sessionId) continue;

      const sessionFile = join(cwdPath, jsonlFile);
      const sessionDir = cwdPath;
      const startedAt = extractTimestamp(jsonlFile);

      // Try reading .meta.json
      const meta = readSessionMeta(sessionFile);

      if (meta && meta.cwd) {
        // Check cache freshness: if .jsonl is newer than cachedAt, re-extract
        let needsReExtract = false;
        if (meta.cachedAt) {
          try {
            const jsonlMtime = statSync(sessionFile).mtimeMs;
            if (jsonlMtime > meta.cachedAt) {
              needsReExtract = true;
            }
          } catch { /* ignore stat errors */ }
        }

        if (!needsReExtract) {
          // Use cached meta as-is
          sessions.push(sessionFromMeta(sessionId, sessionFile, sessionDir, meta, startedAt));
          continue;
        }

        // Stale cache — re-extract stats and merge
        const stats = extractSessionStats(sessionFile);
        if (stats) {
          // Pi's JSONL has no turn_end/contextUsage events, so stats.contextWindow
          // is always inferContextWindow(model) — a hardcoded heuristic that pins
          // any Claude model to 200k and ignores 1M Sonnet variants. The persisted
          // meta.contextWindow came from a real live `turn_end` event, so it's
          // authoritative; only fall back to the inferred value when the model
          // changed (persisted value no longer applies) or none was persisted.
          const effectiveModel = stats.model ?? meta.model;
          const preserveContextWindow =
            meta.contextWindow !== undefined && effectiveModel === meta.model;
          const updated: SessionMeta = {
            ...meta,
            model: stats.model ?? meta.model,
            thinkingLevel: stats.thinkingLevel ?? meta.thinkingLevel,
            tokensIn: stats.tokensIn,
            tokensOut: stats.tokensOut,
            cacheRead: stats.cacheRead,
            cacheWrite: stats.cacheWrite,
            cost: stats.cost,
            contextTokens: stats.lastTotalTokens,
            contextWindow: preserveContextWindow ? meta.contextWindow : stats.contextWindow,
            cachedAt: Date.now(),
          };
          writeSessionMeta(sessionFile, updated);
          cacheUpdates++;
          sessions.push(sessionFromMeta(sessionId, sessionFile, sessionDir, updated, startedAt));
        } else {
          sessions.push(sessionFromMeta(sessionId, sessionFile, sessionDir, meta, startedAt));
        }
        continue;
      }

      // No usable meta — fall back to .jsonl parsing
      const header = readJsonlHeaderSync(sessionFile);
      if (!header) continue;

      const stats = extractSessionStats(sessionFile);
      const newMeta: SessionMeta = {
        ...(meta ?? {}), // preserve any existing partial meta (e.g. source)
        cwd: header.cwd,
        firstMessage: header.firstMessage,
        name: meta?.name ?? header.name,
        startedAt,
        status: "ended",
        ...(stats ? {
          model: stats.model,
          thinkingLevel: stats.thinkingLevel,
          tokensIn: stats.tokensIn,
          tokensOut: stats.tokensOut,
          cacheRead: stats.cacheRead,
          cacheWrite: stats.cacheWrite,
          cost: stats.cost,
          contextTokens: stats.lastTotalTokens,
          contextWindow: stats.contextWindow,
        } : {}),
        cachedAt: Date.now(),
      };
      writeSessionMeta(sessionFile, newMeta);
      cacheUpdates++;
      sessions.push(sessionFromMeta(sessionId, sessionFile, sessionDir, newMeta, startedAt));
    }
  }

  return { sessions, cacheUpdates };
}

/** Synchronous JSONL header reader (used during scan) */
function readJsonlHeaderSync(filePath: string): { id: string; cwd: string; name?: string; firstMessage?: string } | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    let header: any = null;
    let name: string | undefined;
    let firstMessage: string | undefined;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && entry.id) header = entry;
        if (entry.type === "session_info" && entry.name) name = entry.name;
        // See change: render-skill-invocations-collapsibly.
        if (!firstMessage && entry.type === "message" && entry.message?.role === "user") {
          const msg = entry.message;
          if (typeof msg.content === "string") {
            firstMessage = condenseForFirstMessage(msg.content, 200);
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text) {
                firstMessage = condenseForFirstMessage(part.text, 200);
                break;
              }
            }
          }
        }
        if (header && firstMessage) break;
      } catch { /* skip malformed lines */ }
    }

    if (!header) return null;
    return { id: header.id, cwd: header.cwd ?? "", name, firstMessage };
  } catch {
    return null;
  }
}
