/**
 * Thread-durability — the drain loop (design v3.6 §C3.1 injection sequence +
 * the §"Composition note" B3→A4→inject order). Orchestrates, PER THREAD and
 * UNDER THE PER-ROW LOCK (N1), the routing of each READY outbox row:
 *
 *     resolve holder (B3, WHO) → stamp holder_epoch (A4 fence, ORDER) → inject
 *
 * NEVER-DROP is the load-bearing invariant: a do-not-route verdict (any B3
 * fail-closed / version-mismatch / non-`on` mode / non-fresh holder) OR a
 * stale-epoch guard (the row's claim epoch is superseded) HOLDS the row —
 * retained untouched, the reason surfaced, re-attempted on a later drain —
 * it is NEVER removed and NEVER routed to a superseded holder. Only a fresh,
 * current-epoch, delivery-capable holder is routed.
 *
 * ALL boundaries are INJECTED SEAMS ({@link DrainDeps}): the durable store, the
 * B3 {@link HolderResolver}, the A4 {@link HolderEpochResolver}, and the
 * injection primitive. The REAL bridge / B3 bin / ledger wiring is DEFERRED to
 * activation (behind the OFF gate); tests stub every seam with fixtures. This
 * module builds NO real B3 bin, NO real inject, NO real ledger read, NO
 * reassign, NO 3-type landing (that is dispatch-2), and it does NOT wire
 * `server.ts`.
 *
 * Cross-package rule: the server depends only on `@…/shared`. The injection
 * result is therefore modelled here as a minimal local seam type — never an
 * import from the extension package.
 */

