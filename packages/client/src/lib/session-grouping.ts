/**
 * Pure utility functions for grouping, sorting, and filtering sessions.
 * Extracted from SessionList.tsx for reuse and testability.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import { normalizePath } from "@blackbelt-technology/pi-dashboard-shared/platform/paths.js";
import { isNeedsYou } from "./card-state.js";
import { activityTimestamp } from "./session-card-time.js";

/**
 * Infer the server's platform from any path we've seen. Client doesn't
 * have `process.platform`; rather than adding a separate protocol round
 * trip just for grouping, we sniff: anything with a `\` or a
 * `<letter>:` drive prefix is Windows, otherwise POSIX.
 *
 * Exposed for tests so they can exercise both branches deterministically.
 */
export function inferPlatform(
  samples: Array<string | undefined>,
  override?: NodeJS.Platform,
): NodeJS.Platform {
  if (override) return override;
  for (const s of samples) {
    if (!s) continue;
    if (/^[A-Za-z]:[\\/]/.test(s) || s.includes("\\")) return "win32";
    if (s.startsWith("/")) return "linux";
  }
  return "linux";
}

/**
 * Build a key suitable for Map/Set lookup that collapses
 * cosmetic path drift (trailing separator, mixed separators,
 * drive-letter case on Windows, case on macOS). The original
 * display path is retained on the group's `cwd` field.
 *
 * Case folding for Windows/macOS happens here so a naive
 * string-keyed Map can host same-path entries.
 *
 * See change: platform-path-normalization.
 */
function pathKey(p: string, platform: NodeJS.Platform): string {
  const normalized = normalizePath(p, platform);
  // Match samePath's folding: case-insensitive on win32/darwin,
  // case-sensitive on linux.
  if (platform === "linux") return normalized;
  return normalized.toLowerCase();
}

export interface DirectoryGroup {
  cwd: string;
  sessions: DashboardSession[];
  pinned: boolean;
}

/** Sort sessions within a group by server order, then by startedAt descending for unordered ones. */
export function sortSessionsByOrder(sessions: DashboardSession[], order?: string[]): DashboardSession[] {
  if (!order || order.length === 0) {
    return [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  }
  const orderIndex = new Map(order.map((id, i) => [id, i]));
  const ordered: DashboardSession[] = [];
  const unordered: DashboardSession[] = [];
  for (const s of sessions) {
    if (orderIndex.has(s.id)) {
      ordered.push(s);
    } else {
      unordered.push(s);
    }
  }
  ordered.sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!);
  unordered.sort((a, b) => b.startedAt - a.startedAt);
  return [...ordered, ...unordered];
}

/** Get unified order of session + terminal IDs for a group. */
export function getUnifiedOrder(sessions: DashboardSession[], terminals: TerminalSession[], order?: string[]): string[] {
  const allIds = new Set([...sessions.map((s) => s.id), ...terminals.map((t) => t.id)]);
  if (!order || order.length === 0) {
    // Default: terminals first (newest first), then sessions (newest first)
    return [
      ...terminals.sort((a, b) => b.createdAt - a.createdAt).map((t) => t.id),
      ...sessions.sort((a, b) => b.startedAt - a.startedAt).map((s) => s.id),
    ];
  }
  const ordered = order.filter((id) => allIds.has(id));
  const unordered = [...allIds].filter((id) => !new Set(ordered).has(id));
  return [...ordered, ...unordered];
}

/**
 * Resolve a session's group-key path. Priority order:
 *   1. Explicit pin wins — if `pathKey(cwd)` matches a pinned entry, the
 *      session groups under its own cwd.
 *   2. Else falls back to `cwd`.
 *
 * Exported for tests; consumed by `groupSessionsByDirectory`.
 */
export function resolveSessionGroupPath(
  session: DashboardSession,
  pinnedKeys: Set<string>,
  platform: NodeJS.Platform,
): string {
  // Worktree sessions group under their parent repo (groupCwd)
  const cwd = session.groupCwd ?? session.cwd;
  const cwdKey = pathKey(cwd, platform);
  if (pinnedKeys.has(cwdKey)) return cwd;
  return cwd;
}

