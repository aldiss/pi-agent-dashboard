/** Read-only transcript discovery and normalization for external sessions. */
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { access, open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import type {
  ExternalRuntime,
  ExternalSession,
  ExternalSessionTranscriptResponse,
  ExternalTranscriptEntry,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import type { SpawnSyncFn } from "./tmux-read.js";

export const DEFAULT_TRANSCRIPT_ENTRY_LIMIT = 400;
export const DEFAULT_TRANSCRIPT_RECORD_LIMIT = 2_000;
export const DEFAULT_TRANSCRIPT_READ_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOOL_RESULT_BYTES = 64 * 1024;
export const DEFAULT_TRANSCRIPT_RESPONSE_BYTES = 768 * 1024;
const TRUNCATION_MARKER = "… truncated";

type UnknownRecord = Record<string, unknown>;

export interface TranscriptCandidate {
  path: string;
  birthtimeMs: number;
}

export interface TranscriptParseLimits {
  maxEntries?: number;
  maxToolResultBytes?: number;
  maxResponseBytes?: number;
}

export interface ParsedTranscript {
  entries: ExternalTranscriptEntry[];
  truncated: boolean;
}

export interface JsonlTailLimits {
  maxReadBytes?: number;
  maxRecords?: number;
}

export interface JsonlTail {
  records: unknown[];
  truncated: boolean;
}

export interface ExternalProcessInfo {
  startTimeMs: number;
  /** Only values needed for transcript resolution are retained. */
  env: Record<string, string>;
}

export interface ExternalSessionTranscriptReader {
  prime(sessions: readonly ExternalSession[]): Promise<void>;
  read(session: ExternalSession): Promise<ExternalSessionTranscriptResponse>;
}

export interface ExternalSessionTranscriptReaderDeps {
  homedir?: () => string;
  readProcessInfo?: (pid: number) => ExternalProcessInfo | null;
  listCandidates?: (
    root: string,
    runtime: ExternalRuntime,
  ) => Promise<TranscriptCandidate[]>;
  pathExists?: (transcriptPath: string) => Promise<boolean>;
  readTail?: (
    transcriptPath: string,
    limits?: JsonlTailLimits,
  ) => Promise<JsonlTail>;
  maxEntries?: number;
  maxRecords?: number;
  maxReadBytes?: number;
  maxToolResultBytes?: number;
  maxResponseBytes?: number;
  spawnSync?: SpawnSyncFn;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(textOf).filter(Boolean).join("\n");
  }
  const record = recordOf(value);
  if (!record) return "";
  for (const key of ["text", "thinking", "message", "content", "output", "summary"]) {
    if (record[key] != null) {
      const text = textOf(record[key]);
      if (text) return text;
    }
  }
  return "";
}

function resultTextOf(value: unknown): string {
  const text = textOf(value);
  if (text) return text;
  try {
    return value == null ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

function timestampOf(record: UnknownRecord): number {
  const raw = record.timestamp ?? record.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function durationOf(record: UnknownRecord): number | undefined {
  const raw = record.durationMs ?? record.duration_ms;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function structuredInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  const encoded = Buffer.from(value, "utf8");
  let end = Math.min(prefixBudget, encoded.length);
  let prefix = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      prefix = decoder.decode(encoded.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return { value: `${prefix}${TRUNCATION_MARKER}`, truncated: true };
}

function finalizeEntries(
  entries: ExternalTranscriptEntry[],
  limits: TranscriptParseLimits,
  alreadyTruncated = false,
): ParsedTranscript {
  const maxEntries = Math.max(1, limits.maxEntries ?? DEFAULT_TRANSCRIPT_ENTRY_LIMIT);
  const maxToolResultBytes = Math.max(1, limits.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES);
  const maxResponseBytes = Math.max(1, limits.maxResponseBytes ?? DEFAULT_TRANSCRIPT_RESPONSE_BYTES);
  const fieldByteLimit = Math.max(
    Buffer.byteLength(TRUNCATION_MARKER, "utf8"),
    Math.min(maxToolResultBytes, Math.floor(maxResponseBytes / 2)),
  );
  let truncated = alreadyTruncated;

  const cappedFields = entries.map((entry) => {
    let next = entry;
    if (entry.text != null) {
      const capped = truncateUtf8(entry.text, fieldByteLimit);
      if (capped.truncated) {
        truncated = true;
        next = { ...next, text: capped.value };
      }
    }
    if (entry.toolResult != null) {
      const capped = truncateUtf8(entry.toolResult, Math.min(maxToolResultBytes, fieldByteLimit));
      if (capped.truncated) {
        truncated = true;
        next = { ...next, toolResult: capped.value };
      }
    }
    if (entry.toolInput != null) {
      let serialized = "";
      try {
        serialized = JSON.stringify(entry.toolInput);
      } catch {
        serialized = String(entry.toolInput);
      }
      const capped = truncateUtf8(serialized, fieldByteLimit);
      if (capped.truncated) {
        truncated = true;
        next = { ...next, toolInput: capped.value };
      }
    }
    return next;
  });

  const entryCapped = cappedFields.length <= maxEntries
    ? cappedFields
    : cappedFields.slice(-maxEntries);
  if (entryCapped.length !== cappedFields.length) truncated = true;

  const responseCapped: ExternalTranscriptEntry[] = [];
  let responseBytes = 2; // JSON array brackets
  for (let index = entryCapped.length - 1; index >= 0; index -= 1) {
    const entry = entryCapped[index]!;
    const serializedBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    const addition = serializedBytes + (responseCapped.length > 0 ? 1 : 0);
    if (responseBytes + addition > maxResponseBytes) {
      truncated = true;
      if (responseCapped.length === 0) {
        const minimal: ExternalTranscriptEntry = {
          id: entry.id,
          ts: entry.ts,
          kind: entry.kind,
          text: TRUNCATION_MARKER,
        };
        if (Buffer.byteLength(JSON.stringify([minimal]), "utf8") <= maxResponseBytes) {
          responseCapped.unshift(minimal);
        }
      }
      break;
    }
    responseCapped.unshift(entry);
    responseBytes += addition;
  }

  return { entries: responseCapped, truncated };
}

function entryId(base: unknown, index: number, part: number, kind: string): string {
  const stableBase = typeof base === "string" && base ? base : `row-${index}`;
  return `${stableBase}:${part}:${kind}`;
}

function stableRecordId(record: UnknownRecord, rowIndex: number): string {
  try {
    return `row-${createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16)}`;
  } catch {
    return `row-${rowIndex}`;
  }
}

export function parseClaudeTranscript(
  records: readonly unknown[],
  limits: TranscriptParseLimits = {},
): ParsedTranscript {
  const entries: ExternalTranscriptEntry[] = [];
  const toolNames = new Map<string, string>();

  records.forEach((value, rowIndex) => {
    const record = recordOf(value);
    if (!record || (record.type !== "user" && record.type !== "assistant")) return;
    const message = recordOf(record.message);
    const content = message?.content ?? record.content;
    const blocks = Array.isArray(content)
      ? content
      : content == null
        ? []
        : [{ type: "text", text: content }];
    const ts = timestampOf(record);
    const baseId = record.uuid ?? message?.id ?? record.id ?? stableRecordId(record, rowIndex);

    blocks.forEach((blockValue, blockIndex) => {
      const block = recordOf(blockValue);
      if (!block) return;
      const blockType = block.type;
      if (blockType === "thinking") {
        const text = textOf(block.thinking ?? block.text ?? block.content);
        if (text) entries.push({ id: entryId(baseId, rowIndex, blockIndex, "thinking"), ts, kind: "thinking", text });
        return;
      }
      if (blockType === "tool_use") {
        const toolCallId = typeof block.id === "string" ? block.id : entryId(baseId, rowIndex, blockIndex, "call");
        const toolName = typeof block.name === "string" && block.name ? block.name : "unknown";
        toolNames.set(toolCallId, toolName);
        entries.push({
          id: entryId(baseId, rowIndex, blockIndex, "tool-call"),
          ts,
          kind: "tool_call",
          toolCallId,
          toolName,
          toolInput: block.input,
        });
        return;
      }
      if (blockType === "tool_result") {
        const toolCallId = typeof block.tool_use_id === "string"
          ? block.tool_use_id
          : entryId(baseId, rowIndex, blockIndex, "result");
        const toolResult = resultTextOf(block.content ?? block.text);
        entries.push({
          id: entryId(baseId, rowIndex, blockIndex, "tool-result"),
          ts,
          kind: "tool_result",
          toolCallId,
          toolName: toolNames.get(toolCallId),
          toolResult,
          isError: block.is_error === true,
        });
        return;
      }
      if (blockType === "text" || typeof block.text === "string") {
        const text = textOf(block.text ?? block.content);
        if (!text) return;
        const kind = record.type === "user" ? "user" : "assistant";
        entries.push({ id: entryId(baseId, rowIndex, blockIndex, kind), ts, kind, text });
      }
    });
  });

  return finalizeEntries(entries, limits);
}

export function parseCodexTranscript(
  records: readonly unknown[],
  limits: TranscriptParseLimits = {},
): ParsedTranscript {
  const entries: ExternalTranscriptEntry[] = [];
  const toolNames = new Map<string, string>();

  records.forEach((value, rowIndex) => {
    const record = recordOf(value);
    const payload = recordOf(record?.payload);
    if (!record || !payload || typeof payload.type !== "string") return;
    const type = payload.type;
    const ts = timestampOf(record);
    const baseId = record.id ?? payload.id ?? payload.call_id ?? stableRecordId(record, rowIndex);
    const durationMs = durationOf(payload);

    if (type === "user_message" || type === "agent_message") {
      const text = textOf(payload.message ?? payload.text ?? payload.content);
      if (text) {
        const kind = type === "user_message" ? "user" : "assistant";
        entries.push({ id: entryId(baseId, rowIndex, 0, kind), ts, kind, text });
      }
      return;
    }

    if (type === "reasoning") {
      const text = textOf(payload.summary ?? payload.content ?? payload.text);
      if (text) entries.push({ id: entryId(baseId, rowIndex, 0, "thinking"), ts, kind: "thinking", text, durationMs });
      return;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const toolCallId = typeof payload.call_id === "string"
        ? payload.call_id
        : entryId(baseId, rowIndex, 0, "call");
      const toolName = typeof payload.name === "string" && payload.name ? payload.name : "unknown";
      toolNames.set(toolCallId, toolName);
      entries.push({
        id: entryId(baseId, rowIndex, 0, "tool-call"),
        ts,
        kind: "tool_call",
        toolCallId,
        toolName,
        toolInput: structuredInput(payload.arguments ?? payload.input),
        durationMs,
      });
      return;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const toolCallId = typeof payload.call_id === "string"
        ? payload.call_id
        : entryId(baseId, rowIndex, 0, "result");
      entries.push({
        id: entryId(baseId, rowIndex, 0, "tool-result"),
        ts,
        kind: "tool_result",
        toolCallId,
        toolName: toolNames.get(toolCallId),
        toolResult: resultTextOf(payload.output ?? payload.result),
        isError: payload.is_error === true || payload.success === false || payload.status === "failed",
        durationMs,
      });
      return;
    }

    if (type === "patch_apply_end") {
      const toolCallId = typeof payload.call_id === "string"
        ? payload.call_id
        : entryId(baseId, rowIndex, 0, "patch");
      entries.push({
        id: entryId(baseId, rowIndex, 0, "tool-result"),
        ts,
        kind: "tool_result",
        toolCallId,
        toolName: "apply_patch",
        toolResult: resultTextOf(payload.stdout ?? payload.output ?? payload.result ?? payload.changes)
          || (payload.success === false ? "Patch failed" : "Patch applied"),
        isError: payload.success === false || payload.status === "failed",
        durationMs,
      });
      return;
    }

    if (type === "task_started" || type === "task_complete") {
      const fallback = type === "task_started" ? "Task started" : "Task complete";
      entries.push({
        id: entryId(baseId, rowIndex, 0, "status"),
        ts,
        kind: "status",
        text: textOf(payload.message ?? payload.text) || fallback,
        durationMs,
      });
    }
  });

  return finalizeEntries(entries, limits);
}

/** Select by birth time, not mtime or newest-file ordering. */
/**
 * Claude Code names a project directory after the session's cwd with the path
 * separators flattened — but it also flattens DOTS, so
 * `/Users/x/.pi/orchestration-state` becomes `-Users-x--pi-orchestration-state`
 * (note the double dash). Replacing only `/` produced `-Users-x-.pi-…`, which
 * exists for no session whose path contains a dot, so every session under
 * `~/.pi/...` silently fell back to the raw terminal.
 *
 * Rather than hard-coding a guess at Claude's full encoding, try the direct
 * name first and otherwise match by comparing normalised forms of the real
 * directory names: any run of non-alphanumerics collapses to a single marker on
 * both sides, so future encoding tweaks (underscores, spaces) still resolve.
 * Best-effort by design: when nothing on disk matches (or the fs is stubbed) it
 * returns the directly-computed path and lets candidate listing come back empty,
 * so the caller falls back to the raw capture instead of this deciding for it.
 */
export async function resolveClaudeProjectDir(
  cwd: string,
  projectsRoot: string = path.join(os.homedir(), ".claude", "projects"),
): Promise<string> {
  const direct = path.join(projectsRoot, cwd.replaceAll("/", "-").replaceAll(".", "-"));
  try {
    const s = await stat(direct);
    if (s.isDirectory()) return direct;
  } catch {
    // fall through to the normalised scan
  }
  const normalise = (v: string): string => v.replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/g, "");
  const want = normalise(cwd);
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (normalise(entry.name) === want) return path.join(projectsRoot, entry.name);
    }
  } catch {
    // projects root unreadable — fall through
  }
  return direct;
}

export function pickNearestTranscript(
  candidates: readonly TranscriptCandidate[],
  processStartMs: number,
): string | null {
  let selected: TranscriptCandidate | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.birthtimeMs) || candidate.birthtimeMs < processStartMs) continue;
    if (
      !selected
      || candidate.birthtimeMs < selected.birthtimeMs
      || (candidate.birthtimeMs === selected.birthtimeMs && candidate.path < selected.path)
    ) {
      selected = candidate;
    }
  }
  return selected?.path ?? null;
}

