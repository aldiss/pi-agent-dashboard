/**
 * Thread-durability durable outbox store — tests (design v3.6 §C1/§C2/N1).
 *
 * Covers: atomic durable write, the per-row lock (mkdir-atomic mutual
 * exclusion + conservative stale-reap), the full mutation set, reject-stale +
 * delivered-monotonic, recover-consults-claim, reconcileAccepted, the §C1.2
 * barrier close, and the exhaustive-mutation lock build-check (Bert §C1) —
 * both a STATIC source scan and a RUNTIME lock-assertion enumeration.
 *
 * Real fs under the HOME-isolation guard; each test uses its own mkdtemp.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../atomic-write.js";
import { RowLockManager, RowLockContendedError } from "../row-lock.js";
import {
  OutboxStore,
  LockNotHeldError,
  type AttemptInput,
  type OutboxEntry,
  type RecoverEvidenceResolver,
} from "../outbox-store.js";
import type {
  AcceptanceFact,
  DurableScanEvidence,
  HolderIdentity,
  HolderLiveness,
  OriginalTuple,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────

const IDENTITY: HolderIdentity = { pid: 4242, session_id: "sess-A", start_epoch: 1000 };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "td-outbox-"));
}

function attempt(over: Partial<AttemptInput> = {}): AttemptInput {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    holder_identity: { ...IDENTITY },
    holder_epoch: 7,
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

/** A fixed resolver for recover() tests. */
function resolver(
  liveness: HolderLiveness,
  ev: DurableScanEvidence,
  leaseElapsed = false,
): RecoverEvidenceResolver {
  return {
    resolveLiveness: () => liveness,
    scanEvidence: () => ev,
    leaseElapsed: () => leaseElapsed,
  };
}

