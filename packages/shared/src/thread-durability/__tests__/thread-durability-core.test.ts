/**
 * Thread-durability pure core — tests (design v3.6 §C3.4 five-case matrix +
 * direct unit tests for state-machine / revision-CAS / reconcile).
 *
 * The §C3.4 matrix is the shared falsifiable close: if any case would inject
 * twice or drop, its test fails. Each of the five cases is a NAMED test.
 */
import { describe, expect, it } from "vitest";

import {
  canTransition,
  isTerminal,
  progressRank,
} from "../state-machine.js";
import { validateMutation } from "../revision-cas.js";
import { reconcileAccepted } from "../reconcile.js";
import { decideRecovery, resolveLiveness } from "../recovery-decision.js";
import type {
  AcceptanceFact,
  Claim,
  DeliveryRecord,
  DeliveryState,
  DurableScanEvidence,
  HolderIdentity,
  OriginalTuple,
} from "../types.js";

// ── Builders ───────────────────────────────────────────────────────────────

const IDENTITY: HolderIdentity = { pid: 4242, session_id: "sess-A", start_epoch: 1000 };

function claim(over: Partial<Claim> = {}): Claim {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    holder_identity: { ...IDENTITY },
    holder_epoch: 7,
    payload_hash: "hash-1",
    state: "injecting",
    updated_at: 111,
    ...over,
  };
}

function row(over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    payload_hash: "hash-1",
    state: "injecting",
    revision: 5,
    delivered: false,
    updated_at: 111,
    ...over,
  };
}

function fact(over: Partial<AcceptanceFact> = {}): AcceptanceFact {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    entry_id: "entry-1",
    payload_hash: "hash-1",
    accepted_at: 222,
    ...over,
  };
}

function original(over: Partial<OriginalTuple> = {}): OriginalTuple {
  return {
    delivery_id: "D1",
    attempt: 1,
    holder_session_id: "sess-A",
    payload_hash: "hash-1",
    ...over,
  };
}

function evidence(over: Partial<DurableScanEvidence> = {}): DurableScanEvidence {
  return {
    entryDurable: false,
    hasPersistedAssistantChild: false,
    executedClaimCorroborated: false,
    conflict: null,
    ...over,
  };
}

// ── §C3.4 — the five-case falsifiable matrix ────────────────────────────────

describe("§C3.4 case 1 — under-state (Bert double-exec window)", () => {
  it("crash after the Pi call with queued_executing written before it: exact-death + no durable execution → redeliver EXACTLY once (never a crossed-turn double)", () => {
    // `queued_executing` was fsync'd BEFORE the call, so recovery never treats
    // a possibly-crossed turn as never-dispatched. On exact-death the durable
    // scan decides — here NO persisted assistant child ⇒ definitive
    // non-execution ⇒ re-deliver once (not twice, not drop).
    const c = claim({ state: "queued_executing" });
    const decision = decideRecovery(c, "exact_death", evidence({ entryDurable: false }));
    expect(decision).toBe("redeliver_once");
  });

  it("same window but a durable assistant child exists → delivered, do NOT redeliver (the crossed turn executed)", () => {
    const c = claim({ state: "queued_executing" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: true, hasPersistedAssistantChild: true }),
    );
    expect(decision).toBe("delivered_no_redeliver");
  });

  it("while the holder is still LIVE, the same window never retries and never hangs-forever: hold → operator_block on lease-elapse", () => {
    const c = claim({ state: "queued_executing" });
    expect(decideRecovery(c, "live", evidence(), false)).toBe("hold");
    expect(decideRecovery(c, "live", evidence(), true)).toBe("operator_block");
  });
});

describe("§C3.4 case 2 — over-state drop (Alice E1) + accepted-but-unconsumed (F1)", () => {
  it("fresh session, crash before first-assistant flush: claim is `observed` (not accepted) → exact-death re-delivers exactly once", () => {
    const c = claim({ state: "observed", entry_id: "entry-1" });
    const decision = decideRecovery(c, "exact_death", evidence({ entryDurable: false }));
    expect(decision).toBe("redeliver_once");
  });

  it("F1: established session, entry durable immediately with NO assistant child (accepted-but-unconsumed) + exact-death → re-deliver exactly once (a flush proves acceptance, not consumption)", () => {
    const c = claim({ state: "accepted", entry_id: "entry-1" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: true, hasPersistedAssistantChild: false }),
    );
    expect(decision).toBe("redeliver_once");
  });

  it("sibling case: durably-persisted assistant child after the entry → executed → do NOT re-deliver", () => {
    const c = claim({ state: "accepted", entry_id: "entry-1" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: true, hasPersistedAssistantChild: true }),
    );
    expect(decision).toBe("delivered_no_redeliver");
  });

  it("corrupt-executed: claim asserts `executed` but the final session has NO corroborating durable proof → fail loud", () => {
    const c = claim({ state: "executed" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: false, hasPersistedAssistantChild: false, executedClaimCorroborated: false }),
    );
    expect(decision).toBe("fail_loud");
  });

  it("F1 double-exec-safety: an accepted-but-unconsumed row is nonterminal and re-deliverable — never suppressed as if executed", () => {
    // The over-state failure would be to treat `accepted` as `executed`.
    const c = claim({ state: "accepted" });
    const decision = decideRecovery(c, "exact_death", evidence({ entryDurable: true }));
    expect(decision).not.toBe("delivered_no_redeliver");
    expect(decision).toBe("redeliver_once");
  });
});

