/**
 * Thread-durability — the B3 holder-resolution seam (ABI `b3/0.1`, design v3.6
 * §"A4 + B3"). PURE: no I/O, no shell-out, no pi runtime. Models the FROZEN
 * B3 authority-resolve contract as a typed verdict + the consumer's fail-closed
 * routing gate, behind an INJECTABLE resolver seam.
 *
 * B3 answers ONE question — WHO holds a thread right now: the single live,
 * fresh, delivery-capable holder session a drain loop should deliver to. It
 * never mutates the substrate and it never issues an ordering epoch (that is
 * A4's job — see `holder-epoch-fence.ts`). If it cannot answer with confidence
 * it fails CLOSED (a structured reason + a distinct non-zero exit code), and
 * the consumer does not route.
 *
 * The REAL resolver is a bounded shell-out to the pi-config B3 bin
 * (`<bin> resolve-holder --thread-id <id> [--name <n>] --json`), which does not
 * exist yet (Joan dispatches it after the §16 gate). Consumers build against
 * THIS ABI through the injectable {@link HolderResolver} seam so a gate
 * adjustment (e.g. an `abi_version` bump) lands in one place without a routing
 * rewrite. Stub the seam with fixtures until activation.
 *
 * Consumer contract (one line): `exit != 0 ⇒ do-not-route`, plus a version pin
 * (`abi_version === expected`). {@link shouldRoute} IS that contract, fail-closed
 * by default (Divergence 2: until the writer-side persisted-mode source lands,
 * B3 returns `mode-mismatch` by design → do-not-route → HOLD).
 */

/** The pinned ABI version this consumer build resolves against (§6). */
export const B3_ABI_VERSION = "b3/0.1" as const;

/**
 * The authority migration-ladder mode (`coexistence.ts:57`). B3 answers
 * authoritatively ONLY under `on`; `off`/`shadow` fail closed `mode-mismatch`.
 */
export type AuthorityMode = "off" | "shadow" | "on";

/**
 * The fail-closed REASON set (§4 reason↔exit-code table). Every non-success
 * verdict carries one. The 9 codes are split so the surface can distinguish
 * nobody / ambiguous / self-demoted / timeout / … — the consumer collapses all
 * of them to do-not-route.
 */
export type HolderResolveReason =
  | "usage" // 1 — bad/missing flags (CLI usage error)
  | "stale" // 2 — holder resolved but last_seen outside the staleness window
  | "mode-mismatch" // 3 — shared writers' mode is not `on` (off/shadow/unresolvable)
  | "path-unresolvable" // 4 — ${base}/authority log absent/unreadable
  | "version-mismatch" // 5 — substrate/ABI version ≠ the consumer's expected
  | "holder-not-found" // 6 — authority `unreachable`: zero live sessions claim the name
  | "holder-ambiguous" // 7 — authority `duplicate`: >1 live claim the name (INV-1)
  | "holder-unreachable" // 8 — authority `degraded`: the one live holder self-marked reachable:false
  | "transport-timeout"; // 9 — the resolve exceeded --timeout-ms (default 2000ms)

/**
 * The reason → non-zero exit-code map (§4). The exit code is the MACHINE
 * contract; the reason is for observability. Exit 0 is success (no reason).
 */
export const HOLDER_RESOLVE_EXIT_CODE: Readonly<Record<HolderResolveReason, number>> = Object.freeze({
  usage: 1,
  stale: 2,
  "mode-mismatch": 3,
  "path-unresolvable": 4,
  "version-mismatch": 5,
  "holder-not-found": 6,
  "holder-ambiguous": 7,
  "holder-unreachable": 8,
  "transport-timeout": 9,
});

/**
 * The resolved holder in a SUCCESS verdict (§3). Routing is by `session_id`
 * (the authority `SessionView.sessionId` primary key), never by name. `fresh`
 * is always `true` on success (a non-fresh holder fails closed `stale`).
 */
export interface ResolvedHolder {
  session_id: string;
  name: string;
  /** `SessionView.lastSeen` — ISO-8601 ts of the holder's last liveness event. */
  last_seen: string;
  /** Temporal-liveness verdict (now − last_seen ≤ staleness window). */
  fresh: boolean;
}