/**
 * Group sessions by cwd, with pinned directories first (in pinned order),
 * then unpinned sorted by recency.
 *
 * Keyed by `pathKey(cwd)` to collapse cosmetic drift (trailing separator,
 * separator style, case on Windows/macOS). The `cwd` field on each group
 * keeps the original path for display. Pass `platform` (from
 * `BrowseResult.platform` or a session event) for OS-correct matching;
 * falls back to `process.platform` when absent.
 */
export function groupSessionsByDirectory(
  sessions: DashboardSession[],
  orderMap?: Map<string, string[]>,
  pinnedDirectories?: string[],
  platform?: NodeJS.Platform,
): { pinned: DirectoryGroup[]; unpinned: DirectoryGroup[] } {
  const plat = inferPlatform(
    [
      ...sessions.map((s) => s.cwd),
      ...(pinnedDirectories ?? []),
    ],
    platform,
  );

  // Pinned set is computed first so the per-session resolver can honour
  // the pin-wins rule.
  const pinnedKeys = new Set((pinnedDirectories ?? []).map((d) => pathKey(d, plat)));

  // groups keyed by canonical key; value carries original-display cwd + sessions
  const groups = new Map<string, { cwd: string; sessions: DashboardSession[] }>();
  for (const session of sessions) {
    const groupPath = resolveSessionGroupPath(session, pinnedKeys, plat);
    const key = pathKey(groupPath, plat);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(key, { cwd: groupPath, sessions: [session] });
    }
  }

  // Build pinned groups in pinned order (including zero-session groups).
  const pinned: DirectoryGroup[] = [];
  for (const dir of pinnedDirectories ?? []) {
    const key = pathKey(dir, plat);
    const group = groups.get(key);
    const ordered = sortSessionsByOrder(
      group?.sessions ?? [],
      orderMap?.get(dir) ?? orderMap?.get(group?.cwd ?? ""),
    );
    pinned.push({
      cwd: dir,
      sessions: ordered,
      pinned: true,
    });
  }

  // Build unpinned groups sorted by most recent activity
  const unpinned = Array.from(groups.entries())
    .filter(([key]) => !pinnedKeys.has(key))
    .map(([, g]) => ({
      cwd: g.cwd,
      sessions: sortSessionsByOrder(g.sessions, orderMap?.get(g.cwd)),
      pinned: false,
    }))
    .sort((a, b) => {
      const aMax = Math.max(...a.sessions.map((s) => s.startedAt));
      const bMax = Math.max(...b.sessions.map((s) => s.startedAt));
      return bMax - aMax;
    });

  return { pinned, unpinned };
}

/**
 * Within a single tier, split sessions into directory folders (the default,
 * `groupByFolder === true`) or collapse them into ONE flat bucket
 * (`groupByFolder === false`) with no directory sub-grouping.
 *
 * Powers the sidebar "Folders" on/off toggle: ON preserves the nested
 * tier→directory view; OFF yields flat tier-buckets. The flat bucket carries
 * `flatKey` as its `cwd` so per-tier UI state (ended-toggle, test ids) stays
 * stable across tiers — pass a tier-unique key from the caller. Returns `[]`
 * for empty input so callers can omit empty tiers.
 */
export function groupTierByFolder(
  sessions: DashboardSession[],
  groupByFolder: boolean,
  orderMap?: Map<string, string[]>,
  flatKey = "",
): DirectoryGroup[] {
  if (sessions.length === 0) return [];
  if (!groupByFolder) {
    return [{ cwd: flatKey, sessions: [...sessions], pinned: false }];
  }
  return groupSessionsByDirectory(sessions, orderMap, []).unpinned;
}

