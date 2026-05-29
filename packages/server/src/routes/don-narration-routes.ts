/**
 * Don narration REST API route.
 *
 * Exposes `GET /api/don-narration` returning the parsed contents of
 * the canonical `~/.pi/orchestration-state/don-narration-current.md`
 * state file (markdown-with-frontmatter shape).
 *
 * Path B sister-coupling primitive per AGENTS.md v1.4.4 deck-surfacing
 * discipline + sister-shape operator-active-surfaces canonical Path B
 * first instance shipped 2026-05-23. Sister-shape to v1.1 operator-state.json
 * release_at lifecycle pattern.
 *
 * Cell: operator-driver-experience-don-build/v1 (W6 D6 deliverable per
 * Don 7th canonical standing-crew BUILD cell scope-split 2026-05-28).
 *
 * File-missing → 200 with empty `markdown: ""` + `parse_warning: "file missing"`
 * (graceful degradation per pi-task-spine canonical pattern). Malformed-frontmatter
 * → 200 with empty metadata fields + `parse_warning` field. 5s in-memory cache
 * reduces fs hit storm during polling burst from multiple browser clients.
 *
 * A3 stale-narration freshness-guard metadata per W5 council amendment A3
 * STRUCTURAL fix canonical: response includes frontmatter_metadata field
 * (rendered_at + source_mode + source_mode_mtime_or_rev + source_inputs_hash
 * + stale_after) for client-side stale-detection rendering per DonNarration.tsx
 * component spec.
 */
import type { FastifyInstance } from "fastify";
import type { NetworkGuard } from "./route-deps.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DonNarrationFrontmatter {
  rendered_at: string | null;
  source_mode: string | null;
  source_mode_mtime_or_rev: string | null;
  source_inputs_hash: string | null;
  stale_after: string | null;
  cadence_minutes: number | null;
  schema_version: string | null;
  emitter: string | null;
}

export interface DonNarrationResponse {
  schema_version: string;
  frontmatter_metadata: DonNarrationFrontmatter;
  markdown: string;
  parse_warning?: string;
}

/** Canonical path resolution; `~` expansion + env override. */
function resolveCanonicalPath(): string {
  const override = process.env.DON_NARRATION_FILE;
  if (override && override.length > 0) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : override;
  }
  return path.join(
    os.homedir(),
    ".pi",
    "orchestration-state",
    "don-narration-current.md",
  );
}

/**
 * Parse markdown-with-frontmatter into structured DonNarrationResponse.
 *
 * Frontmatter shape (simple key:value, NOT full YAML):
 *   ---
 *   rendered_at: 2026-05-28T19:50:00Z
 *   source_mode: focused-autopilot
 *   source_mode_mtime_or_rev: 2026-05-28T17:30:00Z
 *   source_inputs_hash: a1b2c3d4
 *   stale_after: 2026-05-28T20:20:00Z
 *   cadence_minutes: 30
 *   schema_version: 1.0
 *   emitter: Don (tenure-1)
 *   ---
 *   <markdown body>
 */
export function parseDonNarrationMarkdown(content: string): DonNarrationResponse {
  const result: DonNarrationResponse = {
    schema_version: "1.0",
    frontmatter_metadata: {
      rendered_at: null,
      source_mode: null,
      source_mode_mtime_or_rev: null,
      source_inputs_hash: null,
      stale_after: null,
      cadence_minutes: null,
      schema_version: null,
      emitter: null,
    },
    markdown: "",
  };

  // Extract frontmatter block: leading `---\n...\n---\n`.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let body = content;
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    const fmLines = fmMatch[1]!.split(/\r?\n/);
    for (const line of fmLines) {
      const kv = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      let value = kv[2]!.trim();
      // Strip surrounding double quotes if present.
      if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
        value = value.slice(1, -1);
      }
      if (key === "rendered_at") {
        result.frontmatter_metadata.rendered_at = value || null;
      } else if (key === "source_mode") {
        result.frontmatter_metadata.source_mode = value || null;
      } else if (key === "source_mode_mtime_or_rev") {
        result.frontmatter_metadata.source_mode_mtime_or_rev = value || null;
      } else if (key === "source_inputs_hash") {
        result.frontmatter_metadata.source_inputs_hash = value || null;
      } else if (key === "stale_after") {
        result.frontmatter_metadata.stale_after = value || null;
      } else if (key === "cadence_minutes") {
        const n = parseInt(value, 10);
        result.frontmatter_metadata.cadence_minutes = isNaN(n) ? null : n;
      } else if (key === "schema_version") {
        result.frontmatter_metadata.schema_version = value || null;
        result.schema_version = value || "1.0";
      } else if (key === "emitter") {
        result.frontmatter_metadata.emitter = value || null;
      }
    }
  }

  result.markdown = body;
  return result;
}

interface CacheEntry {
  readAt: number;
  payload: DonNarrationResponse;
}

const CACHE_TTL_MS = 5_000;
let cache: CacheEntry | null = null;

/** Reset cache (testing). */
export function _resetDonNarrationCache(): void {
  cache = null;
}

async function readDonNarration(): Promise<DonNarrationResponse> {
  const now = Date.now();
  if (cache && now - cache.readAt < CACHE_TTL_MS) {
    return cache.payload;
  }
  const filePath = resolveCanonicalPath();
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      // File missing → empty result, NOT 5xx (graceful degradation).
      const payload: DonNarrationResponse = {
        schema_version: "1.0",
        frontmatter_metadata: {
          rendered_at: null,
          source_mode: null,
          source_mode_mtime_or_rev: null,
          source_inputs_hash: null,
          stale_after: null,
          cadence_minutes: null,
          schema_version: null,
          emitter: null,
        },
        markdown: "",
        parse_warning: "file missing — Don narration state-file not yet seeded",
      };
      cache = { readAt: now, payload };
      return payload;
    }
    throw err;
  }
  let payload: DonNarrationResponse;
  try {
    payload = parseDonNarrationMarkdown(content);
  } catch (err: any) {
    payload = {
      schema_version: "1.0",
      frontmatter_metadata: {
        rendered_at: null,
        source_mode: null,
        source_mode_mtime_or_rev: null,
        source_inputs_hash: null,
        stale_after: null,
        cadence_minutes: null,
        schema_version: null,
        emitter: null,
      },
      markdown: "",
      parse_warning: `parse failed: ${err?.message ?? String(err)}`,
    };
  }
  cache = { readAt: now, payload };
  return payload;
}

export function registerDonNarrationRoutes(
  fastify: FastifyInstance,
  deps: { networkGuard: NetworkGuard },
): void {
  const { networkGuard } = deps;

  fastify.get(
    "/api/don-narration",
    { preHandler: networkGuard },
    async (_request, reply) => {
      try {
        const payload = await readDonNarration();
        return { success: true, data: payload };
      } catch (err: any) {
        reply.code(500);
        return {
          success: false,
          error: `failed to read don-narration: ${err?.message ?? String(err)}`,
        };
      }
    },
  );
}
