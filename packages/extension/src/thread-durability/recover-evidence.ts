/**
 * Thread-durability bridge — the recovery-scan evidence resolver (design v3.6
 * §C3.2, the F1 gate). Implements the B2 `RecoverEvidenceResolver` the durable
 * store injects: the REAL pi-side durable-session scan + the exact-identity
 * liveness probe.
 *
 * GROUNDED own-hand against pi 0.80.3 (see `__grounding__/run-the-api-probe.mjs`
 * + the committed fixtures). The on-disk session JSONL is:
 *   line 1  — SessionHeader   `{type:"session", id, cwd, ...}`
 *   line N  — SessionEntry     `{type, id, parentId, timestamp, ...}`
 * A `thread_delivery` delivery is a `custom_message` entry:
 *   `{type:"custom_message", customType:"thread_delivery", content, display,
 *     details:{delivery_id, thread_id, attempt, holder_epoch}, id, parentId}`
 * Durable EXECUTION = a `message` entry with `message.role==="assistant"` that
 * is a DESCENDANT (parentId chain) of that custom entry — NOT merely "some
 * assistant somewhere in the file" (the F1 accepted-but-unconsumed fixture has
 * an assistant ANCESTOR, never a child). The deferred flush (E1) means a fresh
 * session has NO file on disk until the first assistant flushes it → an absent
 * file reads as `entryDurable:false` (volatile / observed, not accepted).
 */
import fs from "node:fs";

import {
  resolveLiveness as resolveLivenessPure,
  type DurableScanEvidence,
  type HolderIdentity,
  type HolderLiveness,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import { isProcessAlive } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";

/**
 * Structural mirror of the B2 `OutboxEntry` fields this scan consults.
 *
 * PACKAGING NOTE (surfaced to the supervisor): B2 defined `OutboxEntry` +
 * `RecoverEvidenceResolver` in `packages/server`, which ships NO `exports`
 * field and has no tsconfig `references` edge from `packages/extension`, so a
 * cross-package `@blackbelt-technology/pi-dashboard-server/...` import resolves
 * to neither tsc nor vitest (extension→shared is the only wired cross-package
 * path). Rather than add an unauthorized `exports` field to the server package
 * or reach across `rootDir` with a relative import, this file declares the
 * contract STRUCTURALLY. TypeScript's structural typing guarantees the object
 * `createRecoverEvidenceResolver` returns satisfies B2's
 * `RecoverEvidenceResolver` at the real (held) drain-loop call site. If the
 * supervisor prefers a nominal import, the fix is to relocate `OutboxEntry` +
 * `RecoverEvidenceResolver` into `packages/shared` (B2 edit) — flagged, not
 * done, per the do-not-edit-B2 discipline.
 */
export interface OutboxEntryView {
  delivery_id: string;
  attempt: number;
  holder_session_id: string;
  holder_identity: HolderIdentity;
  entry_id?: string;
  payload_hash: string;
}

/** Structural mirror of B2's `RecoverEvidenceResolver` (see note above). */
export interface RecoverEvidenceResolverView {
  resolveLiveness(entry: OutboxEntryView): HolderLiveness;
  scanEvidence(entry: OutboxEntryView): DurableScanEvidence;
  leaseElapsed?(entry: OutboxEntryView): boolean;
}

// ── the durable-session JSONL scan (pure over its text input) ──────────────

/** A parsed session-file entry (the fields the scan consults). */
interface RawEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  details?: { delivery_id?: string; attempt?: number; payload_hash?: string; [k: string]: unknown };
  message?: { role?: string };
}

/** Parse JSONL text into entries, skipping the header + any malformed line. */
export function parseSessionEntries(jsonlText: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const line of jsonlText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as RawEntry;
      if (e && typeof e.type === "string") out.push(e);
    } catch {
      /* skip malformed line — a torn tail never corrupts the scan */
    }
  }
  return out;
}

