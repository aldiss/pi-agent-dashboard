/**
 * Claude-Code transcript reader — byte-bounded, read-only.
 *
 * Why this exists: Claude-Code writes session logs to ~/.claude/projects/<enc>/
 * <uuid>.jsonl in the Anthropic Messages shape, which is DIFFERENT from pi's
 * session JSONL. This module reads those logs with a BYTE-BOUNDED window (never
 * whole-file — CC logs routinely carry multi-MB `attachment` /
 * `file-history-snapshot` events and 7 MB+ single lines, so a readFileSync would
 * OOM the server) and adapts CC entries into the pi entry shape the existing
 * `replayEntriesAsEvents` reducer already understands. That maximises reuse: the
 * battle-tested pi render pipeline renders CC turns unchanged.
 *
 * Ported from the live fleet-cockpit reader
 * (~/Misc/Documents/Copilot/dashboard-v2-direct/server/lib/{read-claude,transcript}.mjs):
 *   - the byte-bounded readWindow + parseLines discipline (util.mjs)
 *   - extractText over Anthropic content blocks (read-claude.mjs)
 *   - the source==='claude' content normalization (transcript.mjs)
 *
 * See change: add-claude-code-session-viewing.
 */
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import os from "node:os";

/** Head/tail window per read. 256 KB is enough for many turns while staying O(window). */
export const CLAUDE_WINDOW = 256 * 1024;

/** Canonical Claude-Code projects root. */
export function claudeProjectsRoot(): string {
  return join(os.homedir(), ".claude", "projects");
}

/**
 * Read-only path guard: a CC session file MUST resolve to inside
 * ~/.claude/projects (no `..` traversal, no symlink escape via the literal
 * path). Mirrors the safety property fleet-cockpit's transcript.mjs enforces.
 */
export function isClaudeSessionFile(filePath: string): boolean {
  if (!filePath) return false;
  const root = resolve(claudeProjectsRoot());
  const target = resolve(filePath);
  return target === root || target.startsWith(root + sep);
}

/**
 * Read up to `len` bytes from `pos` (negative = from EOF) of a file. Never
 * throws. Only ever reads regular files — a FIFO/socket/device would block the
 * single-threaded event loop indefinitely, so a crafted path pointing at one is
 * refused. Ported verbatim-in-spirit from dashboard-v2 util.mjs:readWindow.
 */
export function readWindow(file: string, pos: number, len: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return "";
    const size = st.size;
    const start = Math.max(0, pos < 0 ? size + pos : pos);
    const toRead = Math.min(len, size - start);
    if (toRead <= 0) return "";
    const buf = Buffer.allocUnsafe(toRead);
    const n = readSync(fd, buf, 0, toRead, start);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** File size in bytes, or 0 if unstattable / not a regular file. */
export function fileSize(file: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const st = fstatSync(fd);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parse complete JSONL lines from a blob; optionally drop the partial first line of a tail window. */
export function parseLines(blob: string, opts: { dropFirst?: boolean } = {}): any[] {
  const { dropFirst = false } = opts;
  const out: any[] = [];
  const lines = blob.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (dropFirst && i === 0) continue;
    const ln = lines[i].trim();
    if (!ln) continue;
    try {
      out.push(JSON.parse(ln));
    } catch {
      /* partial / malformed — skip */
    }
  }
  return out;
}

/** First renderable text from Anthropic content (string or block array). */
export function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
        return (block as any).text;
      }
      if (typeof block === "string") return block;
    }
  }
  return null;
}

