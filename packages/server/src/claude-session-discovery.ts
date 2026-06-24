/**
 * Claude-Code session discovery — lists CC sessions for a given cwd, the
 * sibling of session-discovery.ts (which lists pi sessions). Reads session
 * JSONL files from ~/.claude/projects/<cc-encoded-cwd>/.
 *
 * Key differences from the pi reader:
 *   - encoding: CC replaces BOTH `/` and `.` with `-` and does NOT wrap in
 *     `--…--` (pi wraps + keeps dots). e.g. /Users/u/.pi/orchestration-state
 *     → -Users-u--pi-orchestration-state
 *   - schema: CC events are type:"assistant"/"user" (role IS the type) with
 *     Anthropic-block content, vs pi's type:"message"+role. Title is derived
 *     from a `summary` line or the first user message.
 *   - reads are BYTE-BOUNDED (CC logs can be 20 MB+ with 7 MB+ single lines).
 *
 * Emits the same `DiscoveredSession` shape as the pi reader, tagged with
 * `source:"claude-code"`, so the dashboard renders one unified session list.
 *
 * See change: add-claude-code-session-viewing.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { DiscoveredSession } from "./session-discovery.js";
import { readWindow, parseLines, extractText, CLAUDE_WINDOW, claudeProjectsRoot } from "./claude-transcript-reader.js";

/**
 * Encode a cwd to the Claude-Code project directory name: replace every `/`
 * AND `.` with `-`, no wrap. This is DIFFERENT from pi's encodeCwd.
 */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Derive a display title from a byte-bounded head window of a CC log.
 *
 * `firstMessage` is capped at 200 chars at this store site (mirrors the title
 * cap below): a CC first user turn can be a 30 KB paste, and shipping it raw
 * inflated `/api/sessions` to ~91% CC bytes. 200 chars is a real preview, not a
 * payload. Exported so the cap is unit-testable independent of the discovery
 * DTO (which omits `firstMessage` entirely — see `discoverClaudeSessionsForCwd`).
 * See change: perf/cc-viewing-payload-fix (Track 1, Fix 1).
 */
export function deriveClaudeHeader(filePath: string, projName: string): {
  cwd: string;
  title?: string;
  firstMessage?: string;
  startedAt?: number;
} {
  const head = parseLines(readWindow(filePath, 0, CLAUDE_WINDOW));
  let cwd = "";
  let summaryTitle: string | undefined;
  let firstUserText: string | undefined;
  let startedAt: number | undefined;

  for (const r of head) {
    if (!r || typeof r !== "object") continue;
    if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
    if (startedAt === undefined && typeof r.timestamp === "string") {
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) startedAt = t;
    }
    if (!summaryTitle && r.type === "summary" && typeof r.summary === "string") summaryTitle = r.summary;
    if (!firstUserText && r.type === "user" && r.message) {
      const txt = extractText(r.message.content);
      if (txt && !txt.startsWith("<")) firstUserText = txt.replace(/\s+/g, " ").trim();
    }
    if (cwd && summaryTitle && firstUserText) break;
  }

  const title =
    summaryTitle ||
    (firstUserText ? firstUserText.slice(0, 90) : undefined) ||
    projName.replace(/^-+/, "").split("-").slice(-2).join("-") ||
    undefined;

  return { cwd, title, firstMessage: firstUserText?.slice(0, 200), startedAt };
}

/**
 * Discover all Claude-Code sessions for a given cwd. Returns sessions sorted by
 * modified time (newest first), tagged `source:"claude-code"`. Empty array if
 * the cwd has no CC project dir.
 */
export function discoverClaudeSessionsForCwd(cwd: string): DiscoveredSession[] {
  const projName = encodeClaudeCwd(cwd);
  const dir = join(claudeProjectsRoot(), projName);
  if (!existsSync(dir)) return [];

  const sessions: DiscoveredSession[] = [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size === 0) continue;
        const id = file.replace(/\.jsonl$/, "");
        const header = deriveClaudeHeader(filePath, projName);
        // `firstMessage` is intentionally OMITTED from the list DTO: the card
        // renders `name` (always set for CC — the title chain always resolves),
        // and the client only reads `firstMessage` as a name-fallback when
        // `name` is empty (session-display-name.ts / session-grouping.ts). It
        // was list-only bloat (~91% of /api/sessions bytes). The capped header
        // value still exists for any future per-card lazy preview fetch.
        // See change: perf/cc-viewing-payload-fix (Track 1, Fix 2).
        sessions.push({
          id,
          cwd: header.cwd || cwd,
          name: header.title,
          startedAt: header.startedAt ?? stat.mtimeMs,
          modifiedAt: stat.mtimeMs,
          sessionFile: filePath,
          sessionDir: dir,
          source: "claude-code",
        });
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    return [];
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return sessions;
}
