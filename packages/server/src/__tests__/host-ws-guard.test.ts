import { describe, expect, it, vi } from "vitest";
import type { TokenPayload } from "../auth.js";
import { hostWsUpgradeAllowed, createHostWsRegistry, type ClosableSocket } from "../host-ws-guard.js";

const OP = { sub: "op@example.com", username: "op" } as TokenPayload;

// B5 — a revoked principal must not retain / re-open a terminal/editor WS.
describe("host WS upgrade admission (B5)", () => {
  it("denies an operator-role principal who is no longer currently admitted", () => {
    // Still resolves to operator by the STARTUP-frozen operatorUsers role, but
    // was removed from the live allowedUsers roster → upgrade must be denied.
    expect(hostWsUpgradeAllowed({
      principal: OP,
      isOperatorRole: true,
      isAdmitted: false, // revoked
      directLocal: false,
    })).toBe(false);
  });

  it("allows an operator-role principal who is still admitted", () => {
    expect(hostWsUpgradeAllowed({
      principal: OP,
      isOperatorRole: true,
      isAdmitted: true,
      directLocal: false,
    })).toBe(true);
  });

  it("still allows a cookie-less loopback native-tooling caller (direct-local)", () => {
    expect(hostWsUpgradeAllowed({
      principal: null,
      isOperatorRole: false,
      isAdmitted: false,
      directLocal: true,
    })).toBe(true);
  });

  it("denies a non-operator principal even when admitted", () => {
    expect(hostWsUpgradeAllowed({
      principal: { sub: "guest@example.com", username: "guest" } as TokenPayload,
      isOperatorRole: false,
      isAdmitted: true,
      directLocal: false,
    })).toBe(false);
  });
});

describe("host WS revocation registry (B5)", () => {
  function fakeSocket() {
    let closeCb: (() => void) | undefined;
    return {
      destroy: vi.fn(() => closeCb?.()),
      on: vi.fn((event: string, cb: () => void) => { if (event === "close") closeCb = cb; }),
    } satisfies ClosableSocket & { destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  }

  it("closes an existing socket whose principal is revoked, keeping still-admitted ones", () => {
    const reg = createHostWsRegistry();
    const revoked = fakeSocket();
    const kept = fakeSocket();
    reg.register(revoked, { sub: "op@example.com", username: "op" });
    reg.register(kept, { sub: "still@example.com", username: "still" });
    expect(reg.size()).toBe(2);

    const admitted = new Set(["still@example.com"]);
    const closed = reg.closeRevoked((p) => admitted.has(String(p.sub)));

    expect(closed).toBe(1);
    expect(revoked.destroy).toHaveBeenCalledTimes(1);
    expect(kept.destroy).not.toHaveBeenCalled();
    // Revoked entry is dropped; the still-admitted socket remains tracked.
    expect(reg.size()).toBe(1);
  });

  it("auto-untracks a socket that closes on its own", () => {
    const reg = createHostWsRegistry();
    const sock = fakeSocket();
    reg.register(sock, { sub: "op@example.com", username: "op" });
    expect(reg.size()).toBe(1);
    // Simulate the underlying socket closing (client disconnect).
    sock.destroy();
    expect(reg.size()).toBe(0);
  });
});