/** Drive a fresh row through injecting→queued→observed→accepted→executed. */
async function driveToExecuted(store: OutboxStore, id = "D1"): Promise<OutboxEntry> {
  await store.markAttempting(attempt({ delivery_id: id }));
  await store.markQueued({ delivery_id: id, expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
  await store.markObserved({ delivery_id: id, expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" }, entry_id: "entry-1" });
  await store.markAccepted({ delivery_id: id, expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } });
  const r = await store.markExecuted({ delivery_id: id, expected: { expected_revision: 3, expected_attempt: 1, expected_state: "accepted" } });
  if (!r.ok) throw new Error("driveToExecuted failed");
  return r.entry;
}

let dir: string;
beforeEach(() => {
  dir = tmpDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── atomic durable write ─────────────────────────────────────────────────

describe("atomic-write", () => {
  it("writes durably and reads back exactly", () => {
    const f = path.join(dir, "x.json");
    atomicWriteFileSync(f, '{"a":1}');
    expect(readFileSync(f, "utf-8")).toBe('{"a":1}');
  });

  it("leaves NO tmp file behind (unique tmp cleaned by rename)", () => {
    const f = path.join(dir, "y.json");
    atomicWriteFileSync(f, "hello", { pid: 111, nonce: "abc" });
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("overwrites atomically (reader never sees a torn write)", () => {
    const f = path.join(dir, "z.json");
    atomicWriteFileSync(f, "v1");
    atomicWriteFileSync(f, "v2-longer-content");
    expect(readFileSync(f, "utf-8")).toBe("v2-longer-content");
  });
});

// ── per-row lock ───────────────────────────────────────────────────────────

describe("row-lock — mkdir-atomic mutual exclusion", () => {
  it("a second acquire while held is contended (mkdir EEXIST) → throws with maxRetries=0", async () => {
    const mgr = new RowLockManager(dir, { maxRetries: 0 });
    const h = await mgr.acquire("D1");
    const other = new RowLockManager(dir, { maxRetries: 0, isAlive: () => true });
    await expect(other.acquire("D1")).rejects.toBeInstanceOf(RowLockContendedError);
    mgr.release(h);
    // after release, acquire succeeds
    const h2 = await other.acquire("D1");
    expect(h2.delivery_id).toBe("D1");
    other.release(h2);
  });

  it("only the owner releases: a foreign manager's release does NOT remove our lock", async () => {
    const mgr = new RowLockManager(dir);
    const h = await mgr.acquire("D1");
    const foreign = new RowLockManager(dir);
    // Foreign fabricates a handle with a different nonce; release must no-op.
    foreign.release({ delivery_id: "D1", lockDir: mgr.lockDirFor("D1"), token: { pid: 9, host: "h", nonce: "not-ours", ts: 0 } });
    expect(fs.existsSync(mgr.lockDirFor("D1"))).toBe(true);
    mgr.release(h);
    expect(fs.existsSync(mgr.lockDirFor("D1"))).toBe(false);
  });
});

describe("row-lock — conservative stale-reap", () => {
  it("does NOT reap a live owner (same host, past TTL, but alive)", async () => {
    const now = { t: 100_000 };
    const mgr = new RowLockManager(dir, { now: () => now.t, ttlMs: 1000, isAlive: () => true });
    await mgr.acquire("D1"); // token ts=100_000
    now.t += 5000; // past TTL
    expect(mgr.reapIfStale("D1")).toBe(false);
    expect(fs.existsSync(mgr.lockDirFor("D1"))).toBe(true);
  });

  it("does NOT reap a cross-host owner (liveness unknowable) even if past TTL", async () => {
    const now = { t: 100_000 };
    const mgr = new RowLockManager(dir, { now: () => now.t, ttlMs: 1000, host: "hostA", isAlive: () => false });
    await mgr.acquire("D1");
    // Rewrite the token to a different host.
    const tokenPath = path.join(mgr.lockDirFor("D1"), "owner");
    fs.writeFileSync(tokenPath, JSON.stringify({ pid: 5, host: "hostB", nonce: "n", ts: now.t }));
    now.t += 5000;
    expect(mgr.reapIfStale("D1")).toBe(false);
    expect(fs.existsSync(mgr.lockDirFor("D1"))).toBe(true);
  });

  it("REAPS a same-host, provably-dead owner past the TTL", async () => {
    const now = { t: 100_000 };
    const mgr = new RowLockManager(dir, { now: () => now.t, ttlMs: 1000, host: "hostA", isAlive: () => false });
    await mgr.acquire("D1"); // token host=hostA (mgr's host), pid alive-check → false
    now.t += 5000;
    expect(mgr.reapIfStale("D1")).toBe(true);
    expect(fs.existsSync(mgr.lockDirFor("D1"))).toBe(false);
  });

  it("does NOT reap within the TTL even if the owner is dead", async () => {
    const now = { t: 100_000 };
    const mgr = new RowLockManager(dir, { now: () => now.t, ttlMs: 1000, isAlive: () => false });
    await mgr.acquire("D1");
    now.t += 500; // within TTL
    expect(mgr.reapIfStale("D1")).toBe(false);
  });
});

// ── mutations: full lifecycle + reject-stale + delivered-monotonic ─────────

describe("outbox-store — full lifecycle", () => {
  it("injecting → queued → observed → accepted → executed → delivered", async () => {
    const store = new OutboxStore(dir);
    const exec = await driveToExecuted(store);
    expect(exec.state).toBe("executed");
    expect(exec.revision).toBe(4);
    const del = await store.markDelivered({ delivery_id: "D1", expected: { expected_revision: 4, expected_attempt: 1, expected_state: "executed" } });
    expect(del.ok).toBe(true);
    if (del.ok) {
      expect(del.entry.delivered).toBe(true);
      expect(del.entry.revision).toBe(5);
    }
  });

  it("markObserved carries entry_id from the post-persist seam", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    const r = await store.markObserved({ delivery_id: "D1", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" }, entry_id: "entry-XYZ" });
    expect(r.ok && r.entry.entry_id).toBe("entry-XYZ");
  });
});

describe("outbox-store — reject-stale (revision-CAS)", () => {
  it("rejects a stale revision", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    const r = await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 99, expected_attempt: 1, expected_state: "injecting" } });
    expect(r).toEqual({ ok: false, reason: "revision_mismatch" });
  });

  it("rejects a stale attempt and a stale state", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    expect(await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 9, expected_state: "injecting" } })).toEqual({ ok: false, reason: "attempt_mismatch" });
    expect(await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "observed" } })).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("rejects an illegal (backward) transition even with a valid CAS", async () => {
    const store = new OutboxStore(dir);
    await driveToExecuted(store); // state executed, rev4
    // Try observed → executed is fine, but executed → observed is illegal.
    const r = await store.markObserved({ delivery_id: "D1", expected: { expected_revision: 4, expected_attempt: 1, expected_state: "executed" } });
    expect(r).toEqual({ ok: false, reason: "illegal_transition" });
  });
});

