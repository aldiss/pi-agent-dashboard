/**
 * In-memory registry for deterministic-spawn INTENTS (the AMEND-2 additive
 * sibling — NOT a re-key of `pending-resume-registry.ts`, which stays
 * byte-identical). Keyed by the server-minted spawn correlation TOKEN
 * (`spawn-token.ts`), NOT by cwd — so it is collision-free for the crew's
 * shared-cwd drivers (77+ sessions under one orchestration-state cwd).
 *
 * This is the 5th sibling of the same shape the `session_register` handler
 * already consults (2 token-keyed + 2 cwd-keyed): `pendingClientCorrelations`
 * (token), `pendingDashboardSpawns` (cwd), `pendingForkRegistry` (token),
 * `pendingResumeRegistry` (cwd). See design: deterministic-spawn-designpass-v0.md
 * §7 + §11 (dl-5266); AMEND-2 (Alice + Bert converged, dl-5262/5261).
 *
 * Lifecycle (the deterministic-spawn delivery bus, trigger = on-register):
 *
 *   1. `POST /api/spawn/intent` mints a spawn token, then `record()`s the
 *      intent { token, name, cwd, flavor, directive } with status "pending"
 *      and arms the spawn-register watchdog on the same token.
 *   2. The crew CLI launches tmux ONCE with PI_DASHBOARD_SPAWN_TOKEN=<token>
 *      inline; the spawned pi's bridge echoes the token in `session_register`.
 *   3. On that register, the event-wiring handler calls
 *      `resolveOnRegister(token, sessionId)` → returns the directive to deliver
 *      via `sendToSession(sessionId, {type:"send_prompt", ...})` (deliver-on-
 *      register) and flips the record to "ok" carrying the resolved sessionId.
 *   4. If no register arrives within the watchdog window, the watchdog's
 *      timeout path calls `fail(token, "register-timeout")` → status "failed"
 *      (the model's `registering → dead` deterministic terminal).
 *   5. `GET /api/spawn/intent/:token` reads the record (`get()`) so the CLI's
 *      `--wait` resolves on the OUTCOME (ok/failed), never a pane-scrape.
 *
 * The `directive` is delivered EXACTLY ONCE (resolveOnRegister clears it) but
 * the record persists until its TTL so the status poll can still read the
 * outcome. In-memory only; NOT persisted across server restarts. Stale records
 * (older than `ttlMs`) are dropped on read/sweep so a failed spawn cannot
 * poison later state. TTL defaults to the spawn-register-watchdog window + a
 * grace so a status poll can observe a `failed` outcome before it is swept.
 */

import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** The three spawn flavors the foundation expresses (design §4). */
export type SpawnFlavor = "new" | "context-rotation" | "crash-respawn";

/** Intent lifecycle status. */
export type SpawnIntentStatus = "pending" | "ok" | "failed";

/** The directive delivered on register via `send_prompt`. */
export interface SpawnDirective {
  text: string;
  images?: ImageContent[];
}

/** A recorded spawn intent (the record the status poll reads). */
export interface SpawnIntentRecord {
  spawnToken: string;
  name: string;
  cwd: string;
  flavor: SpawnFlavor;
  status: SpawnIntentStatus;
  /** Set when status flips to "ok" — the registered session id. */
  sessionId?: string;
  /** Set when status flips to "failed" — the terminal reason. */
  reason?: string;
  /** ms epoch of record(). */
  createdAt: number;
}

/** Input to `record()` — everything except the server-managed status/time. */
export interface SpawnIntentInput {
  spawnToken: string;
  name: string;
  cwd: string;
  flavor: SpawnFlavor;
  directive: SpawnDirective;
}

/** Public status view (no directive — that is delivered, never returned). */
export interface SpawnIntentView {
  spawnToken: string;
  name: string;
  cwd: string;
  flavor: SpawnFlavor;
  status: SpawnIntentStatus;
  sessionId?: string;
  reason?: string;
}

