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
 * Returns true when the given filter is the canonical defaults shape (no
 * categories suppressed beyond defaults). Used by the header dot/badge +
 * the "Showing N of M" banner to decide whether to render anything at all.
 */
export function isDefaultMessageFilter(filter: MessageFilter): boolean {
  return (
    filter.tierA === DEFAULT_MESSAGE_FILTER.tierA &&
    filter.tierB === DEFAULT_MESSAGE_FILTER.tierB &&
    filter.tierC === DEFAULT_MESSAGE_FILTER.tierC &&
    filter.meshChatter === DEFAULT_MESSAGE_FILTER.meshChatter &&
    filter.toolCalls === DEFAULT_MESSAGE_FILTER.toolCalls &&
    filter.systemNotifications === DEFAULT_MESSAGE_FILTER.systemNotifications
  );
}

/**
 * Read the persisted filter for a session, falling back to the canonical
 * defaults on parse error, missing key, or storage unavailable. Never
 * throws; sister-precedent session-filter-storage's try-catch wrapping.
 */
export function getMessageFilter(sessionId: string): MessageFilter {
  if (!sessionId) return { ...DEFAULT_MESSAGE_FILTER };
  try {
    const raw = getStorage().getItem(storageKey(sessionId));
    if (!raw) return { ...DEFAULT_MESSAGE_FILTER };
    const parsed = JSON.parse(raw) as Partial<MessageFilter> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_MESSAGE_FILTER };
    }
    // Merge against defaults so an older persisted shape missing newer
    // keys still resolves to a complete filter without TypeScript holes.
    return {
      tierA: typeof parsed.tierA === "boolean" ? parsed.tierA : DEFAULT_MESSAGE_FILTER.tierA,
      tierB: typeof parsed.tierB === "boolean" ? parsed.tierB : DEFAULT_MESSAGE_FILTER.tierB,
      tierC: typeof parsed.tierC === "boolean" ? parsed.tierC : DEFAULT_MESSAGE_FILTER.tierC,
      meshChatter: typeof parsed.meshChatter === "boolean" ? parsed.meshChatter : DEFAULT_MESSAGE_FILTER.meshChatter,
      toolCalls: typeof parsed.toolCalls === "boolean" ? parsed.toolCalls : DEFAULT_MESSAGE_FILTER.toolCalls,
      systemNotifications: typeof parsed.systemNotifications === "boolean" ? parsed.systemNotifications : DEFAULT_MESSAGE_FILTER.systemNotifications,
    };
  } catch {
    return { ...DEFAULT_MESSAGE_FILTER };
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