/** Apply filter pipeline: active-only → hidden → visible sessions */
export function filterSessions(
  sessions: DashboardSession[],
  activeOnly: boolean,
  showHidden: boolean,
): DashboardSession[] {
  return sessions.filter((s) => {
    if (activeOnly && (s.status === "ended" || s.endedAt != null)) return false;
    if (s.hidden && !showHidden) return false;
    return true;
  });
}

/**
 * Hide "stale-active" sessions — those whose status is not `ended` but which
 * haven't seen activity in {@link staleHoursThreshold} hours. Activity is
 * judged from `max(lastActivityAt, startedAt)`, since cold-started sessions
 * may lack `lastActivityAt` until the first server event arrives.
 *
 * The currently-selected session (if any) is always preserved so the user
 * doesn't lose context when the filter sweeps. `staleHoursThreshold <= 0`
 * OR `hideStale === false` disables the filter entirely (input passes through).
 *
 * Ended sessions are intentionally NOT filtered here — their visibility is
 * governed by the existing per-folder "show ended" affordance.
 */
export function filterStaleSessions(
  sessions: DashboardSession[],
  staleHoursThreshold: number,
  hideStale: boolean,
  now: number,
  selectedId?: string,
): DashboardSession[] {
  if (!hideStale) return sessions;
  if (!Number.isFinite(staleHoursThreshold) || staleHoursThreshold <= 0) return sessions;
  const cutoff = now - staleHoursThreshold * 3600 * 1000;
  return sessions.filter((s) => {
    if (s.id === selectedId) return true;
    // FIX-C3 client defense: endedAt-set ⟹ ended (projectSession already normalizes
    // status, but a legacy/unprojected row is caught here) → never rendered stale-active.
    if (s.status === "ended" || s.endedAt != null) return true;
    // FIX-C2: a live bridge socket (bridgeConnected === true, projected from
    // isSessionConnected) is never stale-hidden. STRICT === true; absent/legacy
    // falls through to the cutoff test (fail-closed).
    if (s.bridgeConnected === true) return true;
    // Use the canonical activityTimestamp (build-2 fix-cycle NIT 2 wiring): same
    // semantics as the prior inline `Math.max(lastActivityAt ?? 0, startedAt)`
    // for a live row, but with the shared stale/NaN guard so misbanding can't
    // slip in via a partially-populated row.
    return activityTimestamp(s) >= cutoff;
  });
}

/**
 * Coarse-grained role tier the session belongs to, for sidebar primary
 * grouping. Orthogonal to directory grouping (which becomes secondary).
 *
 * Tier order (when rendered): standing-crew → external → drivers →
 * cell-executor → operator-chat-pane → worker → other. Empty tiers are omitted
 * by {@link groupSessionsByTier}. `drivers` sits above `cell-executor` because
 * pi-drivers are L2 orchestration peers, above cell-internal workers.
 * `external` (read-only Codex / Claude Code tmux panes) sits directly below
 * `standing-crew`: measured on the live dashboard, placing it under `drivers`
 * pushed its header 5075px down the list — rendered, but unreachable without a
 * long scroll, which defeats the point of showing them at all.
 */
export type SessionTier = "standing-crew" | "external" | "drivers" | "cell-executor" | "operator-chat-pane" | "worker" | "other";

/**
 * Canonical tier order used by {@link groupSessionsByTier}. Exported for
 * call sites that need to iterate tiers in display order without
 * reconstructing the list.
 */
export const SESSION_TIER_ORDER: ReadonlyArray<SessionTier> = [
  "standing-crew",
  "external",
  "drivers",
  "cell-executor",
  "operator-chat-pane",
  "worker",
  "other",
];