export const PENDING_SPAWN_INTENT_TTL_MS = 180_000; // watchdog window (120s) + 60s status-read grace

export interface PendingSpawnIntentRegistry {
  /** Record a pending spawn intent keyed by its spawn token. Last-write-wins. */
  record(input: SpawnIntentInput): void;
  /**
   * On a matching `session_register`, flip the intent to "ok" (carrying the
   * registered sessionId) and RETURN its directive to deliver exactly once.
   * Returns null when there is no live pending intent for the token (already
   * resolved/failed, expired, or never recorded) — so delivery never fires
   * twice and a non-spawn register is a clean no-op.
   */
  resolveOnRegister(spawnToken: string, sessionId: string): SpawnDirective | null;
  /**
   * Flip a still-pending intent to "failed" with a terminal reason (the
   * watchdog's register-timeout path). No-op if already resolved/failed/absent.
   */
  fail(spawnToken: string, reason: string): void;
  /** Read the current status view for the `/:token` poll, or null if absent/expired. */
  get(spawnToken: string): SpawnIntentView | null;
  /** Test/introspection helper — count of live (non-expired) records. */
  size(): number;
  /** Clear all records + any timers. */
  dispose(): void;
}

export interface PendingSpawnIntentRegistryOptions {
  /** Override the TTL in ms. Defaults to PENDING_SPAWN_INTENT_TTL_MS. */
  ttlMs?: number;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

interface InternalEntry extends SpawnIntentRecord {
  /** The undelivered directive; cleared once delivered by resolveOnRegister. */
  directive?: SpawnDirective;
}

export function createPendingSpawnIntentRegistry(
  opts: PendingSpawnIntentRegistryOptions = {},
): PendingSpawnIntentRegistry {
  const ttl = opts.ttlMs ?? PENDING_SPAWN_INTENT_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  // spawnToken -> entry
  const entries = new Map<string, InternalEntry>();

  /** Drop an entry iff older than ttl. Returns the entry if still live, else null. */
  function liveOrDrop(spawnToken: string): InternalEntry | null {
    const e = entries.get(spawnToken);
    if (!e) return null;
    if (now() - e.createdAt >= ttl) {
      entries.delete(spawnToken);
      return null;
    }
    return e;
  }

  function toView(e: InternalEntry): SpawnIntentView {
    return {
      spawnToken: e.spawnToken,
      name: e.name,
      cwd: e.cwd,
      flavor: e.flavor,
      status: e.status,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }

  return {
    record(input: SpawnIntentInput): void {
      entries.set(input.spawnToken, {
        spawnToken: input.spawnToken,
        name: input.name,
        cwd: input.cwd,
        flavor: input.flavor,
        status: "pending",
        createdAt: now(),
        directive: input.directive,
      });
    },

    resolveOnRegister(spawnToken: string, sessionId: string): SpawnDirective | null {
      const e = liveOrDrop(spawnToken);
      // Only a live, still-pending intent with an undelivered directive fires.
      if (!e || e.status !== "pending" || !e.directive) return null;
      const directive = e.directive;
      e.status = "ok";
      e.sessionId = sessionId;
      e.directive = undefined; // deliver exactly once
      return directive;
    },

    fail(spawnToken: string, reason: string): void {
      const e = liveOrDrop(spawnToken);
      if (!e || e.status !== "pending") return; // never override a resolved outcome
      e.status = "failed";
      e.reason = reason;
      e.directive = undefined;
    },

    get(spawnToken: string): SpawnIntentView | null {
      const e = liveOrDrop(spawnToken);
      return e ? toView(e) : null;
    },

    size(): number {
      // Sweep expired on read so `size()` reflects live entries only.
      for (const [token, e] of entries) {
        if (now() - e.createdAt >= ttl) entries.delete(token);
      }
      return entries.size;
    },

    dispose(): void {
      entries.clear();
    },
  };
}
