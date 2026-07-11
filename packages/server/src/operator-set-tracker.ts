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
  /**
   * M-F — reserve `sub`'s slot in `sessionId` for `ttlMs` (huddle recovery). The
   * huddle initiator's slot must survive a brief browser RELOAD (the last socket
   * closes → `release` frees the slot → a 3rd identity could fill it mid-reload,
   * the M5 wedge). `reserve` holds the slot across that gap:
   *   - OWNER-BOUND — only the SAME `sub` reclaims it; a DIFFERENT sub is refused
   *     admission while the reservation is live (it counts against N=2).
   *   - COUNTS against N=2 — a reserved slot occupies a cell slot, so a 3rd
   *     distinct sub is refused mid-reload.
   *   - TTL'd + SELF-EVICTING — expires after `ttlMs` so a stale reservation
   *     never PERMANENTLY wedges the cell at N=1-usable; on expiry the slot frees.
   *   - operator-authenticated CALLER — created only by an operator-only recovery
   *     path (composes with C2; this primitive does not itself check the role).
   * Idempotent for the same `sub` (re-reserving refreshes the TTL). Returns true
   * when the reservation is held (admissible), false when refused (a DIFFERENT
   * sub already holds a reservation / the cell is full of other subs).
   */
  reserve(sessionId: string, sub: string, ttlMs: number): boolean;
}

/**
 * Create an in-memory operator-set tracker. `limit` defaults to
 * {@link OPERATOR_CELL_LIMIT} (2) — the bounded-cell size; parameterized only so
 * a test can exercise the cap at a smaller N without a 3-socket fixture.
 */
export function createOperatorSetTracker(limit: number = OPERATOR_CELL_LIMIT): OperatorSetTracker {
  // sessionId → Set<sub>. A cell exists only while it has ≥1 member.
  const cells = new Map<string, Set<string>>();
  // M-F: sessionId → (sub → eviction timer). A reservation HOLDS a slot across a
  // reload gap independent of the committed `cells` membership — it counts
  // against N=2 in `canAdmit` and self-evicts on TTL. Distinct from `cells` so
  // `release` (last-socket-close) does NOT drop it (the whole point).
  const reservations = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  /** The EFFECTIVE occupants of a cell for admission = members ∪ reserved subs. */
  function effectiveSubs(sessionId: string): Set<string> {
    const out = new Set<string>(cells.get(sessionId) ?? []);
    const res = reservations.get(sessionId);
    if (res) for (const sub of res.keys()) out.add(sub);
    return out;
  }

  function canAdmit(sessionId: string, sub: string): CanAdmitVerdict {
    const members = cells.get(sessionId);
    if (members?.has(sub)) {
      // Already a committed member — admissible, no new slot needed.
      return { admissible: true, member: true };
    }
    // M-F: a sub RECLAIMING its own live reservation is admissible (it reloads
    // back into its held slot) — but it is not yet a committed `member`, so the
    // caller still commits it on the allowed path.
    const effective = effectiveSubs(sessionId);
    if (effective.has(sub)) {
      // sub holds a reservation (guaranteed, since it is not a member) → reclaim.
      return { admissible: true, member: false };
    }
    // A free EFFECTIVE slot ⇒ admissible; cell full of OTHER distinct subs (each
    // a committed member OR a live reservation) ⇒ NOT (a 3rd distinct human).
    return { admissible: effective.size < limit, member: false };
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
    // NOTE: a live reservation for `sub` is intentionally LEFT intact — it is the
    // hold that survives this exact release (the reload gap). It self-evicts on
    // its own TTL. `clearSession` is the leak guard that clears reservation timers.
    return true;
  }

  function clearReservation(sessionId: string, sub: string): void {
    const res = reservations.get(sessionId);
    const timer = res?.get(sub);
    if (timer) clearTimeout(timer);
    res?.delete(sub);
    if (res && res.size === 0) reservations.delete(sessionId);
  }

  function reserve(sessionId: string, sub: string, ttlMs: number): boolean {
    // Idempotent refresh for a sub that already occupies a slot (member OR live
    // reservation): refresh/replace the TTL, keep the slot.
    const alreadyHeld = isMember(sessionId, sub) || !!reservations.get(sessionId)?.has(sub);
    if (!alreadyHeld) {
      // A NEW reservation must fit within N=2 against the effective occupancy —
      // a 3rd distinct sub is refused (owner-bound: only these subs hold slots).
      if (effectiveSubs(sessionId).size >= limit) return false;
    }
    // (Re)arm the eviction timer.
    clearReservation(sessionId, sub);
    let res = reservations.get(sessionId);
    if (!res) {
      res = new Map<string, ReturnType<typeof setTimeout>>();
      reservations.set(sessionId, res);
    }
    const timer = setTimeout(() => {
      // Self-evict: drop the reservation so a stale hold never PERMANENTLY wedges
      // the cell at N=1-usable. The committed membership (if any) is untouched.
      const r = reservations.get(sessionId);
      r?.delete(sub);
      if (r && r.size === 0) reservations.delete(sessionId);
    }, ttlMs);
    // Do not keep the event loop alive for a reservation eviction.
    (timer as { unref?: () => void }).unref?.();
    res.set(sub, timer);
    return true;
  }

  function clearSession(sessionId: string): void {
    cells.delete(sessionId);
    const res = reservations.get(sessionId);
    if (res) {
      for (const timer of res.values()) clearTimeout(timer);
      reservations.delete(sessionId);
    }
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

  return { canAdmit, commit, isMember, release, clearSession, count, operatorsOf, sessionsAdmitted, reserve };
}