export async function readJsonlTail(
  transcriptPath: string,
  limits: JsonlTailLimits = {},
): Promise<JsonlTail> {
  const maxReadBytes = Math.max(1, limits.maxReadBytes ?? DEFAULT_TRANSCRIPT_READ_BYTES);
  const maxRecords = Math.max(1, limits.maxRecords ?? DEFAULT_TRANSCRIPT_RECORD_LIMIT);
  const handle = await open(transcriptPath, "r");
  try {
    const fileStat = await handle.stat();
    const length = Math.min(fileStat.size, maxReadBytes);
    const start = Math.max(0, fileStat.size - length);
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }

    let startsAtLineBoundary = start === 0;
    if (start > 0) {
      const preceding = Buffer.alloc(1);
      const read = await handle.read(preceding, 0, 1, start - 1);
      startsAtLineBoundary = read.bytesRead === 1 && preceding[0] === 0x0a;
    }
    let lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    let truncated = start > 0;
    if (start > 0 && !startsAtLineBoundary) lines = lines.slice(1);
    lines = lines.filter((line) => line.trim().length > 0);
    if (lines.length > maxRecords) {
      lines = lines.slice(-maxRecords);
      truncated = true;
    }

    const records: unknown[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        // A runtime may be appending the final row. Ignore that incomplete snapshot.
        truncated = true;
      }
    }
    return { records, truncated };
  } finally {
    await handle.close();
  }
}

