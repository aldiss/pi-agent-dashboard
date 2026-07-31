/**
 * A1 render-lifecycle ACK — idempotent, mount-time.
 *
 * Pete dl-13358 B1: the render ACK must be emitted from the interactive dialog
 * COMPONENT's mount lifecycle (post-DOM-commit), exactly once per promptId —
 * NOT at message-received / setSessionStates-enqueue time (which fires before
 * React commits, so a renderer that fails / hides / never mounts would still
 * report delivered=true).
 *
 * Idempotency across remount / reconnect-replay: a mount `useEffect` re-fires
 * whenever the card re-mounts (session switch, reconnect replay re-adds the
 * interactive row, React StrictMode double-invoke). A module-level ledger of
 * already-ACKed promptIds — surviving remount (module scope, like ChatView's
 * `scrollStateMap`) — guarantees EXACTLY ONCE per promptId.
 *
 * The ledger is pure + separately exported so it is unit-testable without React.
 */

/** Module-level ledger of promptIds whose render ACK has already been sent. */
const ackedPromptIds = new Set<string>();

/**
 * Claim the render ACK for `promptId`. Returns true on the FIRST call for a
 * given id (caller should send the ACK), false on every subsequent call
 * (already ACKed — do nothing). Check-and-set is synchronous, so concurrent
 * mounts of the same id resolve to a single true.
 */
export function claimPromptRenderedAck(promptId: string): boolean {
  if (!promptId) return false;
  if (ackedPromptIds.has(promptId)) return false;
  ackedPromptIds.add(promptId);
  return true;
}

/** Test-only: reset the ledger between cases. */
export function __resetPromptRenderedAckLedger(): void {
  ackedPromptIds.clear();
}

/** Test/diagnostic: has this promptId already been ACKed? */
export function hasPromptRenderedAck(promptId: string): boolean {
  return ackedPromptIds.has(promptId);
}