/**
 * Anchored at start-of-name so e.g. `"NotJoan"` does not match. All TEN
 * standing-crew names (Sol fix-cycle-2 N3: Alice + Harry — the iOS-Dispatcher
 * Harry is the 9th seat; Alice is L0.4 standing crew. Dawn is the 10th — the
 * L0.5f recorder seat, ratified 2026-07-30 per AGENTS.md §1, added here
 * 2026-08-14). Sister to the extension's own name regex
 * (`audience.ts:STANDING_CREW_NAME_RE`), which is tracked separately.
 *
 * Dawn's omission was not cosmetic: her sessions are `source: "tmux"` from
 * `~/.pi/orchestration-state` (no `nos-cells/`, no `-driver` segment) and her
 * name carries a single capital, so {@link THEMED_NAME_RE} — which needs two —
 * missed her too and she fell all the way through to `other`. She is a
 * positional seat, not a judgment peer, but she is operator-addressed, and this
 * regex governs where the operator sees her.
 *
 * The trailing negative-lookahead `(?![A-Za-z])` accepts ANY non-letter boundary
 * after the canonical name — hyphen (`Joan-tenure-23`), space + em-dash
 * (`Don — Don tenure-4 …`), or end-of-string (`Alice`) — while still rejecting a
 * longer word that merely starts with a crew name (`Donna`, `Petersen`).
 * Broadened from the old `(-|$)` which missed the `" — …"` status-suffix shape
 * (Don/Alice grouping fix 2026-06-26). This merge keeps BOTH: the 9th name
 * (Harry, build-1) AND the stronger boundary (prod).
 *
 * NOTE (fix-cycle-3 M4 + B2): this tier is the PRE-STAMP audience fallback ONLY,
 * and after B2 it no longer feeds the audience path at all — the authoritative
 * operator-vs-agent signal is the extension's FORWARD audience stamp
 * (role-registry EXACT identity, stamped on BOTH user + assistant rows at
 * message_end), and pre-stamp history uses the positive-evidence
 * `historicalAudience` (message-filter-classifier.ts), NOT this name regex (G3
 * closed). `classifyTier` now drives SIDEBAR grouping only.
 */
const STANDING_CREW_NAME_RE = /^(Bert|Joan|Peggy|Lane|Pete|Faye|Don|Alice|Harry|Dawn)(?![A-Za-z])/i;

/** Subagent worker by name (e.g. `subagent-worker-3f4a…`). */
const SUBAGENT_WORKER_NAME_RE = /^subagent-worker-[0-9a-f]/i;

/** Cell-internal worker subagent by session-file path (`…/run-<n>/session.jsonl`). */
const WORKER_SESSION_FILE_RE = /\/run-\d+\/session\.jsonl$/;

/** Themed-name pattern: PascalCase compound (`OakHawk`, `UltraMoon`, …). */
const THEMED_NAME_RE = /^[A-Z][a-z]+[A-Z][a-z]+/;

/**
 * Classify a session into a {@link SessionTier} for sidebar grouping.
 *
 * Decision order (first match wins):
 *   1. `name` matches `subagent-worker-…` → `worker`.
 *   2. `sessionFile` path ends `/run-N/session.jsonl` (cell-internal worker) → `worker`.
 *   3. `name` starts with a standing-crew canonical name (Bert / Joan / Peggy /
 *      Lane / Pete / Faye / Don / Alice / Harry / Dawn — all TEN; Sol
 *      fix-cycle-2 N3 added Alice + Harry, Dawn added 2026-08-14) anchored at
 *      start-of-name → `standing-crew`.
 *   4. `source === "tui"` → `operator-chat-pane`.
 *   5. `source === "tmux"` AND `isRegisteredDriver` (server-stamped from the
 *      driver registry) → `drivers`. The AUTHORITATIVE signal; consulted before
 *      the cwd heuristic below because drivers are spawned into arbitrary
 *      working directories.
 *   6. `source === "tmux"` AND cwd under `nos-cells/` (or a `-driver` cell-id
 *      outside `/.pi/cells/`) → `drivers`. Retained as a FALLBACK for drivers
 *      the registry does not know about.
 *   7. `source === "tmux"` AND (name contains `"cell-executor"` OR themed-PascalCase name
 *      combined with a cell-pattern indicator — `"cell"` / `"ephemeral"` / `"l2"` substring
 *      in name, or cwd containing `"/.pi/cells/"`) → `cell-executor`.
 *   8. Else → `other`.
 *
 * Matches the AGENTS.md v1.3.1 standing-crew canonical-name discipline + the
 * cell-pattern v0.4 cell-executor naming conventions; sessions that do not
 * fit either fall to `other` so the sidebar still surfaces them.
 */
