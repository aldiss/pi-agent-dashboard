/**
 * Fixture loader for the FROZEN determinism-model wire contract (dl-13481).
 *
 * THE BIND TARGET is exactly one file: `_fixture/fixture-c23c8d47.json` at the
 * worktree root — sha256 `c23c8d47…`, 1911 bytes, extracted from frozen commit
 * `6d4b412c`. This module reads THAT FILE ONLY. It deliberately does NOT read the
 * arch-diagram-driver `_model/` source or any live/working-tree copy of the
 * projections (an hourly cron mutates that tree); the extracted fixture is the
 * immutable bind target for this fixture-bound phase — zero live coupling.
 *
 * Node/fs ONLY. This module is imported by the server route and the Node test
 * suites — NEVER by the React overlay component (which stays browser-safe and
 * consumes projections through an injected fetcher). Keeping the fs read out of
 * the client bundle is deliberate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  type DeterminismProjection,
  type PendingTransition,
  unmappedProjection,
} from "./determinism-projection.js";

// ── frozen provenance (the immutable bind target) ──────────────────────────

/** The one file this module reads — never a repo path, never `_model/`. */
export const FIXTURE_FILENAME = "fixture-c23c8d47.json";
/** sha256 of the frozen fixture bytes (full digest; brief quotes `c23c8d47…`). */
export const FIXTURE_SHA256 =
  "c23c8d479fe3866495a68b007015122e70661a1115a95207d30f46aa67f5bec3";
/** Exact byte length of the frozen fixture. */
export const FIXTURE_BYTES = 1911;
/** The frozen commit the fixture was extracted from. */
export const FIXTURE_COMMIT = "6d4b412c";
/** One-line provenance string for the build report. */
export const FIXTURE_PROVENANCE = `${FIXTURE_FILENAME} sha ${FIXTURE_SHA256.slice(0, 8)} @ frozen ${FIXTURE_COMMIT}`;

// ── the parsed fixture file ────────────────────────────────────────────────

/** Top-level shape of the extracted fixture: metadata + the 3 projections. */
export interface DeterminismFixtureFile {
  _artifact: string;
  _machine: string;
  _generated: string;
  samples: DeterminismProjection[];
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path of the bind-target fixture by walking UP from this
 * module until a `_fixture/<FIXTURE_FILENAME>` exists. Robust to cwd and to
 * whether the code runs from `src/` (tsx/jiti) or a built `dist/`. Throws a
 * loud, explicit error if the frozen fixture is absent — a missing bind target
 * is a setup failure, never silently degraded.
 */
export function resolveFixturePath(): string {
  let dir = MODULE_DIR;
  for (;;) {
    const candidate = path.join(dir, "_fixture", FIXTURE_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(
    `determinism fixture not found: no _fixture/${FIXTURE_FILENAME} above ${MODULE_DIR} — the frozen bind target is missing`,
  );
}

/** Read the raw fixture bytes + their sha256 (for the provenance assertion). */
export function readFixtureProvenance(): { bytes: number; sha256: string; path: string } {
  const filePath = resolveFixturePath();
  const buf = fs.readFileSync(filePath);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), path: filePath };
}

/**
 * Coerce one raw sample into a typed `DeterminismProjection`, keeping ONLY the
 * five contract fields (+ optional `stage_meaning`) and dropping the per-kind
 * branch of each pending edge to its declared discriminant. Defensive but
 * faithful: it never fabricates a stage and never throws on a well-formed
 * sample. Unknown `kind` values are dropped (they are not part of the frozen
 * contract) rather than mis-tagged.
 */
function asProjection(raw: unknown): DeterminismProjection {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawPending = Array.isArray(r.pending) ? r.pending : [];
  const pending: PendingTransition[] = [];
  for (const item of rawPending) {
    const p = (item ?? {}) as Record<string, unknown>;
    if (p.kind === "deterministic") {
      pending.push({
        to: String(p.to),
        kind: "deterministic",
        via_event: String(p.via_event),
        gate: String(p.gate ?? ""),
      });
    } else if (p.kind === "judgment") {
      pending.push({
        to: String(p.to),
        kind: "judgment",
        via_event: String(p.via_event),
        who: String(p.who ?? ""),
      });
    }
  }
  const degrade =
    r.degrade === "unmapped" || r.degrade === "spine-only" ? r.degrade : null;
  const projection: DeterminismProjection = {
    thread_id: String(r.thread_id),
    machine: String(r.machine ?? ""),
    stage: typeof r.stage === "string" ? r.stage : null,
    pending,
    degrade,
  };
  if (typeof r.stage_meaning === "string") projection.stage_meaning = r.stage_meaning;
  return projection;
}

/**
 * Load + parse the frozen fixture file (the 3 sample projections + metadata).
 * Reads the bind target ONLY. Throws if the file is missing or unparseable — a
 * corrupt bind target is a hard setup failure, not a degrade.
 */
export function loadDeterminismFixture(): DeterminismFixtureFile {
  const filePath = resolveFixturePath();
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const rawSamples = Array.isArray(parsed.samples) ? parsed.samples : [];
  return {
    _artifact: String(parsed._artifact ?? ""),
    _machine: String(parsed._machine ?? ""),
    _generated: String(parsed._generated ?? ""),
    samples: rawSamples.map(asProjection),
  };
}

/** Load the fixture as a `thread_id → projection` map (one read, indexed). */
export function loadDeterminismProjectionMap(): Map<string, DeterminismProjection> {
  const file = loadDeterminismFixture();
  return new Map(file.samples.map((s) => [s.thread_id, s]));
}

/**
 * Build the FIXTURE-BACKED `determinismFetcher(threadId) → Promise<Projection>`
 * — the injectable sister of `handoffFetcher`, resolving from the frozen
 * `samples[]` keyed by `thread_id`. An unknown thread resolves to a
 * `degrade:"unmapped"` projection (`stage:null`) — never a throw, never null,
 * never a fabricated stage. Loads the fixture ONCE (eager, indexed) and closes
 * over the map, so each call is a synchronous lookup wrapped in a resolved
 * promise (the async signature matches the live REST fetcher exactly).
 */
export function makeFixtureDeterminismFetcher(): (threadId: string) => Promise<DeterminismProjection> {
  const byId = loadDeterminismProjectionMap();
  return async (threadId: string): Promise<DeterminismProjection> =>
    byId.get(threadId) ?? unmappedProjection(threadId);
}
