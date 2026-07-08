/**
 * Central session-write authorization chokepoint (Build 0 — PRINCIPAL-CAPTURE).
 *
 * This is the OUTERMOST gate every session-write action routes through
 * (auth-merge contract invariant #1). Build 0 wires the WS `send_prompt` seam
 * through it; the F4 REST route (`POST /api/session/:id/prompt`) + sibling
 * session-write REST routes join the SAME gate in the Build 0/1 REST-closure
 * (seam left open, not foreclosed — see TODO below).
 *
 * SCOPE (Build 0, kept tight per architect scope-correction 2026-07-08):
 *   - Capture + bind the `human{principal}` actor. The gate makes the actor's
 *     identity + kind AVAILABLE so a future authorization check CAN enforce
 *     operator-only rules — Build 0 does NOT enumerate or enforce them.
 *   - The actor type is discriminated-actor-READY: a future `service{id}`
 *     variant (e.g. det-spawn's spawn-intent producer) rides this SAME seam
 *     with zero rework (contract invariant #2, #4). Build 0 constructs only
 *     `human`; it does NOT build the `service` producer or any author stamping
 *     / injection into the model turn (that is Build 2).
 *
 * Policy in Build 0 is intentionally minimal:
 *   - flag OFF (single-operator, default): ALLOW unconditionally — behavior is
 *     byte-unchanged from today.
 *   - flag ON (multi-operator): REQUIRE a bound `human` principal. A `service`
 *     actor is always allowed to pass the gate here (it authenticates out of
 *     band); operator-only enforcement against a `service` actor is a tracked
 *     carry to a later enforcement slice, NOT built here.
 */
import type { TokenPayload } from "./auth.js";

/**
 * The authenticated actor behind a session-write, discriminated by kind.
 *
 * - `human`  — a browser operator. `principal` is the verified `TokenPayload`
 *   bound at `validateWsUpgrade` (null when single-operator mode allowed the
 *   connection with no cookie). NEVER a client-claimed value — the server
 *   derives it from the connection, never from the message body.
 * - `service` — a server-side producer (e.g. det-spawn). NOT constructed in
 *   Build 0; declared so the gate + downstream stamping are actor-READY and a
 *   future service producer inherits the same chokepoint without a parallel
 *   auth path.
 */
export type SessionActor =
  | { kind: "human"; principal: TokenPayload | null }
  | { kind: "service"; id: string };

export interface AuthorizeSessionActionInput {
  actor: SessionActor;
  /** The session-scoped action being attempted (e.g. "send_prompt"). */
  action: string;
  /**
   * Whether the multi-operator browser-auth gate is engaged for this server.
   * Sourced from `auth.requireBrowserAuth`. When false, the gate no-ops
   * (single-operator, byte-unchanged).
   */
  requireBrowserAuth: boolean;
}

export interface AuthorizeSessionActionResult {
  allowed: boolean;
  /** Machine-readable denial reason, present only when `allowed:false`. */
  reason?: "no-principal";
}

/**
 * The single authorization chokepoint for session-write actions.
 *
 * Build 0 enforces exactly one rule: in multi-operator mode a `human` actor
 * must carry a bound principal (defense-in-depth — the `/ws` upgrade gate
 * already refuses principal-less browser connections when the flag is on, so
 * a null-principal human should never reach here; this pins the invariant at
 * the send seam too). A `service` actor is not subject to the human-principal
 * requirement. In single-operator mode the gate allows unconditionally.
 *
 * Deliberately NOT done here (tracked carries / later slices): operator-only
 * action enumeration + enforcement (NOS §4), N=2 bounded-cell membership,
 * per-author queue reconciliation, and any author stamping into the model turn.
 */
export function authorizeSessionAction(
  input: AuthorizeSessionActionInput,
): AuthorizeSessionActionResult {
  const { actor, requireBrowserAuth } = input;

  if (!requireBrowserAuth) {
    // Single-operator: no-op gate, byte-unchanged behavior.
    return { allowed: true };
  }

  if (actor.kind === "human" && actor.principal === null) {
    return { allowed: false, reason: "no-principal" };
  }

  // human with a bound principal, or a service actor → allowed.
  return { allowed: true };
}

// TODO(Build 0/1 REST-closure): route `POST /api/session/:id/prompt`
// (session-api.ts:214, the F4 anonymous-write backdoor) + sibling session-write
// REST routes through `authorizeSessionAction` with a `human` actor derived
// from the request's verified JWT (the REST `onRequest` hook stores only
// `isAuthenticated` today — it must capture the principal like the WS path).
// Left as an open seam; NOT foreclosed. The architect gates the REST-closure.
