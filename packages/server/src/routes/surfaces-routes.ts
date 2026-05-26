/**
 * Active operator surfaces REST API route.
 *
 * Exposes `GET /api/operator-active-surfaces` returning the parsed contents of
 * the canonical `~/.pi/orchestration-state/operator-active-surfaces-current.md`
 * state file (markdown-with-frontmatter shape).
 *
 * Path B sister-coupling primitive per AGENTS.md v1.4.4 deck-surfacing
 * discipline + Bert tenure-5 d20 architect-of-coherence ratification
 * 2026-05-23 ~21:00 CEST. Sister-shape to v1.1 operator-state.json
 * release_at lifecycle pattern.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.4 + W6 Feature 4).
 *
 * File-missing → 200 with empty `surfaces[]` array (graceful degradation per
 * pi-task-spine canonical pattern). Malformed-markdown → 200 with empty array
 * + `parse_warning` field. 5s in-memory cache reduces fs hit storm during 10s
 * polling burst from multiple browser clients.
 */
import type { FastifyInstance } from "fastify";
import type { NetworkGuard } from "./route-deps.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Lifecycle states per Bert tenure-5 d20 ratification 2026-05-23 ~21:00 CEST (b.3). */
export type LifecycleState = "active" | "expiring" | "expired" | "archived";

/** Finding-tier per AGENTS.md v1.4.2 A/B/C gradation. */
export type SurfaceTier = "A" | "B" | "C";

/** Surface-type canonical enum (matches client icon mapping). */
export type SurfaceType = "deck" | "spec" | "brief" | "substrate" | "session-log" | "other";

/**
 * Operator-action canonical enum per pi-config CLI extension 2026-05-26 + Joan
 * tenure-27 operator-direct ratification verbatim per Pattern 87:
 * *"we need to distinguish cleanly between the items where there are actions on me?"*.
 * 5-value enum; default 'none' (informational surface; no operator action required);
 * `ratify`/`push`/`review`/`decide` distinguish the four operator-action shapes.
 */
export type OperatorAction = "none" | "ratify" | "push" | "review" | "decide";

export interface ActiveSurface {
  id: string;
  url: string | null;
  path: string | null;
  emitter: string;
  timestamp: string;
  brief_description: string;
  surface_type: SurfaceType;
  tier: SurfaceTier;
  expires_at: string | null;
  lifecycle_state: LifecycleState;
  /** Default 'none' when not specified in canonical state-file (backward-compat). */
  operator_action: OperatorAction;
}

export interface ActiveSurfacesResponse {
  schema_version: string;
  updated_at: string | null;
  updated_by: string | null;
  surfaces: ActiveSurface[];
  parse_warning?: string;
}

/** Canonical path resolution; `~` expansion + env override. */
function resolveCanonicalPath(): string {
  const override = process.env.OPERATOR_ACTIVE_SURFACES_FILE;
  if (override && override.length > 0) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : override;
  }
  return path.join(os.homedir(), ".pi", "orchestration-state", "operator-active-surfaces-current.md");
}

/**
 * Parse markdown-with-frontmatter into structured ActiveSurfacesResponse.
 *
 * Frontmatter shape (simple key:value, NOT full YAML):
 *   ---
 *   schema_version: 1.0
 *   updated_at: 2026-05-23T19:21:31Z
 *   updated_by: ZenNova
 *   ---
 *
 * Surface entry shape:
 *   ### <surface-id>
 *
 *   - **URL:** <value-or-null>
 *   - **Path:** <value>
 *   - **Emitter:** <name>
 *   - **Timestamp:** <ISO>
 *   - **Brief description:** <text>
 *   - **Surface type:** deck|spec|brief|substrate|session-log|other
 *   - **Tier:** A|B|C
 *   - **Expires at:** <ISO-or-null>
 *   - **Lifecycle state:** active|expiring|expired|archived
 *   - **Operator action:** none|ratify|push|review|decide  (optional; default 'none' for backward-compat)
 */
