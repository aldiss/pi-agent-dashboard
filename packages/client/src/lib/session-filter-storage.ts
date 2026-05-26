const LEGACY_HIDDEN_KEY = "dashboard:hiddenSessions";
const ACTIVE_ONLY_KEY = "dashboard:activeOnly";
const COLLAPSED_GROUPS_KEY = "dashboard:collapsedGroups";
const STALE_HOURS_KEY = "dashboard:staleHours";
const HIDE_STALE_KEY = "dashboard:hideStale";

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
 */
export function pruneStaleCollapsedGroups(knownCwds: Set<string>): Set<string> {
  const collapsed = getCollapsedGroups();
  const pruned = new Set<string>();
  for (const cwd of collapsed) {
    if (knownCwds.has(cwd)) {
      pruned.add(cwd);
    }
  }
  setCollapsedGroups(pruned);
  return pruned;
}
