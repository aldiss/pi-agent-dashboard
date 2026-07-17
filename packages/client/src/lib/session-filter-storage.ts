const LEGACY_HIDDEN_KEY = "dashboard:hiddenSessions";
const ACTIVE_ONLY_KEY = "dashboard:activeOnly";
const COLLAPSED_GROUPS_KEY = "dashboard:collapsedGroups";
const STALE_HOURS_KEY = "dashboard:staleHours";
const HIDE_STALE_KEY = "dashboard:hideStale";
const GROUP_BY_FOLDER_KEY = "dashboard:groupByFolder";
/** Last time the operator saw the fleet-brief (visible view). Sister to the
 *  other `dashboard:*` keys. Drives the finished-unseen window cutoff.
 *  See change: build-2-dashboard-v3 (P0 fix #5 + #6). */
const LAST_BRIEF_VIEW_KEY = "dashboard:lastBriefViewAt";

/** Default stale-active threshold (hours of no activity before a non-ended session is treated as stale). */
const DEFAULT_STALE_HOURS = 24;

function getStorage(): Storage {
  return window.localStorage;
}

/** Remove legacy client-side hidden sessions key (server-side hidden is now source of truth) */
export function removeLegacyHiddenSessions(): void {
  try {
    getStorage().removeItem(LEGACY_HIDDEN_KEY);
  } catch { /* ignore */ }
}

export function getActiveOnly(): boolean {
  try {
    const raw = getStorage().getItem(ACTIVE_ONLY_KEY);
    if (raw === null) return true; // Default to ON
    return raw === "true";
  } catch {
    return true;
  }
}

export function setActiveOnly(value: boolean): void {
  getStorage().setItem(ACTIVE_ONLY_KEY, String(value));
}

/**
 * Hours of no activity (relative to `lastActivityAt` or `startedAt` fallback) after
 * which a non-ended session is treated as "stale-active" and hidden from the sidebar
 * when {@link getHideStale} is `true`. A value `<= 0` disables the filter entirely;
 * the currently-selected session is never hidden regardless. Default: 24.
 */
export function getStaleHoursThreshold(): number {
  try {
    const raw = getStorage().getItem(STALE_HOURS_KEY);
    if (raw === null) return DEFAULT_STALE_HOURS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_STALE_HOURS;
    return n;
  } catch {
    return DEFAULT_STALE_HOURS;
  }
}

export function setStaleHoursThreshold(hours: number): void {
  getStorage().setItem(STALE_HOURS_KEY, String(hours));
}

/**
 * Whether the stale-active filter is enabled. When `true` (the default), sessions with no
 * recent activity per {@link getStaleHoursThreshold} are hidden from the sidebar; when
 * `false`, all non-ended sessions are shown regardless of age. The selected session is
 * never hidden by this filter.
 */
export function getHideStale(): boolean {
  try {
    const raw = getStorage().getItem(HIDE_STALE_KEY);
    if (raw === null) return true; // Default to ON
    return raw === "true";
  } catch {
    return true;
  }
}

export function setHideStale(value: boolean): void {
  getStorage().setItem(HIDE_STALE_KEY, String(value));
}

/**
 * Whether each tier's sessions are grouped into directory folders. When `true`
 * (the default), the sidebar nests tier → directory-folder; when `false`, each
 * tier renders a flat list of sessions with no directory wrapping.
 */
export function getGroupByFolder(): boolean {
  try {
    const raw = getStorage().getItem(GROUP_BY_FOLDER_KEY);
    if (raw === null) return true; // Default to ON (current nested behavior)
    return raw === "true";
  } catch {
    return true;
  }
}

export function setGroupByFolder(value: boolean): void {
  getStorage().setItem(GROUP_BY_FOLDER_KEY, String(value));
}

/**
 * Read the last time the operator saw the fleet-brief (epoch ms). Returns
 * `null` when the key is missing / cleared / non-positive — the first-run
 * baseline case. `finishedUnseenCutoff` maps that `null` to `now - maxAge`
 * (never `now`, never `0`). See change: build-2-dashboard-v3 (P0 fix #5).
 */
export function getLastBriefViewAt(): number | null {
  try {
    const raw = getStorage().getItem(LAST_BRIEF_VIEW_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

/** Persist the last time the operator saw the fleet-brief (epoch ms). */
export function setLastBriefViewAt(epochMs: number): void {
  try {
    getStorage().setItem(LAST_BRIEF_VIEW_KEY, String(epochMs));
  } catch {
    /* ignore */
  }
}

export function getCollapsedGroups(): Set<string> {
  try {
    const raw = getStorage().getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id: unknown) => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function setCollapsedGroups(cwds: Set<string>): void {
  getStorage().setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...cwds]));
}

/**
 * Remove collapsed group keys that don't match any current session cwds.
 * Returns the pruned set.
 *
 * Tier-toggle keys (e.g. `tier:standing-crew`, `tier:worker`) share this same
 * collapsed-groups Set per SessionList.tsx `handleToggleTierCollapse` design,
 * but they are NOT cwd-derived and have no cwd-shaped lifetime; the prune
 * pass MUST preserve them unconditionally so that operator-toggled tier state
 * survives the next session-list update. Only cwd-keys are pruned against
 * the live `knownCwds` set.
 *
 * See change: dashboard-session-naming-clarity-fix Bug A — sister to
 * mobile-ux-audit/v1 W6-OperatorEmpirical-F1 state-persistence regression.
 */
export function pruneStaleCollapsedGroups(knownCwds: Set<string>): Set<string> {
  const collapsed = getCollapsedGroups();
  const pruned = new Set<string>();
  for (const key of collapsed) {
    if (key.startsWith("tier:")) {
      pruned.add(key);
      continue;
    }
    if (knownCwds.has(key)) {
      pruned.add(key);
    }
  }
  setCollapsedGroups(pruned);
  return pruned;
}