/** Cap a string for a bounded preview, marking elision. */
function capPreview(s: string, cap = 8 * 1024): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n…(+${Math.round((s.length - cap) / 1024)} KB elided)`;
}

/** Normalize a CC tool_result block's `content` into pi toolResult content blocks. */
function normalizeToolResultContent(content: unknown): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  if (typeof content === "string") return [{ type: "text", text: capPreview(content) }];
  if (Array.isArray(content)) {
    const out: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        if (typeof block === "string") out.push({ type: "text", text: capPreview(block) });
        continue;
      }
      const b: any = block;
      if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: capPreview(b.text) });
      else if (b.type === "image" && b.source) {
        // CC image block: { type:image, source:{ type:base64, media_type, data } }
        out.push({ type: "image", data: b.source.data, mimeType: b.source.media_type });
      } else {
        out.push({ type: "text", text: capPreview(JSON.stringify(b)) });
      }
    }
    return out.length ? out : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: "" }];
}

/**
 * Adapt a window of CC records into pi-shaped entries that
 * `replayEntriesAsEvents` understands. The mapping:
 *
 *   CC assistant {type:"assistant", message:{role, content:[blocks], model, usage}}
 *     → pi {type:"model_change", modelId} (once, on first model seen)
 *     → pi {type:"message", message:{role:"assistant", content:[normalized blocks], usage}}
 *        where Anthropic `{type:"tool_use", id, name, input}` → pi `{type:"toolCall", id, name, arguments:input}`
 *        and `{type:"text"}`/`{type:"thinking"}` pass through.
 *   CC user {type:"user", message:{role, content}}
 *     → for each `{type:"tool_result", tool_use_id, content, is_error}` block:
 *         pi {type:"message", message:{role:"toolResult", toolCallId, toolName, content:[...], isError}}
 *     → for the remaining text/non-tool content:
 *         pi {type:"message", message:{role:"user", content}}
 *
 * Bulky CC-only events (attachment / file-history-snapshot / mode / permission-mode /
 * summary / system / queue-operation / last-prompt) are NAMED, not dumped: they
 * produce nothing (kept out of the rendered transcript) — their bytes never leave
 * the window. tool_use_id→toolName is resolved from tool_use blocks seen earlier
 * in the window.
 */
export function claudeRecordsToReplayEntries(records: any[]): any[] {
  const out: any[] = [];
  const toolNameById = new Map<string, string>();
  let lastModel: string | null = null;
  let seq = 0;

  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const ts: string | undefined = typeof r.timestamp === "string" ? r.timestamp : undefined;

    if (r.type === "assistant" && r.message) {
      const msg = r.message;
      const model: string | undefined = typeof msg.model === "string" ? msg.model : undefined;
      if (model && model !== lastModel) {
        out.push({ type: "model_change", modelId: model, timestamp: ts });
        lastModel = model;
      }
      const inBlocks = Array.isArray(msg.content) ? msg.content : extractText(msg.content) != null ? [{ type: "text", text: extractText(msg.content) }] : [];
      const outBlocks: any[] = [];
      for (const block of inBlocks) {
        if (!block || typeof block !== "object") continue;
        const b: any = block;
        if (b.type === "text" && typeof b.text === "string") {
          outBlocks.push({ type: "text", text: b.text });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          outBlocks.push({ type: "thinking", thinking: b.thinking, thinkingSignature: b.signature });
        } else if (b.type === "tool_use") {
          if (b.id && typeof b.name === "string") toolNameById.set(b.id, b.name);
          outBlocks.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.input });
        }
        // unknown assistant block types: dropped (named-not-dumped)
      }
      const usage = msg.usage
        ? {
            input: msg.usage.input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
            cacheRead: msg.usage.cache_read_input_tokens ?? 0,
            cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
            totalTokens:
              (msg.usage.input_tokens ?? 0) +
              (msg.usage.output_tokens ?? 0) +
              (msg.usage.cache_read_input_tokens ?? 0) +
              (msg.usage.cache_creation_input_tokens ?? 0),
          }
        : undefined;
      out.push({
        type: "message",
        id: r.uuid ?? `cc-${seq++}`,
        timestamp: ts,
        message: { role: "assistant", content: outBlocks, ...(usage ? { usage } : {}) },
      });
      continue;
    }

    if (r.type === "user" && r.message) {
      const content = r.message.content;
      // tool_result blocks fold here (Anthropic shape) — emit each as a pi toolResult entry.
      if (Array.isArray(content)) {
        const nonToolBlocks: any[] = [];
        for (const block of content) {
          if (block && typeof block === "object" && (block as any).type === "tool_result") {
            const b: any = block;
            const toolCallId = b.tool_use_id ?? b.toolUseId ?? "";
            out.push({
              type: "message",
              id: `${r.uuid ?? `cc-${seq}`}-tr-${toolCallId}`,
              timestamp: ts,
              message: {
                role: "toolResult",
                toolCallId,
                toolName: toolNameById.get(toolCallId) ?? "tool",
                content: normalizeToolResultContent(b.content),
                isError: b.is_error === true,
              },
            });
          } else {
            nonToolBlocks.push(block);
          }
        }
        if (nonToolBlocks.length) {
          out.push({
            type: "message",
            id: r.uuid ?? `cc-${seq++}`,
            timestamp: ts,
            message: { role: "user", content: nonToolBlocks },
          });
        }
      } else {
        const txt = extractText(content);
        // skip CC UI envelope user lines that start with '<' (command-name wrappers)
        if (txt != null && !txt.startsWith("<")) {
          out.push({
            type: "message",
            id: r.uuid ?? `cc-${seq++}`,
            timestamp: ts,
            message: { role: "user", content: txt },
          });
        }
      }
      continue;
    }

    // Everything else (mode / permission-mode / attachment / file-history-snapshot /
    // summary / system / queue-operation / last-prompt) — named-not-dumped: skipped.
  }
  return out;
}

/**
 * Read a CC session log (byte-bounded) and return pi-shaped entries ready for
 * `replayEntriesAsEvents`. For files within one window, reads once. For larger
 * files, reads the TAIL window (the recent, triage-useful turns) so the first
 * paint is fast AND the "load earlier" pager can walk cleanly backward to the
 * session start (a head+tail base would render the file's middle ABOVE its head
 * once earlier windows are prepended — reverse-chronological). The earlier
 * history is reachable via `loadClaudeSessionWindow` + the transcript REST
 * route. NEVER reads the whole file.
 * See change: perf/cc-viewing-payload-fix (Track 2, Fix A).
 */
export function loadClaudeSessionEntries(filePath: string): any[] {
  if (!isClaudeSessionFile(filePath)) return [];
  const size = fileSize(filePath);
  if (size <= 0) return [];

  if (size <= CLAUDE_WINDOW) {
    return claudeRecordsToReplayEntries(parseLines(readWindow(filePath, 0, CLAUDE_WINDOW)));
  }
  // Tail-only base window: the last CLAUDE_WINDOW bytes, partial first line
  // dropped. Delegates to loadClaudeSessionWindow (before=size) so the
  // base-window and pager share one read/parse/adapt path.
  return loadClaudeSessionWindow(filePath, size).entries;
}

/** Result of a single backward-pager window read. */
export interface ClaudeWindowResult {
  /** pi-shaped replay entries for this window (chronological within the window). */
  entries: any[];
  /**
   * Byte offset where THIS window starts — pass it as the next call's
   * `beforeByteOffset` to fetch the strictly-earlier window. Always the
   * window's start; the partial line straddling it was dropped from THIS
   * window and will be completed by the next (earlier) window.
   */
  nextBeforeOffset: number;
  /** True once the window reaches byte 0 — no earlier history remains. */
  atStart: boolean;
}

/**
 * Read ONE byte-bounded window ENDING at `beforeByteOffset` (exclusive) and
 * return its pi-shaped entries plus the cursor for the next (earlier) window.
 * This is the backward-pager primitive behind `GET /api/session/:id/transcript`.
 *
 * Discipline (mirrors the head+tail reader's byte-bound):
 *   - Window = bytes [start, beforeByteOffset) where start = max(0, before-len).
 *   - When start > 0 the window's first line is partial (it began in the
 *     previous window), so it is DROPPED — the earlier window completes it.
 *   - When start === 0 there is no partial first line (file start), so keep it
 *     and report `atStart:true`.
 *   - `nextBeforeOffset = start`; a subsequent call with `before=start` reads
 *     the strictly-earlier window with no overlap.
 *
 * NEVER reads the whole file; each call is O(len). Returns an empty result for
 * non-CC paths or an exhausted cursor (`beforeByteOffset <= 0`).
 * See change: perf/cc-viewing-payload-fix (Track 2, Fix A).
 */
export function loadClaudeSessionWindow(
  filePath: string,
  beforeByteOffset: number,
  len: number = CLAUDE_WINDOW,
): ClaudeWindowResult {
  if (!isClaudeSessionFile(filePath)) return { entries: [], nextBeforeOffset: 0, atStart: true };
  const size = fileSize(filePath);
  if (size <= 0) return { entries: [], nextBeforeOffset: 0, atStart: true };

  // Clamp the window end into the file; a cursor at/under 0 is exhausted.
  const end = Math.min(beforeByteOffset <= 0 ? 0 : beforeByteOffset, size);
  if (end <= 0) return { entries: [], nextBeforeOffset: 0, atStart: true };

  const start = Math.max(0, end - len);
  const atStart = start === 0;
  const blob = readWindow(filePath, start, end - start);
  // Drop the partial first line only when this window does NOT begin at byte 0.
  const records = parseLines(blob, { dropFirst: !atStart });
  return {
    entries: claudeRecordsToReplayEntries(records),
    nextBeforeOffset: start,
    atStart,
  };
}