describe("§C3.4 case 3 — uncorrelated-failure liveness (E2)", () => {
  it("correlated `failed` while the holder stays live → re-inject (proven not-injected), never a double", () => {
    const c = claim({ state: "failed" });
    expect(decideRecovery(c, "live", evidence())).toBe("redeliver_once");
  });

  it("no correlated failure adapter: a live pre-turn failure never hangs forever and never double-injects — bounded lease → operator-visible block", () => {
    const c = claim({ state: "queued_executing" });
    // Within lease: HOLD (never scan-absent retry while live).
    expect(decideRecovery(c, "live", evidence(), false)).toBe("hold");
    // Lease elapsed: operator-visible BLOCK (never a silent infinite hold).
    expect(decideRecovery(c, "live", evidence(), true)).toBe("operator_block");
  });

  it("a delayed success arriving as an `executed` claim while live does not double-inject (resolves delivered, not redeliver)", () => {
    const c = claim({ state: "executed" });
    expect(decideRecovery(c, "live", evidence())).toBe("delivered_no_redeliver");
  });
});

describe("§C3.4 case 4 — rotation while old-live (E3 death-only)", () => {
  it("old exact-identity still LIVE after rotation: successor receives NOTHING (hold), never a redeliver to the successor while the predecessor lives", () => {
    const c = claim({ state: "queued_executing" });
    const observedSame: HolderIdentity = { ...IDENTITY };
    const liveness = resolveLiveness(c.holder_identity, observedSame);
    expect(liveness).toBe("live");
    expect(decideRecovery(c, liveness, evidence(), false)).toBe("hold");
  });

  it("reused PID does NOT false-prove death: same pid, different session_id/start_epoch → exact_death (the original holder is gone)", () => {
    const c = claim({ state: "observed" });
    const reused: HolderIdentity = { pid: IDENTITY.pid, session_id: "sess-OTHER", start_epoch: 9999 };
    const liveness = resolveLiveness(c.holder_identity, reused);
    expect(liveness).toBe("exact_death");
    // …and because it IS exact-death with no durable execution → redeliver once.
    expect(decideRecovery(c, liveness, evidence())).toBe("redeliver_once");
  });

  it("reused PID must NOT be read as live (which would hold forever) — the reused-PID case is never `live`", () => {
    const c = claim();
    const reusedPidOnly: HolderIdentity = { pid: IDENTITY.pid, session_id: "sess-Z", start_epoch: 2 };
    expect(resolveLiveness(c.holder_identity, reusedPidOnly)).not.toBe("live");
  });

  it("no process at the PID at all → exact_death", () => {
    const c = claim();
    expect(resolveLiveness(c.holder_identity, null)).toBe("exact_death");
  });
});

describe("§C3.4 case 5 — identity under ingress + duplicate delivery_ids", () => {
  it("two identical prompts with DISTINCT delivery_ids: a fact for D1 terminalizes only the D1 row, never the D2 row (bind by delivery_id, not text/position)", () => {
    const factD1 = fact({ delivery_id: "D1", payload_hash: "same-hash" });
    const origD1 = original({ delivery_id: "D1", payload_hash: "same-hash" });

    const rowD1 = row({ delivery_id: "D1", payload_hash: "same-hash", state: "accepted" });
    const rowD2 = row({ delivery_id: "D2", payload_hash: "same-hash", state: "accepted" });

    // Same fact/original (D1) against each row — identical payloads.
    expect(reconcileAccepted(factD1, origD1, rowD1)).toEqual({
      action: "terminalize",
      newRevision: rowD1.revision + 1,
    });
    // D2 row is NOT closed by a D1 fact even though the payload is identical.
    expect(reconcileAccepted(factD1, origD1, rowD2)).toEqual({ action: "noop" });
  });

  it("a fact for an old attempt cannot close a newer attempt of the same delivery_id", () => {
    const oldFact = fact({ attempt: 1 });
    const oldOrig = original({ attempt: 1 });
    const newerRow = row({ attempt: 2, state: "accepted" });
    expect(reconcileAccepted(oldFact, oldOrig, newerRow)).toEqual({ action: "noop" });
  });

  it("binding is by delivery_id, never by interleaved TUI/RPC position: a mismatched-delivery current row is a noop, not a mis-close", () => {
    const f = fact({ delivery_id: "D1" });
    const o = original({ delivery_id: "D1" });
    const tuiRow = row({ delivery_id: "TUI-entry-77", state: "observed" });
    expect(reconcileAccepted(f, o, tuiRow).action).toBe("noop");
  });
});