export function parseActiveSurfacesMarkdown(content: string): ActiveSurfacesResponse {
  const result: ActiveSurfacesResponse = {
    schema_version: "1.0",
    updated_at: null,
    updated_by: null,
    surfaces: [],
  };

  // Extract frontmatter block: leading `---\n...\n---\n`.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let body = content;
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    const fmLines = fmMatch[1]!.split(/\r?\n/);
    for (const line of fmLines) {
      // Skip array-of-objects-style _comment that wraps to multiple lines —
      // we only need scalar top-level fields.
      const kv = line.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      let value = kv[2]!.trim();
      // Strip surrounding double quotes if present.
      if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
        value = value.slice(1, -1);
      }
      if (key === "schema_version") result.schema_version = value;
      else if (key === "updated_at") result.updated_at = value || null;
      else if (key === "updated_by") result.updated_by = value || null;
    }
  }

  // Extract surface entries. Split on `### ` H3 boundaries; each chunk is
  // owned by the surface id on the heading line. Use a split-based approach
  // rather than a single regex with `\Z` lookahead (JS regex does not support
  // `\Z` — it would be treated as literal `Z` and the last entry would be
  // skipped). Boundary handling: a chunk ends when the next `###` heading
  // starts OR when a higher-level `##` heading starts OR at end-of-string.
  const chunks = body.split(/^###\s+/m);
  // First chunk is the prologue (before the first ### heading) — skip.
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const nlIdx = chunk.search(/\r?\n/);
    if (nlIdx < 0) continue;
    const id = chunk.slice(0, nlIdx).trim();
    let block = chunk.slice(nlIdx + 1);
    // Strip trailing content that starts a non-### section at this level.
    const stopMatch = block.match(/\n##(?!#)\s/);
    if (stopMatch && stopMatch.index !== undefined) {
      block = block.slice(0, stopMatch.index);
    }
    const fields: Record<string, string | null> = {};
    const bulletRe = /^\s*-\s*\*\*([^:*]+?):\*\*\s*(.*)$/gm;
    let b: RegExpExecArray | null;
    while ((b = bulletRe.exec(block)) !== null) {
      const k = b[1]!.trim().toLowerCase();
      const v = b[2]!.trim();
      fields[k] = v.toLowerCase() === "null" || v === "" ? null : v;
    }
    // Validate required fields; skip entries that fail.
    const emitter = fields["emitter"];
    const timestamp = fields["timestamp"];
    if (!emitter || !timestamp) continue;
    const surfaceTypeRaw = (fields["surface type"] ?? "other").toLowerCase();
    const surface_type: SurfaceType = (
      ["deck", "spec", "brief", "substrate", "session-log", "other"].includes(surfaceTypeRaw)
        ? surfaceTypeRaw
        : "other"
    ) as SurfaceType;
    const tierRaw = (fields["tier"] ?? "C").toUpperCase();
    const tier: SurfaceTier = (["A", "B", "C"].includes(tierRaw) ? tierRaw : "C") as SurfaceTier;
    const lifecycleRaw = (fields["lifecycle state"] ?? "active").toLowerCase();
    const lifecycle_state: LifecycleState = (
      ["active", "expiring", "expired", "archived"].includes(lifecycleRaw)
        ? lifecycleRaw
        : "active"
    ) as LifecycleState;
    const operatorActionRaw = (fields["operator action"] ?? "none").toLowerCase();
    const operator_action: OperatorAction = (
      ["none", "ratify", "push", "review", "decide"].includes(operatorActionRaw)
        ? operatorActionRaw
        : "none"
    ) as OperatorAction;

    result.surfaces.push({
      id,
      url: fields["url"] ?? null,
      path: fields["path"] ?? null,
      emitter,
      timestamp,
      brief_description: fields["brief description"] ?? "",
      surface_type,
      tier,
      expires_at: fields["expires at"] ?? null,
      lifecycle_state,
      operator_action,
    });
  }
  return result;
}

interface CacheEntry {
  readAt: number;
  payload: ActiveSurfacesResponse;
}

const CACHE_TTL_MS = 5_000;
let cache: CacheEntry | null = null;

/** Reset cache (testing). */
export function _resetActiveSurfacesCache(): void {
  cache = null;
}

async function readActiveSurfaces(): Promise<ActiveSurfacesResponse> {
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
      const payload: ActiveSurfacesResponse = {
        schema_version: "1.0",
        updated_at: null,
        updated_by: null,
        surfaces: [],
      };
      cache = { readAt: now, payload };
      return payload;
    }
    throw err;
  }
  let payload: ActiveSurfacesResponse;
  try {
    payload = parseActiveSurfacesMarkdown(content);
  } catch (err: any) {
    payload = {
      schema_version: "1.0",
      updated_at: null,
      updated_by: null,
      surfaces: [],
      parse_warning: `parse failed: ${err?.message ?? String(err)}`,
    };
  }
  cache = { readAt: now, payload };
  return payload;
}

export function registerSurfacesRoutes(
  fastify: FastifyInstance,
  deps: { networkGuard: NetworkGuard },
): void {
  const { networkGuard } = deps;

  fastify.get(
    "/api/operator-active-surfaces",
    { preHandler: networkGuard },
    async (_request, reply) => {
      try {
        const payload = await readActiveSurfaces();
        return { success: true, data: payload };
      } catch (err: any) {
        reply.code(500);
        return {
          success: false,
          error: `failed to read operator-active-surfaces: ${err?.message ?? String(err)}`,
        };
      }
    },
  );
}
