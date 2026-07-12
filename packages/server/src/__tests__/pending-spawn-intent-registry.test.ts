import { describe, it, expect } from "vitest";
import {
  createPendingSpawnIntentRegistry,
  PENDING_SPAWN_INTENT_TTL_MS,
  type SpawnIntentInput,
} from "../pending-spawn-intent-registry.js";

/** A mutable clock so TTL is deterministic without fake timers. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function intent(over: Partial<SpawnIntentInput> = {}): SpawnIntentInput {
  return {
    spawnToken: "tok-1",
    name: "Driver-1",
    cwd: "/orchestration-state",
    flavor: "new",
    directive: { text: "kickoff: read your brief" },
    ...over,
  };
}

describe("PendingSpawnIntentRegistry", () => {
  it("records a pending intent readable via get() (status poll)", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent());
    expect(reg.get("tok-1")).toMatchObject({
      spawnToken: "tok-1",
      name: "Driver-1",
      cwd: "/orchestration-state",
      flavor: "new",
      status: "pending",
    });
    // get() never leaks the directive
    expect((reg.get("tok-1") as unknown as Record<string, unknown>).directive).toBeUndefined();
  });

  it("resolveOnRegister returns the directive, flips to ok, carries the sessionId", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent({ directive: { text: "kickoff X" } }));
    const directive = reg.resolveOnRegister("tok-1", "sess-abc");
    expect(directive).toEqual({ text: "kickoff X" });
    expect(reg.get("tok-1")).toMatchObject({ status: "ok", sessionId: "sess-abc" });
  });

  it("delivers the directive EXACTLY ONCE (second register is a no-op)", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent());
    expect(reg.resolveOnRegister("tok-1", "sess-abc")).not.toBeNull();
    // a duplicate/late register for the same token must NOT re-deliver
    expect(reg.resolveOnRegister("tok-1", "sess-abc")).toBeNull();
    // status stays ok on the first-resolved sessionId
    expect(reg.get("tok-1")).toMatchObject({ status: "ok", sessionId: "sess-abc" });
  });

  it("fail() flips a pending intent to failed with a terminal reason", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent());
    reg.fail("tok-1", "register-timeout");
    expect(reg.get("tok-1")).toMatchObject({ status: "failed", reason: "register-timeout" });
  });

  it("never overrides a resolved outcome (fail after ok is a no-op; register after fail is null)", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent());
    // resolve first, then a late watchdog fail must NOT clobber the ok
    reg.resolveOnRegister("tok-1", "sess-abc");
    reg.fail("tok-1", "register-timeout");
    expect(reg.get("tok-1")).toMatchObject({ status: "ok", sessionId: "sess-abc" });

    // and the mirror: fail first, then a straggler register resolves to null
    reg.record(intent({ spawnToken: "tok-2" }));
    reg.fail("tok-2", "register-timeout");
    expect(reg.resolveOnRegister("tok-2", "sess-late")).toBeNull();
    expect(reg.get("tok-2")).toMatchObject({ status: "failed", reason: "register-timeout" });
  });

  it("is a clean no-op for an unknown token (a non-spawn register)", () => {
    const reg = createPendingSpawnIntentRegistry();
    expect(reg.get("never-recorded")).toBeNull();
    expect(reg.resolveOnRegister("never-recorded", "sess-x")).toBeNull();
    reg.fail("never-recorded", "whatever"); // must not throw
    expect(reg.size()).toBe(0);
  });

  it("keeps two same-cwd spawns with DIFFERENT tokens independent (the shared-cwd fix)", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent({ spawnToken: "tok-a", name: "A", cwd: "/shared", directive: { text: "for A" } }));
    reg.record(intent({ spawnToken: "tok-b", name: "B", cwd: "/shared", directive: { text: "for B" } }));
    // each token resolves to its OWN directive/session — no cwd collision
    expect(reg.resolveOnRegister("tok-a", "sess-a")).toEqual({ text: "for A" });
    expect(reg.resolveOnRegister("tok-b", "sess-b")).toEqual({ text: "for B" });
    expect(reg.get("tok-a")).toMatchObject({ status: "ok", sessionId: "sess-a", name: "A" });
    expect(reg.get("tok-b")).toMatchObject({ status: "ok", sessionId: "sess-b", name: "B" });
  });

  it("drops a record after its TTL (status poll observes then it is swept)", () => {
    const c = clock();
    const reg = createPendingSpawnIntentRegistry({ now: c.now });
    reg.record(intent());
    expect(reg.get("tok-1")).toMatchObject({ status: "pending" });
    c.advance(PENDING_SPAWN_INTENT_TTL_MS - 1);
    expect(reg.get("tok-1")).not.toBeNull(); // still within window
    c.advance(1); // now at TTL
    expect(reg.get("tok-1")).toBeNull(); // swept
    expect(reg.size()).toBe(0);
    // a register after expiry is a clean no-op (never a stale double-deliver)
    expect(reg.resolveOnRegister("tok-1", "sess-late")).toBeNull();
  });

  it("size() counts only live (non-expired) records", () => {
    const c = clock();
    const reg = createPendingSpawnIntentRegistry({ now: c.now });
    reg.record(intent({ spawnToken: "t1" }));
    reg.record(intent({ spawnToken: "t2" }));
    expect(reg.size()).toBe(2);
    c.advance(PENDING_SPAWN_INTENT_TTL_MS);
    expect(reg.size()).toBe(0);
  });

  it("expresses all three flavors on the record", () => {
    const reg = createPendingSpawnIntentRegistry();
    reg.record(intent({ spawnToken: "n", flavor: "new" }));
    reg.record(intent({ spawnToken: "c", flavor: "context-rotation" }));
    reg.record(intent({ spawnToken: "r", flavor: "crash-respawn" }));
    expect(reg.get("n")).toMatchObject({ flavor: "new" });
    expect(reg.get("c")).toMatchObject({ flavor: "context-rotation" });
    expect(reg.get("r")).toMatchObject({ flavor: "crash-respawn" });
  });
});
