/**
 * Per-session message-type filter persistence.
 *
 * Sister-shape adapt of session-filter-storage.ts canonical (`dashboard:*`
 * namespace + try-catch wrapping). The filter shape mirrors the 6 categories
 * surfaced in MessageFilterControls + classified by message-filter-classifier:
 *
 *   - tierA               operator-direct interactive cards (interactiveUi)
 *   - tierB               narrative content (user/assistant text, digest rows)
 *   - tierC               ledger-only events (rare in dashboard)
 *   - meshChatter         plain user/assistant chat without skill envelope
 *   - toolCalls           tool-result + bash-output + command-feedback rows
 *   - systemNotifications thinking / turnSeparator / rawEvent + retry badges
 *
 * Defaults follow W3 Q2 recommended-default (Tier-A/B/mesh-chatter ON;
 * Tier-C / tool-calls / system-notifications OFF). Persistence keyed per
 * session-id so different sessions can carry different filters without
 * cross-contaminating.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.2 Feature 2).
 */

export interface MessageFilter {
  tierA: boolean;
  tierB: boolean;
  tierC: boolean;
  meshChatter: boolean;
  toolCalls: boolean;
  systemNotifications: boolean;
}

/** Canonical defaults per W3 Q2 recommended-default. */
export const DEFAULT_MESSAGE_FILTER: MessageFilter = {
  tierA: true,
  tierB: true,
  tierC: false,
  meshChatter: true,
  toolCalls: false,
  systemNotifications: false,
};

const KEY_PREFIX = "dashboard:messageFilter:";

function getStorage(): Storage {
  return window.localStorage;
}

function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * Returns true when the given filter equals the reference `defaults` shape (no
 * categories suppressed/revealed beyond that reference). Used by the header
 * dot/badge + the "Showing N of M" banner to decide whether to render anything
 * at all, and by the filter-panel Reset to know when it is a no-op.
 *
 * `defaults` is PARAMETERIZED (design v0.3 Tier-1 filter-param M-fix): a surface
 * with a different baseline — e.g. the thread message-lane's "show all activity"
 * default (`{ ...DEFAULT_MESSAGE_FILTER, tierC: true }`) — passes ITS baseline so
 * a thread default is not mislabeled "non-default" (which would spuriously show
 * the Reset affordance and turn the surface's own default off). Omitted =
 * `DEFAULT_MESSAGE_FILTER`, so every existing caller is unchanged.
 */
export function isDefaultMessageFilter(
  filter: MessageFilter,
  defaults: MessageFilter = DEFAULT_MESSAGE_FILTER,
): boolean {
  return (
    filter.tierA === defaults.tierA &&
    filter.tierB === defaults.tierB &&
    filter.tierC === defaults.tierC &&
    filter.meshChatter === defaults.meshChatter &&
    filter.toolCalls === defaults.toolCalls &&
    filter.systemNotifications === defaults.systemNotifications
  );
}

/**
 * Read the persisted filter for a session, falling back to `defaults` on parse
 * error, missing key, or storage unavailable. Never throws; sister-precedent
 * session-filter-storage's try-catch wrapping.
 *
 * `defaults` is PARAMETERIZED (Tier-1 filter-param M-fix): a surface with a
 * different baseline (the thread message-lane's `tierC:true` default) passes its
 * own baseline so a fresh (un-persisted) lane opens at ITS default, not the
 * canonical one. Omitted = `DEFAULT_MESSAGE_FILTER` (every existing caller
 * unchanged). Persisted values still win when present (per-key merge over the
 * supplied defaults).
 */
export function getMessageFilter(
  sessionId: string,
  defaults: MessageFilter = DEFAULT_MESSAGE_FILTER,
): MessageFilter {
  if (!sessionId) return { ...defaults };
  try {
    const raw = getStorage().getItem(storageKey(sessionId));
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<MessageFilter> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...defaults };
    }
    // Merge against the supplied defaults so an older persisted shape missing
    // newer keys still resolves to a complete filter without TypeScript holes.
    return {
      tierA: typeof parsed.tierA === "boolean" ? parsed.tierA : defaults.tierA,
      tierB: typeof parsed.tierB === "boolean" ? parsed.tierB : defaults.tierB,
      tierC: typeof parsed.tierC === "boolean" ? parsed.tierC : defaults.tierC,
      meshChatter: typeof parsed.meshChatter === "boolean" ? parsed.meshChatter : defaults.meshChatter,
      toolCalls: typeof parsed.toolCalls === "boolean" ? parsed.toolCalls : defaults.toolCalls,
      systemNotifications: typeof parsed.systemNotifications === "boolean" ? parsed.systemNotifications : defaults.systemNotifications,
    };
  } catch {
    return { ...defaults };
  }
}

/**
 * Persist the filter for a session. Silently swallows storage errors
 * (quota / disabled / private-mode) so a temporarily unavailable
 * localStorage never breaks the chat surface.
 */
export function setMessageFilter(sessionId: string, filter: MessageFilter): void {
  if (!sessionId) return;
  try {
    getStorage().setItem(storageKey(sessionId), JSON.stringify(filter));
  } catch {
    /* ignore */
  }
}

/**
 * Remove the persisted filter for a session (back to defaults on next read).
 * Used by the "Reset filters" link in MessageFilterControls.
 */
export function clearMessageFilter(sessionId: string): void {
  if (!sessionId) return;
  try {
    getStorage().removeItem(storageKey(sessionId));
  } catch {
    /* ignore */
  }
}