import {
  resolveCurrentEpochFor,
  isStaleEpoch,
  shouldRoute,
  doNotRouteReason,
  type HolderEpochResolver,
  type HolderResolver,
  type HolderResolution,
  type OutboxEntry,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

// ── the injected store seam (the subset of the B2 OutboxStore the drain uses) ─

/**
 * The durable-store surface the drain loop drives. The concrete B2
 * `OutboxStore` satisfies this at activation; tests stub it. Kept minimal so
 * the drain depends only on what it exercises.
 *
 *  - `readyRows`   — the READY (re-drainable, non-terminal) rows for one thread.
 *  - `withRowLock` — run `fn` inside the row's critical section (N1); the lock
 *                    is released even if `fn` throws (fail-loud propagates).
 *  - `stampHolder` — under the lock, stamp the resolved `holder_epoch` +
 *                    `holder_session_id` into the row's claim/details, returning
 *                    the updated row. Called ONLY on a route-eligible row.
 */
export interface DrainStore {
  readyRows(threadId: string): OutboxEntry[];
  withRowLock<T>(delivery_id: string, fn: () => T | Promise<T>): Promise<T>;
  stampHolder(delivery_id: string, patch: HolderStamp): Promise<OutboxEntry>;
}

/** The B3+A4 stamp applied to a route-eligible row (design §C3.1 step 3). */
export interface HolderStamp {
  /** The current epoch resolved via the A4 fence (`resolveCurrentEpochFor`). */
  holder_epoch: number;
  /** The routed holder's session id (B3 `holder.session_id` — route by id). */
  holder_session_id: string;
}

// ── the injected injection seam (minimal; NEVER imports the extension pkg) ────

/** The terminal-ish outcome of one injection (mirrors the bridge primitive). */
export type DrainInjectOutcome =
  | "observed"
  | "accepted"
  | "executed"
  | "failed"
  | "indeterminate";

/** The injection result the drain records (minimal local seam shape). */
export interface DrainInjectResult {
  outcome: DrainInjectOutcome;
  entry_id?: string;
  row?: OutboxEntry;
}

/**
 * The injection primitive seam. Injects ONE ready (stamped) row through the
 * C3.1 executing sequence (queued|executing → sendMessage → observed →
 * accepted → executed). The REAL implementation is the bridge `injectDelivery`,
 * wired at activation; tests stub it to record calls.
 */
export type DrainInject = (entry: OutboxEntry) => Promise<DrainInjectResult>;

// ── the drain dependencies + per-row disposition ─────────────────────────────

export interface DrainDeps {
  store: DrainStore;
  resolveHolder: HolderResolver;
  epochResolver: HolderEpochResolver;
  inject: DrainInject;
  /**
   * Optional canonical holder-name resolver for the B3 `--name` key. v0.1 B3
   * expects `--name`; until a gate derives it from `thread_id`, the drain may
   * supply it per row. When absent, `resolveHolder` is called with `name`
   * undefined (the seam/fixture decides).
   */
  holderName?: (entry: OutboxEntry) => string | undefined;
}

/** Why one READY row was HELD instead of routed (never-drop observability). */
export type HoldReason = "do-not-route" | "stale-epoch";

/** The disposition of one READY row after a drain pass. */
export type RowDisposition =
  | {
      delivery_id: string;
      action: "routed";
      /** The routed holder's session id + the stamped current epoch. */
      holder_session_id: string;
      holder_epoch: number;
      inject: DrainInjectResult;
    }
  | {
      delivery_id: string;
      action: "hold";
      reason: HoldReason;
      /** Human-readable detail for the operator surface. */
      detail: string;
      /** The B3 verdict that produced a `do-not-route` hold (when applicable). */
      resolution?: HolderResolution;
    };

/** The result of draining one thread — the per-row dispositions, in row order. */
export interface DrainThreadResult {
  thread_id: string;
  dispositions: RowDisposition[];
}

/**
 * Drain one thread: route each READY row through B3 → A4 fence → inject, UNDER
 * THE PER-ROW LOCK, never-drop.
 *
 * For each READY row (in the store's row order), inside `store.withRowLock`:
 *  1. `resolveHolder(threadId, name)` → if `!shouldRoute(res)` → **HOLD**
 *     (retain the row untouched; record the do-not-route reason; continue —
 *     re-attempted on a later drain). Fail-closed by default.
 *  2. else resolve the current epoch via the A4 fence
 *     (`resolveCurrentEpochFor`) and guard staleness
 *     (`isStaleEpoch(rowClaimEpoch, currentEpoch)`) → if stale (the row's holder
 *     was superseded) → **HOLD** (do not route under a superseded holder).
 *     `isStaleEpoch` THROWS on the impossible `claimEpoch > currentEpoch`
 *     (ahead of the gate = corruption) — that fail-loud propagates out (the
 *     lock is released) rather than silently dropping the row.
 *  3. else stamp `holder_epoch` (current) + `holder_session_id` (B3
 *     `holder.session_id`) and `inject` the stamped row.
 *
 * Rows are processed sequentially; each has its own per-row lock, so a HOLD or
 * a route on one row never blocks another. A held row is NEVER removed and NEVER
 * stamped/injected — the never-drop invariant is structural (the hold branches
 * return before `stampHolder`/`inject`).
 */
export async function drainThread(threadId: string, deps: DrainDeps): Promise<DrainThreadResult> {
  const { store, resolveHolder, epochResolver, inject } = deps;
  const rows = store.readyRows(threadId);
  const dispositions: RowDisposition[] = [];

  for (const row of rows) {
    const disposition = await store.withRowLock(row.delivery_id, async (): Promise<RowDisposition> => {
      // ── step 1: B3 — WHO holds the thread (fail-closed by default) ──
      const name = deps.holderName?.(row);
      const resolution = resolveHolder.resolveHolder(threadId, name);
      if (!shouldRoute(resolution)) {
        // NEVER-DROP: retain the row untouched; surface the do-not-route reason.
        return {
          delivery_id: row.delivery_id,
          action: "hold",
          reason: "do-not-route",
          detail: doNotRouteReason(resolution) ?? "do-not-route",
          resolution,
        };
      }

      // ── step 2: A4 fence — current epoch + staleness guard ──
      // `shouldRoute` proved a conforming success, so the holder is present.
      const holder = (resolution as Extract<HolderResolution, { ok: true }>).holder;
      const currentEpoch = resolveCurrentEpochFor(epochResolver, threadId);
      // `isStaleEpoch` throws fail-loud on claimEpoch > currentEpoch (corruption).
      if (isStaleEpoch(row.holder_epoch, currentEpoch)) {
        // NEVER-DROP: the row's holder was superseded → HOLD (do not route under
        // a superseded holder); re-attempted after recovery re-arms the epoch.
        return {
          delivery_id: row.delivery_id,
          action: "hold",
          reason: "stale-epoch",
          detail: `row epoch ${row.holder_epoch} < current ${currentEpoch} (holder superseded)`,
        };
      }

      // ── step 3: stamp (B3 holder + A4 epoch) then INJECT ──
      const stamped = await store.stampHolder(row.delivery_id, {
        holder_epoch: currentEpoch,
        holder_session_id: holder.session_id,
      });
      const injectResult = await inject(stamped);
      return {
        delivery_id: row.delivery_id,
        action: "routed",
        holder_session_id: holder.session_id,
        holder_epoch: currentEpoch,
        inject: injectResult,
      };
    });

    dispositions.push(disposition);
  }

  return { thread_id: threadId, dispositions };
}