// ── Direct unit tests — state machine ───────────────────────────────────────

describe("state-machine — canTransition (monotonic progress)", () => {
  const forward: Array<[DeliveryState, DeliveryState]> = [
    ["injecting", "queued_executing"],
    ["queued_executing", "observed"],
    ["observed", "accepted"],
    ["accepted", "executed"],
  ];

  it.each(forward)("legal forward step %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("legal forward SKIP observed → executed (fresh-session flush proves durable + executes in one step)", () => {
    expect(canTransition("observed", "executed")).toBe(true);
    expect(canTransition("injecting", "accepted")).toBe(true);
  });

  it("any non-terminal → failed is legal", () => {
    for (const from of ["injecting", "queued_executing", "observed", "accepted"] as DeliveryState[]) {
      expect(canTransition(from, "failed")).toBe(true);
    }
  });

  it("rejects a backward transition (would under-state progress)", () => {
    expect(canTransition("accepted", "observed")).toBe(false);
    expect(canTransition("observed", "queued_executing")).toBe(false);
    expect(canTransition("executed", "accepted")).toBe(false);
  });

  it("rejects a same-state self-loop (no progress)", () => {
    expect(canTransition("observed", "observed")).toBe(false);
  });

  it("no exit from a terminal state", () => {
    for (const to of ["injecting", "queued_executing", "observed", "accepted", "executed", "failed"] as DeliveryState[]) {
      expect(canTransition("executed", to)).toBe(false);
      expect(canTransition("failed", to)).toBe(false);
    }
  });

  it("isTerminal is exactly {executed, failed}", () => {
    expect(isTerminal("executed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    for (const s of ["injecting", "queued_executing", "observed", "accepted"] as DeliveryState[]) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it("progressRank is strictly increasing along the chain", () => {
    expect(progressRank("injecting")).toBeLessThan(progressRank("queued_executing"));
    expect(progressRank("queued_executing")).toBeLessThan(progressRank("observed"));
    expect(progressRank("observed")).toBeLessThan(progressRank("accepted"));
    expect(progressRank("accepted")).toBeLessThan(progressRank("executed"));
  });
});

// ── Direct unit tests — revision-CAS ────────────────────────────────────────

describe("revision-cas — validateMutation (reject-stale)", () => {
  it("accepts a matching expectation", () => {
    const cur = row({ revision: 5, attempt: 1, state: "observed" });
    expect(
      validateMutation({ expected_revision: 5, expected_attempt: 1, expected_state: "observed" }, cur),
    ).toEqual({ ok: true });
  });

  it("rejects a stale revision", () => {
    const cur = row({ revision: 6, attempt: 1, state: "observed" });
    expect(
      validateMutation({ expected_revision: 5, expected_attempt: 1, expected_state: "observed" }, cur),
    ).toEqual({ ok: false, reason: "revision_mismatch" });
  });

  it("rejects a stale attempt", () => {
    const cur = row({ revision: 5, attempt: 2, state: "observed" });
    expect(
      validateMutation({ expected_revision: 5, expected_attempt: 1, expected_state: "observed" }, cur),
    ).toEqual({ ok: false, reason: "attempt_mismatch" });
  });

  it("rejects a stale state", () => {
    const cur = row({ revision: 5, attempt: 1, state: "accepted" });
    expect(
      validateMutation({ expected_revision: 5, expected_attempt: 1, expected_state: "observed" }, cur),
    ).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("delivered is monotonic + terminal: a delivered row rejects EVERY mutation (delivered never regresses)", () => {
    const cur = row({ delivered: true, revision: 5, attempt: 1, state: "executed" });
    expect(
      validateMutation({ expected_revision: 5, expected_attempt: 1, expected_state: "executed" }, cur),
    ).toEqual({ ok: false, reason: "delivered_terminal" });
  });

  it("no two writers commit revision N+1: the loser (stale revision) is rejected", () => {
    // Writer A committed 5→6; writer B still expects 5.
    const afterA = row({ revision: 6, state: "accepted" });
    const bValidation = validateMutation(
      { expected_revision: 5, expected_attempt: 1, expected_state: "observed" },
      afterA,
    );
    expect(bValidation.ok).toBe(false);
  });
});

// ── Direct unit tests — reconcile ───────────────────────────────────────────

describe("reconcile — reconcileAccepted", () => {
  it("valid fact + matching nonterminal row → terminalize at revision+1", () => {
    const cur = row({ state: "accepted", revision: 8 });
    expect(reconcileAccepted(fact(), original(), cur)).toEqual({
      action: "terminalize",
      newRevision: 9,
    });
  });

  it("fact contradicts the ORIGINAL tuple (different payload) → fail loud", () => {
    const badFact = fact({ payload_hash: "hash-OTHER" });
    expect(reconcileAccepted(badFact, original(), row({ state: "accepted" }))).toEqual({
      action: "fail_loud",
    });
  });

  it("fact for a different holder_session_id than the original → fail loud", () => {
    const badFact = fact({ holder_session_id: "sess-B" });
    expect(reconcileAccepted(badFact, original(), row({ state: "accepted" }))).toEqual({
      action: "fail_loud",
    });
  });

  it("already-delivered row → noop (monotonic terminal, idempotent)", () => {
    const cur = row({ delivered: true, state: "executed" });
    expect(reconcileAccepted(fact(), original(), cur)).toEqual({ action: "noop" });
  });

  it("same delivery_id + attempt but divergent row payload → fail loud (corruption)", () => {
    const cur = row({ state: "accepted", payload_hash: "hash-CORRUPT" });
    expect(reconcileAccepted(fact(), original(), cur)).toEqual({ action: "fail_loud" });
  });

  it("durable acceptance fact contradicting a `failed` row (same delivery+attempt) → fail loud", () => {
    const cur = row({ state: "failed" });
    expect(reconcileAccepted(fact(), original(), cur)).toEqual({ action: "fail_loud" });
  });

  it("terminalizes only the matching nonterminal row; never regresses delivered", () => {
    const cur = row({ state: "observed", revision: 0 });
    const res = reconcileAccepted(fact(), original(), cur);
    expect(res.action).toBe("terminalize");
    expect(res.newRevision).toBe(1);
  });
});

// ── Recovery — direct coverage of the live/dead table + failed fast-path ─────

describe("recovery-decision — decideRecovery table", () => {
  it("correlated failed → redeliver_once regardless of liveness", () => {
    expect(decideRecovery(claim({ state: "failed" }), "exact_death", evidence())).toBe("redeliver_once");
    expect(decideRecovery(claim({ state: "failed" }), "live", evidence())).toBe("redeliver_once");
  });

  it("exact-death + evidence.conflict set → fail loud (takes precedence over any execution evidence)", () => {
    const c = claim({ state: "accepted" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: true, hasPersistedAssistantChild: true, conflict: "payload" }),
    );
    expect(decision).toBe("fail_loud");
  });

  it("exact-death + executedClaimCorroborated (corroborated executed claim) → delivered_no_redeliver", () => {
    const c = claim({ state: "executed" });
    const decision = decideRecovery(
      c,
      "exact_death",
      evidence({ entryDurable: true, executedClaimCorroborated: true }),
    );
    expect(decision).toBe("delivered_no_redeliver");
  });

  it("exact-death + claim `accepted` but entry NOT durable (over-stated) → fail loud", () => {
    const c = claim({ state: "accepted" });
    const decision = decideRecovery(c, "exact_death", evidence({ entryDurable: false }));
    expect(decision).toBe("fail_loud");
  });

  it("exact-death + injecting/queued_executing/observed without evidence → redeliver_once", () => {
    for (const s of ["injecting", "queued_executing", "observed"] as DeliveryState[]) {
      expect(decideRecovery(claim({ state: s }), "exact_death", evidence())).toBe("redeliver_once");
    }
  });

  it("live + non-terminal within lease → hold; lease elapsed → operator_block", () => {
    for (const s of ["injecting", "queued_executing", "observed", "accepted"] as DeliveryState[]) {
      expect(decideRecovery(claim({ state: s }), "live", evidence(), false)).toBe("hold");
      expect(decideRecovery(claim({ state: s }), "live", evidence(), true)).toBe("operator_block");
    }
  });

  it("live + executed → delivered_no_redeliver (never re-inject a delivered turn)", () => {
    expect(decideRecovery(claim({ state: "executed" }), "live", evidence())).toBe("delivered_no_redeliver");
  });
});