describe("outbox-store — delivered is monotonic + terminal", () => {
  it("a delivered row rejects EVERY further mutation (delivered never regresses)", async () => {
    const store = new OutboxStore(dir);
    await driveToExecuted(store);
    await store.markDelivered({ delivery_id: "D1", expected: { expected_revision: 4, expected_attempt: 1, expected_state: "executed" } });
    // Any subsequent mutation is rejected as delivered_terminal.
    expect(await store.markFailed({ delivery_id: "D1", expected: { expected_revision: 5, expected_attempt: 1, expected_state: "executed" } })).toEqual({ ok: false, reason: "delivered_terminal" });
    expect(await store.markAttempting(attempt({ attempt: 2 }))).toEqual({ ok: false, reason: "delivered_terminal" });
    expect(store.read("D1")!.delivered).toBe(true);
  });
});

describe("outbox-store — markAttempting re-arm", () => {
  it("re-arms a failed row only for a strictly-greater attempt", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markFailed({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    // same attempt → rejected
    expect(await store.markAttempting(attempt({ attempt: 1 }))).toEqual({ ok: false, reason: "attempt_mismatch" });
    // greater attempt → re-armed at injecting
    const r = await store.markAttempting(attempt({ attempt: 2 }));
    expect(r.ok && r.entry.state).toBe("injecting");
    expect(r.ok && r.entry.attempt).toBe(2);
  });
});

// ── recover consults the claim FIRST ───────────────────────────────────────

describe("outbox-store — recover consults the durable claim (design §C3.2)", () => {
  it("exact-death + NO durable execution → redeliver_once, row RETAINED (not terminalized)", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    const res = await store.recover("D1", resolver("exact_death", evidence({ entryDurable: false })));
    expect(res.outcome).toBe("redeliver_once");
    expect(res.terminalized).toBe(false);
    expect(store.read("D1")!.delivered).toBe(false); // retained, never dropped
  });

  it("exact-death + persisted assistant child → delivered_no_redeliver, row TERMINALIZED", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    const res = await store.recover("D1", resolver("exact_death", evidence({ entryDurable: true, hasPersistedAssistantChild: true })));
    expect(res.outcome).toBe("delivered_no_redeliver");
    expect(res.terminalized).toBe(true);
    expect(store.read("D1")!.delivered).toBe(true);
  });

  it("LIVE holder within lease → hold, row RETAINED, never re-drained on a scan-absent signal", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    // Even with an absent session (entryDurable:false), a LIVE holder holds — never redeliver.
    const res = await store.recover("D1", resolver("live", evidence({ entryDurable: false }), false));
    expect(res.outcome).toBe("hold");
    expect(res.terminalized).toBe(false);
  });

  it("LIVE holder, lease elapsed → operator_block (surfaced, not dropped, not retried)", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    const res = await store.recover("D1", resolver("live", evidence(), true));
    expect(res.outcome).toBe("operator_block");
    expect(res.terminalized).toBe(false);
  });

  it("exact-death + claim asserts accepted but entry NOT durable → fail_loud, row RETAINED", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    await store.markObserved({ delivery_id: "D1", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } });
    await store.markAccepted({ delivery_id: "D1", expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } });
    const res = await store.recover("D1", resolver("exact_death", evidence({ entryDurable: false })));
    expect(res.outcome).toBe("fail_loud");
    expect(res.terminalized).toBe(false);
    expect(store.read("D1")!.delivered).toBe(false);
  });
});

