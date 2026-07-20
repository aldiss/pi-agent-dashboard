/**
 * B4 step 3 — the A5 thread-status push channel (design v3.6 A5).
 *
 * Exercised against the REAL B2 `OutboxStore` (temp dir, HOME-isolation guard)
 * so the outbox-as-source-of-truth, idempotent publish, subscribe+replay, and
 * REST-fallback snapshot are all genuinely proven end-to-end.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OutboxStore } from "../outbox-store.js";
import { ThreadPushChannel } from "../push-channel.js";
import type { AttemptInput } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import type { ThreadDeliverySnapshot } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

const IDENTITY = { pid: 4242, session_id: "sess-A", start_epoch: 1000 };

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

let dir: string;
let store: OutboxStore;
let channel: ThreadPushChannel;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-push-"));
  store = new OutboxStore(dir);
  channel = new ThreadPushChannel({ store });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ThreadPushChannel — outbox is the source of truth", () => {
  it("publish reads the durable row and fans out its snapshot to live subscribers", async () => {
    await store.markAttempting(attempt());
    // Realistic flow: publish rev0 first (drain mutate→publish is synchronous),
    // THEN a mutation + publish delivers the delta to an already-subscribed sink.
    channel.publish("D1"); // rev0 injecting → gate=0

    const received: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => received.push(s), { threadId: "T1" });
    received.length = 0; // ignore the replay of current (rev0) state

    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    const published = channel.publish("D1"); // rev1 queued_executing → delta
    expect(published?.state).toBe("queued_executing");
    expect(published?.thread_id).toBe("T1");
    expect(received).toHaveLength(1);
    expect(received[0].revision).toBe(1);
  });

  it("publish returns null for an absent row", () => {
    expect(channel.publish("NOPE")).toBeNull();
  });
});

describe("ThreadPushChannel — idempotent publish (dedup by {delivery_id,state,revision})", () => {
  it("re-publishing the same revision is deduplicated (no second fan-out)", async () => {
    await store.markAttempting(attempt());
    const received: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => received.push(s)); // no replay match yet? replay sends rev0
    received.length = 0; // ignore replay

    expect(channel.publish("D1")).not.toBeNull(); // rev0 published
    expect(channel.publish("D1")).toBeNull(); // same rev0 → deduped
    expect(channel.publish("D1")).toBeNull(); // still deduped
    expect(received).toHaveLength(1); // fanned out exactly once
  });

  it("a newer revision publishes; an older/equal revision never regresses", async () => {
    await store.markAttempting(attempt()); // rev0 injecting
    channel.publish("D1"); // gate=0
    await store.markQueued({ delivery_id: "D1", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } }); // rev1

    const received: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => received.push(s));
    received.length = 0;

    const pub = channel.publish("D1"); // rev1 queued_executing
    expect(pub?.revision).toBe(1);
    expect(pub?.state).toBe("queued_executing");
    expect(channel.publish("D1")).toBeNull(); // rev1 again → deduped
    expect(received).toHaveLength(1);
  });
});

describe("ThreadPushChannel — subscribe + replay", () => {
  it("a new subscriber immediately receives the current outbox snapshot per thread", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "B", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "C", thread_id: "T2" }));

    const t1: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => t1.push(s), { threadId: "T1" });
    // Replay delivers the two T1 rows, not the T2 row.
    expect(t1.map((s) => s.delivery_id).sort()).toEqual(["A", "B"]);
    expect(t1.every((s) => s.thread_id === "T1")).toBe(true);
  });

  it("an unfiltered subscriber replays every thread", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "C", thread_id: "T2" }));
    const all: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => all.push(s));
    expect(all.map((s) => s.delivery_id).sort()).toEqual(["A", "C"]);
  });

  it("live deltas reach the subscriber after replay", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    const seen: ThreadDeliverySnapshot[] = [];
    channel.subscribe((s) => seen.push(s), { threadId: "T1" });
    seen.length = 0; // drop replay

    await store.markQueued({ delivery_id: "A", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    channel.publish("A");
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toBe("queued_executing");
  });

  it("unsubscribe stops future deltas", async () => {
    await store.markAttempting(attempt({ delivery_id: "A" }));
    const seen: ThreadDeliverySnapshot[] = [];
    const off = channel.subscribe((s) => seen.push(s));
    seen.length = 0;
    off();
    channel.publish("A");
    expect(seen).toHaveLength(0);
    expect(channel.subscriberCount).toBe(0);
  });

  it("a throwing subscriber never breaks the fanout to others", async () => {
    await store.markAttempting(attempt({ delivery_id: "A" }));
    const good: ThreadDeliverySnapshot[] = [];
    channel.subscribe(() => { throw new Error("boom"); });
    channel.subscribe((s) => good.push(s));
    good.length = 0;
    await store.markQueued({ delivery_id: "A", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    expect(() => channel.publish("A")).not.toThrow();
    expect(good).toHaveLength(1);
  });
});

describe("ThreadPushChannel — REST fallback snapshot", () => {
  it("snapshotForThread returns the current per-thread state sorted stably", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "B", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "Z", thread_id: "T2" }));

    const snap = channel.snapshotForThread("T1");
    expect(snap.map((s) => s.delivery_id)).toEqual(["A", "B"]);
    expect(snap.every((s) => s.thread_id === "T1")).toBe(true);
  });

  it("reflects live state transitions (SoT), works with zero subscribers", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markQueued({ delivery_id: "A", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    const snap = channel.snapshotForThread("T1");
    expect(snap).toHaveLength(1);
    expect(snap[0].state).toBe("queued_executing");
    expect(snap[0].revision).toBe(1);
  });

  it("empty thread → empty snapshot", () => {
    expect(channel.snapshotForThread("NOPE")).toEqual([]);
  });
});

describe("OutboxStore.list / listByThread (the enumeration the channel relies on)", () => {
  it("list returns every durable row; listByThread filters", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "B", thread_id: "T2" }));
    expect(store.list().map((r) => r.delivery_id).sort()).toEqual(["A", "B"]);
    expect(store.listByThread("T1").map((r) => r.delivery_id)).toEqual(["A"]);
  });

  it("ignores .lock dirs and non-json files", async () => {
    await store.markAttempting(attempt({ delivery_id: "A" }));
    // A stray lock dir + tmp file must not appear as rows.
    fs.mkdirSync(path.join(dir, "A.lock"), { recursive: true });
    fs.writeFileSync(path.join(dir, "junk.tmp"), "not json");
    expect(store.list().map((r) => r.delivery_id)).toEqual(["A"]);
  });
});
