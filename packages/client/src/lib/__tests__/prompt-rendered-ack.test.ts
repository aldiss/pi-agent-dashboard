import { describe, it, expect, vi, afterEach } from "vitest";
import {
  registerRenderedAck,
  unregisterRenderedAck,
  resendAllRenderedAcks,
  mountedPendingCount,
  isRenderedAckRegistered,
  __resetRenderedAckRegistry,
} from "../prompt-rendered-ack.js";

afterEach(() => __resetRenderedAckRegistry());

// Pete dl-r4 C1-v2: a BOUNDED registry of currently-mounted PENDING promptIds.
// Add on mount, remove on unmount/resolve, resend-all on WS reconnect. Server
// markRendered is idempotent so resends are safe.

describe("prompt-rendered-ack registry (C1-v2)", () => {
  it("register adds a mounted-pending id; resendAll invokes its callback", () => {
    const cb = vi.fn();
    registerRenderedAck("p1", cb);
    expect(isRenderedAckRegistered("p1")).toBe(true);
    expect(mountedPendingCount()).toBe(1);
    resendAllRenderedAcks();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("[able-to-fail] resendAll re-invokes on EVERY reconnect (at-least-once)", () => {
    const cb = vi.fn();
    registerRenderedAck("p1", cb);
    resendAllRenderedAcks(); // reconnect 1
    resendAllRenderedAcks(); // reconnect 2
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unregister removes the id — resendAll no longer invokes it (no leak, no post-remove resend)", () => {
    const cb = vi.fn();
    registerRenderedAck("p1", cb);
    unregisterRenderedAck("p1");
    expect(isRenderedAckRegistered("p1")).toBe(false);
    expect(mountedPendingCount()).toBe(0);
    resendAllRenderedAcks();
    expect(cb).not.toHaveBeenCalled();
  });

  it("resendAll fires every registered id (bounded by concurrently-visible prompts)", () => {
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    registerRenderedAck("a", a);
    registerRenderedAck("b", b);
    registerRenderedAck("c", c);
    expect(mountedPendingCount()).toBe(3);
    resendAllRenderedAcks();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("re-register replaces the callback (idempotent per id — no duplicate entry)", () => {
    const first = vi.fn(), second = vi.fn();
    registerRenderedAck("p1", first);
    registerRenderedAck("p1", second); // e.g. effect re-run
    expect(mountedPendingCount()).toBe(1);
    resendAllRenderedAcks();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("empty promptId is not registered (guard)", () => {
    registerRenderedAck("", vi.fn());
    expect(mountedPendingCount()).toBe(0);
  });

  it("a throwing resend callback does not block the others", () => {
    const good = vi.fn();
    registerRenderedAck("bad", () => { throw new Error("boom"); });
    registerRenderedAck("good", good);
    expect(() => resendAllRenderedAcks()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
