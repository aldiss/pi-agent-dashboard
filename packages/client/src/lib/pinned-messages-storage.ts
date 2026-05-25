/**
 * Per-session pinned-message persistence.
 *
 * Sister-shape adapt of session-filter-storage.ts + message-filter-storage.ts
 * canonical (`dashboard:*` namespace + try-catch wrapping). Stable identifier
 * is `ChatMessage.entryId` (per event-reducer.ts ChatMessage interface), which
 * survives JSONL replay per fix-per-message-fork discipline — pins persist
 * across page reload AND across session resume/fork.
 *
 * Storage shape: `string[]` (JSON-serialized Array<entryId>), deserialized to
 * `Set<string>` at read-time. Empty / missing / parse-error → empty Set.
 *
 * Soft cap: DEFAULT_PIN_CAP=20 pins per session. Adds beyond cap fail with
 * action="cap-hit" and leave the existing set untouched, so the caller can
 * surface a transient notification ("Pin cap reached") without committing
 * state.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.3 Feature 3).
 */

/** Soft cap on pinned messages per session. Configurable in case empirical
 *  signal shows operators routinely want >20; W3 Q3 ratified at 20 first-pass. */
export const DEFAULT_PIN_CAP = 20;

const KEY_PREFIX = "dashboard:pinnedMessages:";

function getStorage(): Storage {
  return window.localStorage;
}

function storageKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * Read the persisted pin-set for a session, falling back to an empty Set on
 * parse error, missing key, or storage unavailable. Never throws;
 * sister-precedent session-filter-storage's try-catch wrapping.
 */
export function getPinnedEntryIds(sessionId: string): Set<string> {
  if (!sessionId) return new Set();
  try {
    const raw = getStorage().getItem(storageKey(sessionId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id: unknown): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Persist the pin-set for a session. Silently swallows storage errors
 * (quota / disabled / private-mode) so a temporarily unavailable
 * localStorage never breaks the chat surface.
 */
export function setPinnedEntryIds(sessionId: string, ids: Set<string>): void {
  if (!sessionId) return;
  try {
    getStorage().setItem(storageKey(sessionId), JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

/**
 * Remove the persisted pins for a session entirely (back to empty on next
 * read). Used by the "Unpin all" button in PinnedMessagesSection.
 */
export function clearPinnedEntryIds(sessionId: string): void {
  if (!sessionId) return;
  try {
    getStorage().removeItem(storageKey(sessionId));
  } catch {
    /* ignore */
  }
}

/**
 * Result returned by togglePinned describing what changed:
 *   - `pinned`   — entryId was added (set grew by 1)
 *   - `unpinned` — entryId was removed (set shrank by 1)
 *   - `cap-hit`  — add was attempted but DEFAULT_PIN_CAP reached; the
 *                  returned `newSet` is identical to the existing set
 *                  (no mutation). Caller should surface a soft
 *                  "Pin cap reached (N)" notification.
 */
export interface TogglePinnedResult {
  newSet: Set<string>;
  action: "pinned" | "unpinned" | "cap-hit";
}

/**
 * Toggle a pin for an entry. Pure-functional: returns a new Set rather than
 * mutating storage in place; the caller is responsible for both updating
 * React state AND calling setPinnedEntryIds() to persist. This split lets
 * components batch state + storage writes via a single useState setter.
 *
 * Cap-hit semantics: if the current set is already at DEFAULT_PIN_CAP AND
 * the entry is NOT currently pinned (i.e. the call would grow the set),
 * the action returns `cap-hit` and the existing set unchanged. Unpinning
 * is always allowed (shrinking the set never hits the cap).
 */
export function togglePinned(sessionId: string, entryId: string): TogglePinnedResult {
  const current = getPinnedEntryIds(sessionId);
  if (current.has(entryId)) {
    const newSet = new Set(current);
    newSet.delete(entryId);
    return { newSet, action: "unpinned" };
  }
  if (current.size >= DEFAULT_PIN_CAP) {
    return { newSet: current, action: "cap-hit" };
  }
  const newSet = new Set(current);
  newSet.add(entryId);
  return { newSet, action: "pinned" };
}