/** parentId-chain descent: is `descId` a descendant of `ancestorId`? */
function isDescendant(byId: Map<string, RawEntry>, descId: string, ancestorId: string): boolean {
  let cur = byId.get(descId);
  let guard = 0;
  while (cur && guard++ < 100_000) {
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * What the ORIGINAL causal tuple must match for the scan to be conflict-free.
 * `payload_hash` is optional because the real `thread_delivery` details carry
 * `{delivery_id, thread_id, attempt, holder_epoch}` (no payload hash) — a
 * payload conflict is only checkable when the caller persists a hash in
 * details; attempt/entry conflicts are always checkable.
 */
export interface ScanExpectation {
  delivery_id: string;
  attempt: number;
  /** If the entry was previously observed, its expected entry_id. */
  entry_id?: string;
  /** If details carry a payload_hash, the expected value. */
  payload_hash?: string;
}

/**
 * Scan a durable session JSONL for the `thread_delivery` delivery identified
 * by `expected.delivery_id`, returning `DurableScanEvidence` (design §C3.2).
 * Pure: operates on the file TEXT (I/O is the caller's `scanEvidence`).
 *
 *  - `entryDurable`               — the custom_message entry is present.
 *  - `hasPersistedAssistantChild` — an assistant `message` DESCENDANT of it.
 *  - `executedClaimCorroborated`  — true when the durable session itself
 *                                   corroborates execution (== the assistant
 *                                   descendant exists); a volatile label alone
 *                                   is insufficient, so this mirrors the
 *                                   persisted evidence, never a claim flag.
 *  - `conflict`                   — "attempt"|"entry"|"payload" vs the ORIGINAL
 *                                   tuple, else null.
 */
export function scanDurableEvidence(
  jsonlText: string,
  expected: ScanExpectation,
): DurableScanEvidence {
  const entries = parseSessionEntries(jsonlText);
  const byId = new Map<string, RawEntry>();
  for (const e of entries) if (e.id) byId.set(e.id, e);

  const delivery = entries.find(
    (e) =>
      e.type === "custom_message" &&
      e.customType === "thread_delivery" &&
      e.details?.delivery_id === expected.delivery_id,
  );

  if (!delivery) {
    // No durable entry (absent/unflushed/not-this-session) → volatile.
    return { entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false, conflict: null };
  }

  // Conflict detection vs the ORIGINAL tuple (design §C3.2 / §C2.1).
  let conflict: DurableScanEvidence["conflict"] = null;
  if (typeof delivery.details?.attempt === "number" && delivery.details.attempt !== expected.attempt) {
    conflict = "attempt";
  } else if (expected.entry_id !== undefined && delivery.id !== expected.entry_id) {
    conflict = "entry";
  } else if (
    expected.payload_hash !== undefined &&
    typeof delivery.details?.payload_hash === "string" &&
    delivery.details.payload_hash !== expected.payload_hash
  ) {
    conflict = "payload";
  }

  const hasPersistedAssistantChild = entries.some(
    (e) =>
      e.type === "message" &&
      e.message?.role === "assistant" &&
      e.id !== undefined &&
      delivery.id !== undefined &&
      isDescendant(byId, e.id, delivery.id),
  );

  return {
    entryDurable: true,
    hasPersistedAssistantChild,
    // The durable session corroborates execution exactly when the assistant
    // descendant is persisted — never from a volatile claim label.
    executedClaimCorroborated: hasPersistedAssistantChild,
    conflict,
  };
}

// ── the exact-identity liveness probe (never a bare PID — Alice E3) ─────────

/**
 * Resolve the live identity at a claimed holder's PID, or null if no process
 * holds it. Uses process START TIME as the reuse-defeating discriminator: a
 * live PID whose start time differs from the claim's `start_epoch` is a REUSED
 * pid (a DIFFERENT process) → reported with a mismatched identity so B1
 * `resolveLiveness` classifies it `exact_death` (never false-proves liveness).
 */
export interface LivenessProbe {
  /** True iff SOME process currently holds `pid`. */
  isAlive(pid: number): boolean;
  /** The start epoch of the process currently at `pid`, or null if none/unknown. */
  startEpochOf(pid: number): number | null;
  /**
   * The session_id the live process at `pid` belongs to, if the bridge can map
   * it (e.g. via its own session registry). When unknown, identity binding
   * falls back to (pid, start_epoch) — still reuse-safe.
   */
  sessionIdOf?(pid: number): string | null;
}

/** Default probe backed by the real process table + /proc-style start time. */
export function createDefaultLivenessProbe(opts: {
  startEpochOf: (pid: number) => number | null;
  sessionIdOf?: (pid: number) => string | null;
  isAlive?: (pid: number) => boolean;
}): LivenessProbe {
  return {
    isAlive: opts.isAlive ?? ((pid) => isProcessAlive(pid)),
    startEpochOf: opts.startEpochOf,
    sessionIdOf: opts.sessionIdOf,
  };
}

/**
 * Compute EXACT-identity liveness for a claim's holder (design §C3.2, Alice E3):
 * observe the identity at the claimed PID, then delegate the tuple comparison
 * to B1 `resolveLiveness` (pid + session_id + start_epoch — all three).
 */
export function resolveHolderLiveness(
  claim: HolderIdentity,
  probe: LivenessProbe,
): HolderLiveness {
  if (!probe.isAlive(claim.pid)) return resolveLivenessPure(claim, null);
  const startEpoch = probe.startEpochOf(claim.pid);
  if (startEpoch === null) {
    // Alive but we cannot prove it is the SAME process → conservative: treat
    // as a possibly-reused pid (mismatched identity → exact_death), never a
    // false-live that would hold forever.
    return resolveLivenessPure(claim, { pid: claim.pid, session_id: "__unknown__", start_epoch: -1 });
  }
  const observed: HolderIdentity = {
    pid: claim.pid,
    session_id: probe.sessionIdOf?.(claim.pid) ?? claim.session_id,
    start_epoch: startEpoch,
  };
  return resolveLivenessPure(claim, observed);
}

// ── the composed RecoverEvidenceResolver the B2 store injects ───────────────

/** Maps a holder `session_id` to its durable session-JSONL path (bridge-side). */
export type SessionFilePathResolver = (sessionId: string) => string | null;

export interface RecoverEvidenceDeps {
  /** Resolve the on-disk session file for a holder's session_id. */
  sessionFilePath: SessionFilePathResolver;
  /** The exact-identity liveness probe. */
  liveness: LivenessProbe;
  /** Optional bounded `indeterminate` lease predicate (design §C3.1 step 7). */
  leaseElapsed?: (entry: OutboxEntryView) => boolean;
}

/**
 * Build the real `RecoverEvidenceResolver` the B2 `OutboxStore.recover`
 * consults under the per-row lock. The store owns the DECISION (B1
 * `decideRecovery`); this resolver owns the pi-side EVIDENCE (scan + liveness).
 * Returns the structural `RecoverEvidenceResolverView` — assignable to B2's
 * `RecoverEvidenceResolver` at the held drain-loop call site (structural typing).
 */
export function createRecoverEvidenceResolver(deps: RecoverEvidenceDeps): RecoverEvidenceResolverView {
  return {
    resolveLiveness(entry: OutboxEntryView): HolderLiveness {
      return resolveHolderLiveness(entry.holder_identity, deps.liveness);
    },
    scanEvidence(entry: OutboxEntryView): DurableScanEvidence {
      const filePath = deps.sessionFilePath(entry.holder_session_id);
      if (filePath === null || !fs.existsSync(filePath)) {
        // Absent session file (fresh/unflushed) → volatile, not durable (E1).
        return { entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false, conflict: null };
      }
      let text = "";
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch {
        return { entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false, conflict: null };
      }
      return scanDurableEvidence(text, {
        delivery_id: entry.delivery_id,
        attempt: entry.attempt,
        entry_id: entry.entry_id,
        payload_hash: entry.payload_hash,
      });
    },
    leaseElapsed: deps.leaseElapsed,
  };
}