// ── reconcileAccepted store path ───────────────────────────────────────────

describe("outbox-store — reconcileAccepted", () => {
  function fact(over: Partial<AcceptanceFact> = {}): AcceptanceFact {
    return { delivery_id: "D1", attempt: 1, thread_id: "T1", holder_session_id: "sess-A", entry_id: "entry-1", payload_hash: "hash-1", accepted_at: 222, ...over };
  }
  function original(over: Partial<OriginalTuple> = {}): OriginalTuple {
    return { delivery_id: "D1", attempt: 1, holder_session_id: "sess-A", payload_hash: "hash-1", ...over };
  }

  it("valid fact + accepted row → terminalize to delivered at revision+1", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    await store.markObserved({ delivery_id: "D1", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } });
    await store.markAccepted({ delivery_id: "D1", expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } });
    const res = await store.reconcileAccepted(fact(), original());
    expect(res.action).toBe("terminalize");
    expect(res.entry!.delivered).toBe(true);
    expect(res.entry!.revision).toBe(4);
  });

  it("fact contradicting the ORIGINAL tuple → fail_loud, row RETAINED (not delivered)", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    const res = await store.reconcileAccepted(fact({ payload_hash: "WRONG" }), original());
    expect(res.action).toBe("fail_loud");
    expect(store.read("D1")!.delivered).toBe(false);
  });
});

// ── §C1.2 barrier close ────────────────────────────────────────────────────

describe("§C1.2 barrier — no two writers commit revision N+1", () => {
  it("two concurrent markQueued on the same row: exactly ONE commits N+1; the loser re-reads the new revision and is rejected", async () => {
    const store = new OutboxStore(dir, { backoffMs: 1 });
    await store.markAttempting(attempt()); // rev0 injecting

    const exp = { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" as const };
    const [a, b] = await Promise.all([
      store.markQueued({ delivery_id: "D1", expected: exp }),
      store.markQueued({ delivery_id: "D1", expected: exp }),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1); // exactly one winner
    expect(fails).toHaveLength(1); // exactly one loser
    // The loser re-read the winner's new revision and rejected on CAS.
    expect(store.read("D1")!.revision).toBe(1); // committed exactly once (0→1)
    expect(store.read("D1")!.state).toBe("queued_executing");
  });

  it("concurrent recover vs markFailed: serialized, one revision bump, delivered never regresses", async () => {
    const store = new OutboxStore(dir, { backoffMs: 1 });
    await store.markAttempting(attempt());
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });

    // recover → live+lease-elapsed → operator_block (no write); markFailed writes.
    const [rec, fail] = await Promise.all([
      store.recover("D1", resolver("live", evidence(), true)),
      store.markFailed({ delivery_id: "D1", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } }),
    ]);
    expect(rec.terminalized).toBe(false); // recover did not write
    // markFailed either wins (rev2 failed) — recover's read is consistent (never torn).
    const final = store.read("D1")!;
    expect(final.delivered).toBe(false); // never regressed
    if (fail.ok) expect(final.state).toBe("failed");
  });

  it("mutual exclusion: two managers cannot both hold the same row lock at once", async () => {
    const m1 = new RowLockManager(dir, { maxRetries: 0, isAlive: () => true });
    const m2 = new RowLockManager(dir, { maxRetries: 0, isAlive: () => true });
    const h1 = await m1.acquire("D1");
    await expect(m2.acquire("D1")).rejects.toBeInstanceOf(RowLockContendedError);
    m1.release(h1);
  });
});

// ── exhaustive-mutation lock build-check (Bert §C1) ────────────────────────