export function classifyTier(session: DashboardSession): SessionTier {
  const name = session.name ?? "";
  // Read-only external panes (Codex / Claude Code) classify FIRST and
  // unconditionally. Without this they fall through the name/source heuristics
  // into `other`, which is default-collapsed, so the operator sees none of them
  // on load — the exact complaint this surface exists to answer. Their own tier
  // is default-expanded (see DEFAULT_EXPANDED_TIERS in SessionList).
  if (session.external) return "external";
  if (SUBAGENT_WORKER_NAME_RE.test(name)) return "worker";
  if (session.sessionFile && WORKER_SESSION_FILE_RE.test(session.sessionFile)) return "worker";
  if (STANDING_CREW_NAME_RE.test(name)) return "standing-crew";
  if (session.source === "tui") return "operator-chat-pane";
  if (session.source === "tmux") {
    // pi-drivers (L2 orchestration) are identified from the AUTHORITATIVE driver
    // registry (`cell-driver-registry.json`, written by `spawn-driver` at spawn),
    // stamped server-side onto `isRegisteredDriver`. This runs BEFORE the cwd
    // heuristic because drivers are spawned into arbitrary working directories —
    // Seatwright runs from `~/.pi/orchestration-state`, Branchwright from a plain
    // product-repo checkout — so no path- or name-shaped rule can catch them.
    // Ordering is load-bearing: the worker + standing-crew checks above still run
    // first, so a standing-crew seat that ALSO has a registry row (all nine do)
    // is never reclassified as a driver.
    // See change: classify-drivers-from-registry.
    if (session.isRegisteredDriver) return "drivers";

    // Fallback for a driver the registry does not know about (registered by
    // another path, or an unreadable registry). Keyed on cwd — NOT a themed-name
    // regex — because driver names are often single-word PascalCase (Vault,
    // Harbor, Keystone) or absent (the arch-diagram-driver tmux peer has no
    // name), which the compound THEMED_NAME_RE would miss. Distinct from
    // cell-executors: drivers are nos-cells/, cell-executors are /.pi/cells/
    // (nos-cells/ ≠ /.pi/cells/). The "-driver" cell-id fallback is guarded so
    // it never swallows a /.pi/cells/ cell-executor.
    const cwd = session.cwd ?? "";
    if (cwd.includes("nos-cells/") || (cwd.includes("-driver") && !cwd.includes("/.pi/cells/"))) {
      return "drivers";
    }
    if (name.includes("cell-executor")) return "cell-executor";
    if (THEMED_NAME_RE.test(name)) {
      const lower = name.toLowerCase();
      const inCellsCwd = (session.cwd ?? "").includes("/.pi/cells/");
      const cellIndicatorInName =
        lower.includes("cell") || lower.includes("ephemeral") || lower.includes("l2");
      if (cellIndicatorInName || inCellsCwd) return "cell-executor";
    }
  }
  return "other";
}

/**
 * Group sessions by tier in canonical display order. Tiers with zero
 * sessions are omitted from the returned Map; the Map's iteration order
 * matches {@link SESSION_TIER_ORDER} so callers can render headers directly.
 *
 * Within each tier, sessions are returned in their original input order;
 * call {@link groupSessionsByDirectory} on each tier's sessions for the
 * secondary directory grouping.
 */
export function groupSessionsByTier(
  sessions: DashboardSession[],
): Map<SessionTier, DashboardSession[]> {
  const buckets = new Map<SessionTier, DashboardSession[]>();
  for (const tier of SESSION_TIER_ORDER) buckets.set(tier, []);
  for (const s of sessions) {
    buckets.get(classifyTier(s))!.push(s);
  }
  const result = new Map<SessionTier, DashboardSession[]>();
  for (const tier of SESSION_TIER_ORDER) {
    const arr = buckets.get(tier)!;
    if (arr.length > 0) result.set(tier, arr);
  }
  return result;
}

