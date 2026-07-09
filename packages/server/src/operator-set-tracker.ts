/**
 * Operator-set tracker — the bounded 2-operator cell primitive (Stream-2 D,
 * N=2 admission).
 *
 * Tracks WHICH DISTINCT AUTHENTICATED HUMANS (`principal.sub`) have been ADMITTED
 * to co-drive each session, and caps the count at N=2. This is the admission
 * substrate the ONE `authorizeSessionAction` chokepoint consults so BOTH the WS
 * and REST arms bound a session to 2 distinct human operators from a SINGLE
 * source (a 3rd distinct human cannot slip in via REST after learning a
 * sessionId from the snapshot).
 *
 * Deliberately SEPARATE from `session-presence-tracker.ts`:
 *   - `session-presence-tracker` answers "which distinct humans are VIEWING"
 *     (per-socket, view-driven) and feeds `presence_update`.
 *   - THIS tracker answers "which distinct humans are ADMITTED to WRITE"
 *     (per-`sub`, admission-driven) and bounds the cell. A viewer is not
 *     necessarily an admitted writer, and a REST writer may hold no socket.
 *
 * Distinct-`sub` semantics (NOT per-connection): two browser TABS of the SAME
 * human share ONE `sub` → ONE cell slot (the Set dedups). A 3rd DISTINCT `sub`
 * is the one refused. Counting by connection instead would let one human's two
 * tabs exhaust the cell AND let a 3rd human's extra socket slip in — both wrong.
 *
 * `service` actors are NOT tracked here: they are infra (a shared-secret / a
 * future det-spawn producer), not one of the 2 humans, so the chokepoint never
 * calls `canAdmit`/`commit` for them (they bypass admission but remain bound by
 * the per-action operator-only rule). See `session-authz.ts`.
 *
 * In-memory only — admission is intrinsically per-run, nothing to persist.
 */

/** The bounded cell size: at most this many DISTINCT humans co-drive a session. */
export const OPERATOR_CELL_LIMIT = 2;

/**
 * Verdict of a {@link OperatorSetTracker.canAdmit} check (NON-mutating).
 *
 * check-then-commit (Stream-2 D fix-2 MAJOR-2): admission is a two-step —
 * `canAdmit` (this, read-only) decides admissibility at the admission-first
 * point WITHOUT mutating, so a subsequently-refused action (unclassified /
 * operator-only) strands NO slot; `commit` mutates ONLY on the allowed path.
 */
export interface CanAdmitVerdict {
  /**
   * True when `sub` MAY occupy a slot — it is already a member OR a slot is free
   * (`count < limit`). False ONLY when the cell is full of OTHER distinct `sub`s
   * (a 3rd distinct human). NO mutation is performed to determine this.
   */
  admissible: boolean;
  /**
   * True when `sub` is ALREADY a member (a second tab / repeat write) — so a
   * `commit` would be a no-op. Used ONLY to decide commit-vs-skip
   * (`needsCommit`), NEVER as an authorization ALLOW input (an admitted member
   * is NOT thereby permitted an operator-only action — the union bug
   * intersection forbids).
   */
  member: boolean;
}

export interface OperatorSetTracker {
  /**
   * NON-mutating admissibility check (check-then-commit step 1). `admissible`
   * when `sub` is a member OR a slot is free; `member` when already present.
   * Performs NO mutation — the caller `commit`s only on the allowed path.
   */
  canAdmit(sessionId: string, sub: string): CanAdmitVerdict;
  /**
   * Commit `sub` into `sessionId`'s cell (check-then-commit step 2 — the ONLY
   * admission mutation). Idempotent for an existing member. The caller MUST have
   * seen `canAdmit().admissible === true` first (committing a non-admissible
   * `sub` would breach the cap); in practice the chokepoint commits only a
   * `needsCommit` (admissible && !member) sub on the allowed path.
   */
  commit(sessionId: string, sub: string): void;
  /** True when `sub` currently occupies a slot in `sessionId`'s cell. */
  isMember(sessionId: string, sub: string): boolean;
  /**
   * Free `sub`'s slot in `sessionId` (e.g. that human's last socket left).
   * Idempotent. Returns true when a slot was actually freed. Removing the last
   * member drops the cell entirely.
   */
  release(sessionId: string, sub: string): boolean;
  /** Drop the entire cell for `sessionId` (session end — leak guard). */
  clearSession(sessionId: string): void;
  /**
   * Distinct-`sub` count currently in `sessionId`'s cell. DIAGNOSTIC / test-only
   * — MUST NOT be wired into any authorization ALLOW decision (membership /
   * count is not permission; the per-action operator-only rule is the sole
   * authority). See the NIT in the fix-2 directive.
   */
  count(sessionId: string): number;
  /** Test/diagnostic — the distinct `sub`s currently in `sessionId`'s cell. */
  operatorsOf(sessionId: string): string[];
  /**
   * Reverse lookup (Stream-2 D fix-1 MAJOR-1): every sessionId whose cell
   * currently admits `sub`. Used by the socket-close release path to free a
   * departed human's slots across ALL sessions it was admitted to — INDEPENDENT
   * of the presence-view path (a human admitted by a WRITE without ever
   * `session_view`-ing is invisible to the presence tracker, so releasing off
   * presence alone leaks the slot).
   */
  sessionsAdmitted(sub: string): string[];
}

/**
 * Create an in-memory operator-set tracker. `limit` defaults to
 * {@link OPERATOR_CELL_LIMIT} (2) — the bounded-cell size; parameterized only so
 * a test can exercise the cap at a smaller N without a 3-socket fixture.
 */
export function createOperatorSetTracker(limit: number = OPERATOR_CELL_LIMIT): OperatorSetTracker {
  // sessionId → Set<sub>. A cell exists only while it has ≥1 member.
  const cells = new Map<string, Set<string>>();

  function canAdmit(sessionId: string, sub: string): CanAdmitVerdict {
    const existing = cells.get(sessionId);
    if (existing?.has(sub)) {
      // Already a member — admissible, no new slot needed (commit is a no-op).
      return { admissible: true, member: true };
    }
    const size = existing?.size ?? 0;
    // A free slot ⇒ admissible; cell full of OTHER distinct subs ⇒ NOT (a 3rd
    // distinct human). NO mutation here — the caller commits only on the
    // allowed path (check-then-commit), so a refused action strands nothing.
    return { admissible: size < limit, member: false };
  }

  function commit(sessionId: string, sub: string): void {
    const existing = cells.get(sessionId);
    if (existing) {
      existing.add(sub); // idempotent for a member
      return;
    }
    cells.set(sessionId, new Set<string>([sub]));
  }

  function isMember(sessionId: string, sub: string): boolean {
    return cells.get(sessionId)?.has(sub) ?? false;
  }

  function release(sessionId: string, sub: string): boolean {
    const cell = cells.get(sessionId);
    if (!cell || !cell.delete(sub)) return false;
    if (cell.size === 0) cells.delete(sessionId);
    return true;
  }

  function clearSession(sessionId: string): void {
    cells.delete(sessionId);
  }

  function count(sessionId: string): number {
    return cells.get(sessionId)?.size ?? 0;
  }

  function operatorsOf(sessionId: string): string[] {
    return [...(cells.get(sessionId) ?? [])];
  }

  function sessionsAdmitted(sub: string): string[] {
    const out: string[] = [];
    for (const [sessionId, cell] of cells) {
      if (cell.has(sub)) out.push(sessionId);
    }
    return out;
  }

  return { canAdmit, commit, isMember, release, clearSession, count, operatorsOf, sessionsAdmitted };
}
