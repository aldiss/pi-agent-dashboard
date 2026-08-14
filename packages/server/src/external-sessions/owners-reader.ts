import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExternalSessionOwner } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

export const EXTERNAL_SESSION_OWNERS_PATH = join(
  os.homedir(),
  ".pi",
  "orchestration-state",
  "external-session-owners.json",
);

export const DEFAULT_EXTERNAL_SESSION_OWNERS_TTL_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract the safe response fields from the versioned on-disk wrapper. */
export function parseExternalSessionOwners(
  parsed: unknown,
): Record<string, ExternalSessionOwner> {
  if (!isRecord(parsed) || parsed.schema_version !== 1 || !isRecord(parsed.sessions)) {
    return {};
  }

  const owners = Object.create(null) as Record<string, ExternalSessionOwner>;
  for (const [tmuxSession, value] of Object.entries(parsed.sessions)) {
    if (tmuxSession.trim() === "" || !isRecord(value)) continue;
    const { owner, cell } = value;
    if (typeof owner !== "string" || owner.trim() === "") continue;
    if (cell !== null && (typeof cell !== "string" || cell.trim() === "")) continue;
    owners[tmuxSession] = {
      owner: owner.trim(),
      cell: cell === null ? null : cell.trim(),
    };
  }
  return owners;
}

export interface ExternalSessionOwnersReader {
  getOwners(nowMs?: number): Record<string, ExternalSessionOwner>;
}

export interface ExternalSessionOwnersReaderOptions {
  registryPath?: string;
  ttlMs?: number;
  now?: () => number;
  readFile?: (path: string) => string;
}

/** Read-only, failure-safe cached reader for external-session ownership. */
export function createExternalSessionOwnersReader(
  options: ExternalSessionOwnersReaderOptions = {},
): ExternalSessionOwnersReader {
  const registryPath = options.registryPath ?? EXTERNAL_SESSION_OWNERS_PATH;
  const ttlMs = options.ttlMs ?? DEFAULT_EXTERNAL_SESSION_OWNERS_TTL_MS;
  const now = options.now ?? Date.now;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let cached: Record<string, ExternalSessionOwner> | undefined;
  let cachedAt = 0;

  function getOwners(nowMs: number = now()): Record<string, ExternalSessionOwner> {
    if (cached && nowMs - cachedAt < ttlMs) return cached;
    try {
      cached = parseExternalSessionOwners(JSON.parse(readFile(registryPath)));
    } catch {
      cached = {};
    }
    cachedAt = nowMs;
    return cached;
  }

  return { getOwners };
}