/**
 * Case-insensitive substring search over a folder's session list.
 * Matches against the same string the user actually sees on the card:
 *   1. `name` (if non-empty)
 *   2. `firstMessage` (if no name)
 *   3. last segment of `cwd` (if neither, e.g. fresh sessions where
 *      the display falls back to the folder basename — this is what
 *      `getSessionDisplayName` does, so search must mirror it)
 * Empty/whitespace queries return the input unchanged.
 *
 * Mirrors `getSessionDisplayName` to keep "what you see is what you
 * search" — a session showing as "pi-shodh" must match a `pi-sho` query
 * even when its underlying `name` and `firstMessage` are empty.
 *
 * The caller is responsible for applying `showHidden` filtering before
 * search (typically via the standard `filterSessions` pipeline).
 *
 * See change: pin-and-search-sessions §8.
 */
export function filterByQuery<
  T extends { name?: string; firstMessage?: string; cwd?: string },
>(sessions: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...sessions];
  return sessions.filter((s) => {
    const name = s.name?.trim();
    if (name) return name.toLowerCase().includes(q);
    const fm = s.firstMessage?.trim();
    if (fm) return fm.toLowerCase().includes(q);
    const basename = s.cwd?.split("/").pop() ?? "";
    return basename.toLowerCase().includes(q);
  });
}

/**
 * Stable rank: alive sessions (status ≠ "ended") above ended sessions,
 * preserving relative order within each tier. Used to order session
 * cards inside a folder so the user always sees their currently-active
 * work at the top, regardless of when ended sessions were last updated.
 *
 * The previous "Active only" toggle is replaced by this universal sort
 * (see design D1 revised): rather
 * than hiding ended sessions outright, we keep them visible but ranked
 * below active ones, so search and exploration both see the same set.
 *
 * See change: pin-and-search-sessions (design D1 revised).
 */
export function rankActiveFirst<T extends { status?: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const aEnded = a.status === "ended" ? 1 : 0;
    const bEnded = b.status === "ended" ? 1 : 0;
    return aEnded - bEnded;
  });
}

/**
 * Stable-partition a list of already-ordered session ids so that band-1
 * (needs-you: `ask_user` ∨ `unseenServerError`) rises to the TOP of the ALIVE
 * zone, while everything else keeps its incoming relative order (build-2 P0
 * fix #10 + #3).
 *
 * Applied AFTER the persisted-order `allIds` base is built — the persisted
 * drag-order / recency is the base, and this only lifts genuine needs within
 * the alive partition. Pins / folder / tier boundaries live ABOVE this seam
 * (they wrap whole groups), and ended cards are NEVER lifted — a corpse does
 * not rise into the needs band (an ended row that still carries
 * `unseenServerError` is surfaced by the fleet-brief, not by re-sorting the
 * dead-tail). No second lane: this is a stable in-place partition of ONE list.
 *
 * Three stable partitions, in order:
 *   1. alive + needs-you   (order preserved)
 *   2. alive + calm        (order preserved)
 *   3. ended               (order preserved — stays at the tail)
 *
 * Pure. Returns a new id array; ids with no session in `sessionMap` are kept
 * in their incoming position within the calm/alive band (defensive).
 * See change: build-2-dashboard-v3.
 */
export function stablePartitionByBand(
  ids: string[],
  sessionMap: Map<string, DashboardSession>,
): string[] {
  const needs: string[] = [];
  const calm: string[] = [];
  const ended: string[] = [];
  for (const id of ids) {
    const s = sessionMap.get(id);
    if (!s) { calm.push(id); continue; }
    if (s.status === "ended" || s.endedAt != null) { ended.push(id); continue; }
    if (isNeedsYou(s)) { needs.push(id); continue; }
    calm.push(id);
  }
  return [...needs, ...calm, ...ended];
}