/**
 * The SUCCESS verdict (§3): exactly one live, fresh, delivery-capable holder.
 * `authority_mode` echoes the resolved SHARED mode (always `"on"` on success)
 * so the consumer can log the world B3 answered under (Divergence 4: mode is a
 * substrate-global property surfaced at top level, not a per-holder field).
 */
export interface HolderResolutionOk {
  ok: true;
  abi_version: string;
  thread_id: string;
  authority_mode: AuthorityMode;
  holder: ResolvedHolder;
  /** ISO-8601 ts the resolve completed. */
  resolved_at: string;
}

/**
 * The FAIL-CLOSED verdict (§4): any doubt is a hard "no". Carries a structured
 * `reason` + its distinct non-zero `exit_code`; the consumer treats ANY of them
 * as do-not-route. `detail` is optional free-text for observability.
 */
export interface HolderResolutionFail {
  ok: false;
  abi_version: string;
  reason: HolderResolveReason;
  exit_code: number;
  detail?: string;
}

/** The B3 verdict — a route-eligible success or a fail-closed no. */
export type HolderResolution = HolderResolutionOk | HolderResolutionFail;

/**
 * The INJECTABLE holder-resolution seam. The REAL implementation is a bounded
 * shell-out to the pi-config B3 bin (DEFERRED to activation — the bin does not
 * exist yet). Consumers depend only on this interface; fixtures stub it in
 * tests. `resolveHolder` is read-only and must never throw for a fail-closed
 * case — it RETURNS a `HolderResolutionFail` (the fail-closed contract is a
 * value, not an exception).
 */
export interface HolderResolver {
  resolveHolder(threadId: string, name?: string): HolderResolution;
}

/**
 * Build a fail-closed verdict from a reason, stamping its exit code from the
 * §4 table (single source of truth, so a reason and its code never drift).
 */
export function failClosed(
  reason: HolderResolveReason,
  detail?: string,
  abiVersion: string = B3_ABI_VERSION,
): HolderResolutionFail {
  return {
    ok: false,
    abi_version: abiVersion,
    reason,
    exit_code: HOLDER_RESOLVE_EXIT_CODE[reason],
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * The consumer's DO-NOT-ROUTE diagnosis (observability sibling of
 * {@link shouldRoute}). Returns a short reason string when the verdict is NOT
 * route-eligible, or `null` when it IS. The drain loop logs this on a HOLD so
 * the operator can see WHY a row was not routed. Fail-closed by default: every
 * branch that is not a fully-conforming success yields a non-null reason.
 */
export function doNotRouteReason(
  resolution: HolderResolution,
  expectedAbi: string = B3_ABI_VERSION,
): string | null {
  if (!resolution.ok) {
    return `fail-closed:${resolution.reason}(exit ${resolution.exit_code})`;
  }
  // A success verdict must ALSO pass the version pin + the on-mode + fresh
  // invariants before it is route-eligible (defense-in-depth: the seam parses
  // untrusted bin JSON, so the consumer re-checks the success invariants it
  // depends on rather than trusting the `ok:true` label alone).
  if (resolution.abi_version !== expectedAbi) {
    return `version-mismatch(expected ${expectedAbi}, got ${resolution.abi_version})`;
  }
  if (resolution.authority_mode !== "on") {
    return `mode-not-on(${resolution.authority_mode})`;
  }
  if (resolution.holder?.fresh !== true) {
    return "holder-not-fresh";
  }
  return null;
}

/**
 * The consumer's ROUTE gate (§4/§6). Route IFF the verdict is a conforming
 * success: `ok === true` AND `abi_version === expectedAbi` AND
 * `authority_mode === "on"` AND `holder.fresh === true`. ANY other case — any
 * fail-closed reason, a version mismatch, a missing/false `fresh`, a non-`on`
 * mode — is `false`. This IS the `exit != 0 ⇒ do-not-route` contract + the
 * version pin, FAIL-CLOSED BY DEFAULT.
 */
export function shouldRoute(
  resolution: HolderResolution,
  expectedAbi: string = B3_ABI_VERSION,
): boolean {
  return doNotRouteReason(resolution, expectedAbi) === null;
}
