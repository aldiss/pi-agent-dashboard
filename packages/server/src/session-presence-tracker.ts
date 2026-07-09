/**
 * Session presence tracker (multi-operator, Surface B).
 *
 * Tracks WHICH DISTINCT AUTHENTICATED HUMANS are co-driving each live session,
 * keyed by the connection-bound principal `sub` — deduping multiple tabs of the
 * SAME human into ONE participant. This is deliberately SEPARATE from
 * `viewed-session-tracker.ts`:
 *   - `viewed-session-tracker` answers "is ANYONE looking" (per-WebSocket,
 *     intentionally anonymous/global) and gates unread + push. Load-bearing;
 *     not overloaded here to avoid regressing that contract.
 *   - THIS tracker answers "which distinct HUMANS are here" (per-principal,
 *     identity-aware) and feeds the additive `presence_update` event.
 *
 * Model: `sessionId → Map<sub, Set<WebSocket>>`. A human is present in a session
 * while ≥1 of their sockets views it; they leave only when their LAST socket
 * un-views or disconnects. Single-operator (flag off) binds no principal, so a
 * null-principal connection contributes NO presence participant → the presence
 * set stays empty and no presence-of-two chrome renders (byte-unchanged).
 *
 * In-memory only — presence is intrinsically per-connection, nothing to persist.
 */

import type { WebSocket } from "ws";
import type { PresenceParticipant } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** Identity + display of a present human, as bound at the `/ws` upgrade. */
export interface PresencePrincipal {
  sub: string;
  display: string;
}

export interface SessionPresenceTracker {
  /**
   * Mark that `ws` (bound to `principal`) is viewing `sessionId`. Idempotent.
   * A null principal (single-operator) is a NO-OP — no presence is recorded.
   * Returns true when the session's DISTINCT-human set changed (a new human
   * appeared), so the caller can emit `presence_update` only on real changes.
   */
  enter(sessionId: string, ws: WebSocket, principal: PresencePrincipal | null): boolean;
  /**
   * Mark that `ws` is no longer viewing `sessionId`. Idempotent. Returns true
   * when the distinct-human set changed (that human's LAST socket left).
   */
  leave(sessionId: string, ws: WebSocket): boolean;
  /**
   * Remove `ws` from EVERY session (WebSocket close). Returns the set of
   * sessionIds whose distinct-human set changed, so the caller emits
   * `presence_update` for exactly those.
   */
  removeSocket(ws: WebSocket): string[];
  /** The distinct human participants currently present in `sessionId`. */
  humansOf(sessionId: string): PresenceParticipant[];
  /** Test/diagnostic — number of distinct humans present in `sessionId`. */
  humanCount(sessionId: string): number;
}

export function createSessionPresenceTracker(): SessionPresenceTracker {
  // sessionId → (sub → { display, sockets })
  const sessions = new Map<string, Map<string, { display: string; sockets: Set<WebSocket> }>>();

  function enter(sessionId: string, ws: WebSocket, principal: PresencePrincipal | null): boolean {
    // Single-operator / unauthenticated: no identity → no presence participant.
    if (!principal || !principal.sub) return false;
    let bySub = sessions.get(sessionId);
    if (!bySub) {
      bySub = new Map();
      sessions.set(sessionId, bySub);
    }
    const existing = bySub.get(principal.sub);
    if (existing) {
      existing.sockets.add(ws);
      // Keep display fresh. This sub was already present → the DISTINCT-human
      // set is unchanged (another tab of the same human), so no presence_update.
      existing.display = principal.display;
      return false;
    }
    bySub.set(principal.sub, { display: principal.display, sockets: new Set([ws]) });
    return true; // a NEW distinct human appeared
  }

  function leave(sessionId: string, ws: WebSocket): boolean {
    const bySub = sessions.get(sessionId);
    if (!bySub) return false;
    let changed = false;
    for (const [sub, entry] of bySub) {
      if (entry.sockets.delete(ws) && entry.sockets.size === 0) {
        bySub.delete(sub);
        changed = true; // that human's LAST socket left
      }
    }
    if (bySub.size === 0) sessions.delete(sessionId);
    return changed;
  }

  function removeSocket(ws: WebSocket): string[] {
    const changedSessions: string[] = [];
    for (const [sessionId] of sessions) {
      if (leave(sessionId, ws)) changedSessions.push(sessionId);
    }
    return changedSessions;
  }

  function humansOf(sessionId: string): PresenceParticipant[] {
    const bySub = sessions.get(sessionId);
    if (!bySub) return [];
    const out: PresenceParticipant[] = [];
    for (const [sub, entry] of bySub) {
      out.push({ id: sub, kind: "human", display: entry.display });
    }
    return out;
  }

  function humanCount(sessionId: string): number {
    return sessions.get(sessionId)?.size ?? 0;
  }

  return { enter, leave, removeSocket, humansOf, humanCount };
}