function readProcessInfoWithPs(pid: number, spawnSync: SpawnSyncFn): ExternalProcessInfo | null {
  try {
    const started = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (started.status !== 0 || typeof started.stdout !== "string") return null;
    const startTimeMs = Date.parse(started.stdout.trim());
    if (!Number.isFinite(startTimeMs)) return null;

    const environment = spawnSync("ps", ["eww", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const env: Record<string, string> = {};
    if (environment.status === 0 && typeof environment.stdout === "string") {
      const match = environment.stdout.match(/(?:^|\s)CODEX_HOME=([^\s]+)/);
      if (match?.[1]) env.CODEX_HOME = match[1];
    }
    return { startTimeMs, env };
  } catch {
    return null;
  }
}

async function pathExists(transcriptPath: string): Promise<boolean> {
  try {
    await access(transcriptPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function listTranscriptCandidates(
  root: string,
  runtime: ExternalRuntime,
): Promise<TranscriptCandidate[]> {
  const candidates: TranscriptCandidate[] = [];

  async function walk(directory: string): Promise<void> {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(children.map(async (child) => {
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (runtime === "codex") await walk(childPath);
        return;
      }
      if (!child.isFile()) return;
      const matches = runtime === "codex"
        ? /^rollout-.*\.jsonl$/.test(child.name)
        : child.name.endsWith(".jsonl");
      if (!matches) return;
      try {
        const fileStat = await stat(childPath);
        if (Number.isFinite(fileStat.birthtimeMs) && fileStat.birthtimeMs > 0) {
          candidates.push({ path: childPath, birthtimeMs: fileStat.birthtimeMs });
        }
      } catch {
        // File disappeared during a concurrent append/rotation; skip it.
      }
    }));
  }

  await walk(root);
  return candidates;
}

function captureFallback(id: string): ExternalSessionTranscriptResponse {
  return { id, source: "capture", entries: [], truncated: false };
}

export function createExternalSessionTranscriptReader(
  deps: ExternalSessionTranscriptReaderDeps = {},
): ExternalSessionTranscriptReader {
  const homedir = deps.homedir ?? os.homedir;
  const spawnSync = deps.spawnSync ?? (nodeSpawnSync as unknown as SpawnSyncFn);
  const readProcessInfo = deps.readProcessInfo
    ?? ((pid: number) => readProcessInfoWithPs(pid, spawnSync));
  const listCandidates = deps.listCandidates ?? listTranscriptCandidates;
  const exists = deps.pathExists ?? pathExists;
  const readTail = deps.readTail ?? readJsonlTail;
  const maxEntries = deps.maxEntries ?? DEFAULT_TRANSCRIPT_ENTRY_LIMIT;
  const maxRecords = deps.maxRecords ?? DEFAULT_TRANSCRIPT_RECORD_LIMIT;
  const maxReadBytes = deps.maxReadBytes ?? DEFAULT_TRANSCRIPT_READ_BYTES;
  const maxToolResultBytes = deps.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES;
  const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_TRANSCRIPT_RESPONSE_BYTES;
  const locations = new Map<string, { runtimePid: number; path: string }>();
  const lastResponses = new Map<string, {
    runtimePid: number;
    response: ExternalSessionTranscriptResponse;
  }>();

  async function locate(session: ExternalSession): Promise<string | null> {
    if (session.runtimePid == null) return null;
    const cached = locations.get(session.id);
    if (cached?.runtimePid === session.runtimePid && await exists(cached.path)) {
      return cached.path;
    }
    locations.delete(session.id);

    const processInfo = readProcessInfo(session.runtimePid);
    if (!processInfo) return null;
    let root: string;
    if (session.runtime === "codex") {
      const codexHome = processInfo.env.CODEX_HOME || path.join(homedir(), ".codex");
      root = path.join(codexHome, "sessions");
    } else {
      if (!session.cwd) return null;
      root = await resolveClaudeProjectDir(
        session.cwd,
        path.join(homedir(), ".claude", "projects"),
      );
    }

    const candidates = await listCandidates(root, session.runtime);
    const transcriptPath = pickNearestTranscript(candidates, processInfo.startTimeMs);
    if (!transcriptPath) return null;
    locations.set(session.id, { runtimePid: session.runtimePid, path: transcriptPath });
    return transcriptPath;
  }

  return {
    async prime(sessions) {
      await Promise.all(sessions
        .filter((session) => session.state === "live")
        .map(async (session) => {
          try {
            await locate(session);
          } catch {
            // Resolution is best-effort. Detail reads retain capture fallback.
          }
        }));
    },
    async read(session) {
      const runtimePid = session.runtimePid;
      const previous = lastResponses.get(session.id);
      if (runtimePid != null && session.state === "ended" && previous?.runtimePid === runtimePid) {
        return previous.response;
      }
      if (runtimePid == null) return captureFallback(session.id);
      if (previous && previous.runtimePid !== runtimePid) lastResponses.delete(session.id);

      try {
        const transcriptPath = await locate(session);
        if (!transcriptPath) return captureFallback(session.id);
        const tail = await readTail(transcriptPath, {
          maxReadBytes,
          maxRecords,
        });
        const parsed = session.runtime === "claude-code"
          ? parseClaudeTranscript(tail.records, { maxEntries, maxToolResultBytes, maxResponseBytes })
          : parseCodexTranscript(tail.records, { maxEntries, maxToolResultBytes, maxResponseBytes });
        const response: ExternalSessionTranscriptResponse = {
          id: session.id,
          source: session.runtime,
          entries: parsed.entries,
          truncated: tail.truncated || parsed.truncated,
          transcriptPath,
        };
        lastResponses.set(session.id, { runtimePid, response });
        return response;
      } catch {
        return captureFallback(session.id);
      }
    },
  };
}