describe("exhaustive-mutation lock build-check", () => {
  const storeSrc = readFileSync(new URL("../outbox-store.ts", import.meta.url), "utf-8");

  it("STATIC: atomicWriteFileSync appears exactly once — the single write funnel (commit)", () => {
    const count = (storeSrc.match(/atomicWriteFileSync\(/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("STATIC: the single write funnel `commit` asserts the lock is held before writing", () => {
    // commit throws LockNotHeldError when !isHeldLocally — the runtime backstop.
    expect(storeSrc).toMatch(/private commit\([^)]*\)[^{]*\{[\s\S]*?isHeldLocally[\s\S]*?LockNotHeldError[\s\S]*?atomicWriteFileSync/);
  });

  it("STATIC: no raw fs write/rename primitives in the store (they live in atomic-write.ts)", () => {
    expect(storeSrc).not.toMatch(/fs\.writeFileSync\(/);
    expect(storeSrc).not.toMatch(/fs\.renameSync\(/);
    expect(storeSrc).not.toMatch(/fs\.writeSync\(/);
  });

  it("STATIC: the only other disk mutation (gc unlink) is inside a withLock critical section", () => {
    const unlinkCount = (storeSrc.match(/fs\.unlinkSync\(/g) ?? []).length;
    expect(unlinkCount).toBe(1);
    // gc's body opens a withLock critical section.
    expect(storeSrc).toMatch(/gc\([^)]*\)[^{]*\{[\s\S]*?this\.withLock\([\s\S]*?fs\.unlinkSync/);
  });

  it("RUNTIME: commit throws LockNotHeldError if a write is attempted lock-free", async () => {
    const store = new OutboxStore(dir);
    await store.markAttempting(attempt());
    const entry = store.read("D1")!;
    // Reach past `private` to prove the runtime guard fires without a lock.
    const commit = (store as unknown as { commit: (id: string, e: OutboxEntry, op: string) => void }).commit.bind(store);
    expect(() => commit("D1", entry, "lockfree-test")).toThrow(LockNotHeldError);
  });

  it("RUNTIME: EVERY mutation entry point writes only under the lock (each drives to a committing outcome without throwing LockNotHeldError)", async () => {
    const store = new OutboxStore(dir);

    // 1. markAttempting (create)
    expect((await store.markAttempting(attempt())).ok).toBe(true);
    // 2. markQueued
    expect((await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } })).ok).toBe(true);
    // 3. markObserved
    expect((await store.markObserved({ delivery_id: "D1", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } })).ok).toBe(true);
    // 4. markAccepted
    expect((await store.markAccepted({ delivery_id: "D1", expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } })).ok).toBe(true);
    // 5. markExecuted
    expect((await store.markExecuted({ delivery_id: "D1", expected: { expected_revision: 3, expected_attempt: 1, expected_state: "accepted" } })).ok).toBe(true);
    // 6. markDelivered
    expect((await store.markDelivered({ delivery_id: "D1", expected: { expected_revision: 4, expected_attempt: 1, expected_state: "executed" } })).ok).toBe(true);

    // 7. markFailed (fresh row D2)
    await store.markAttempting(attempt({ delivery_id: "D2" }));
    expect((await store.markFailed({ delivery_id: "D2", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } })).ok).toBe(true);

    // 8. reconcileAccepted (fresh row D3 driven to accepted)
    await store.markAttempting(attempt({ delivery_id: "D3" }));
    await store.markQueued({ delivery_id: "D3", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    await store.markObserved({ delivery_id: "D3", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } });
    await store.markAccepted({ delivery_id: "D3", expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } });
    const rec = await store.reconcileAccepted(
      { delivery_id: "D3", attempt: 1, thread_id: "T1", holder_session_id: "sess-A", entry_id: "e", payload_hash: "hash-1", accepted_at: 1 },
      { delivery_id: "D3", attempt: 1, holder_session_id: "sess-A", payload_hash: "hash-1" },
    );
    expect(rec.action).toBe("terminalize");

    // 9. recover (fresh row D4 → terminalize path writes)
    await store.markAttempting(attempt({ delivery_id: "D4" }));
    const recovered = await store.recover("D4", resolver("exact_death", evidence({ entryDurable: true, hasPersistedAssistantChild: true })));
    expect(recovered.terminalized).toBe(true);

    // 10. gc (D1 is delivered; advance now past retention)
    const store2 = new OutboxStore(dir, { now: () => Date.now() + 10_000_000 });
    expect(await store2.gc("D1", 1000)).toBe(true);
  });
});
