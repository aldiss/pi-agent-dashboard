/**
 * Pure utility functions for grouping, sorting, and filtering sessions.
 * Extracted from SessionList.tsx for reuse and testability.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import { normalizePath } from "@blackbelt-technology/pi-dashboard-shared/platform/paths.js";

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

/** Apply filter pipeline: active-only → hidden → visible sessions */
export function filterSessions(
  sessions: DashboardSession[],
  activeOnly: boolean,
  showHidden: boolean,
): DashboardSession[] {
  return sessions.filter((s) => {
    if (activeOnly && s.status === "ended") return false;
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
    if (s.status === "ended") return true;
    const lastActivity = Math.max(s.lastActivityAt ?? 0, s.startedAt);
    return lastActivity >= cutoff;
  });
}

/**
 * Coarse-grained role tier the session belongs to, for sidebar primary
 * grouping. Orthogonal to directory grouping (which becomes secondary).
 *
 * Tier order (when rendered): standing-crew → cell-executor →
 * operator-chat-pane → worker → other. Empty tiers are omitted by
 * {@link groupSessionsByTier}.
 */
export type SessionTier = "standing-crew" | "cell-executor" | "operator-chat-pane" | "worker" | "other";

/**
 * Canonical tier order used by {@link groupSessionsByTier}. Exported for
 * call sites that need to iterate tiers in display order without
 * reconstructing the list.
 */
export const SESSION_TIER_ORDER: ReadonlyArray<SessionTier> = [
  "standing-crew",
  "cell-executor",
  "operator-chat-pane",
  "worker",
  "other",
];

/**
 * Anchored at start-of-name so e.g. `"NotJoan"` does not match. All NINE
 * standing-crew names (Sol fix-cycle-2 N3: Alice + Harry were omitted — the
 * iOS-Dispatcher Harry is the 9th seat; Alice is L0.4 standing crew).
 *
 * NOTE (fix-cycle-3 M4): this retrospective tier is the PRE-STAMP fallback only.
 * The authoritative operator-vs-agent signal is the extension's FORWARD audience
 * stamp (role-registry EXACT identity, stamped on BOTH user + assistant rows at
 * message_end); a live row carries it and the classifier reads it directly. This
 * name-prefix tier is consulted ONLY for a row with no stamp (old history).
 */
const STANDING_CREW_NAME_RE = /^(Bert|Joan|Peggy|Lane|Pete|Faye|Don|Alice|Harry)(-|$)/i;

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
 *      Lane / Pete / Faye / Don / Alice / Harry — all NINE; Sol fix-cycle-2 N3
 *      added Alice + Harry) anchored at start-of-name → `standing-crew`.
 *   4. `source === "tui"` → `operator-chat-pane`.
 *   5. `source === "tmux"` AND (name contains `"cell-executor"` OR themed-PascalCase name
 *      combined with a cell-pattern indicator — `"cell"` / `"ephemeral"` / `"l2"` substring
 *      in name, or cwd containing `"/.pi/cells/"`) → `cell-executor`.
 *   6. Else → `other`.
 *
 * Matches the AGENTS.md v1.3.1 standing-crew canonical-name discipline + the
 * cell-pattern v0.4 cell-executor naming conventions; sessions that do not
 * fit either fall to `other` so the sidebar still surfaces them.
 */
export function classifyTier(session: DashboardSession): SessionTier {
  const name = session.name ?? "";
  if (SUBAGENT_WORKER_NAME_RE.test(name)) return "worker";
  if (session.sessionFile && WORKER_SESSION_FILE_RE.test(session.sessionFile)) return "worker";
  if (STANDING_CREW_NAME_RE.test(name)) return "standing-crew";
  if (session.source === "tui") return "operator-chat-pane";
  if (session.source === "tmux") {
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
