import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { usePromptRenderedAck } from "../usePromptRenderedAck.js";
import {
  resendAllRenderedAcks,
  mountedPendingCount,
  isRenderedAckRegistered,
  __resetRenderedAckRegistry,
} from "../../lib/prompt-rendered-ack.js";

afterEach(() => { cleanup(); __resetRenderedAckRegistry(); });

// Pete dl-r4 C1-v2: the ACK must survive a REAL WS reconnect, where the card
// stays MOUNTED (event-reducer.addInteractiveRequest dedups the replayed
// same-requestId prompt → same state → NO remount). The fix is a bounded
// registry of mounted-pending promptIds + a resend driven by the App-level WS
// reconnect handler (resendAllRenderedAcks). A mount-scoped ref alone (round-3)
// never re-fires because there is no remount.

function Dialog({ requestId, onRendered, status }: {
  requestId: string;
  onRendered?: (id: string) => void;
  status?: "pending" | "resolved" | "cancelled" | "dismissed";
}) {
  usePromptRenderedAck(requestId, onRendered, status);
  return <div data-testid="dialog">{requestId}</div>;
}

describe("usePromptRenderedAck — resend-on-reconnect (C1-v2)", () => {
  it("a REAL mount fires the ACK once + registers the pending prompt", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="p1" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(onRendered).toHaveBeenCalledWith("p1");
    expect(isRenderedAckRegistered("p1")).toBe(true);
  });

  it("[able-to-fail] a component that NEVER mounts fires ZERO ACK and registers nothing", () => {
    const onRendered = vi.fn();
    render(<div data-testid="no-dialog">renderer did not mount the picker</div>);
    expect(onRendered).not.toHaveBeenCalled();
    expect(mountedPendingCount()).toBe(0);
  });

  // ── C1-v2 CORE: the REAL reconnect path — card stays MOUNTED, reconnect
  //    handler RESENDS. This is the case the round-3 mount-ref could not handle. ──
  it("[C1-v2 able-to-fail] drop-first-ACK → WS reconnect (SAME card stays mounted) → RESEND recovers delivered", () => {
    // Transport model: the first ACK send drops (socket was down —
    // useWebSocket.send silently drops when not OPEN); a later send reaches the
    // server. `delivered` = the server ever received an ACK (markRendered).
    let delivered = false;
    let dropNext = true;
    const onRendered = vi.fn((_id: string) => {
      if (dropNext) { dropNext = false; return; } // dropped during the outage
      delivered = true; // reached server → markRendered
    });

    // Mount the card ONCE and NEVER unmount it (the real reconnect keeps the
    // deduped card mounted — no remount).
    render(<Dialog requestId="pR" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1); // initial send…
    expect(delivered).toBe(false);               // …but it dropped
    expect(isRenderedAckRegistered("pR")).toBe(true);

    // WS reconnects → the App-level handler calls resendAllRenderedAcks(). The
    // SAME mounted card's registered callback re-sends — NO remount occurred.
    resendAllRenderedAcks();
    expect(onRendered).toHaveBeenCalledTimes(2); // resent
    expect(delivered).toBe(true);                // GREEN — recovered

    // Round-3 (mount-scoped ref only, no registry/resend) stays delivered=false
    // here forever because the card never remounts — this test is RED on it.
  });

  it("[C1-v2] a resend for a still-mounted pending prompt is a duplicate the server absorbs (idempotent, no double-effect)", () => {
    let marks = 0;
    const onRendered = vi.fn(() => { marks++; }); // each send = a markRendered call (idempotent server-side)
    render(<Dialog requestId="pD" onRendered={onRendered} />);
    expect(marks).toBe(1);
    resendAllRenderedAcks(); // reconnect #1
    resendAllRenderedAcks(); // reconnect #2
    // The client re-sends (at-least-once); the SERVER dedups. Here we assert the
    // client resends each reconnect — server idempotency (markRendered) makes it safe.
    expect(marks).toBe(3);
  });

  it("[C1-v2] UNMOUNT removes the prompt from the registry (no leak, no resend after unmount)", () => {
    const onRendered = vi.fn();
    const { unmount } = render(<Dialog requestId="pU" onRendered={onRendered} />);
    expect(isRenderedAckRegistered("pU")).toBe(true);
    unmount();
    expect(isRenderedAckRegistered("pU")).toBe(false);
    expect(mountedPendingCount()).toBe(0);
    resendAllRenderedAcks();
    expect(onRendered).toHaveBeenCalledTimes(1); // only the initial mount send; no post-unmount resend
  });

  it("[C1-v2] RESOLVE removes the prompt from the registry (a reconnect never resends a decided prompt)", () => {
    const onRendered = vi.fn();
    const { rerender } = render(<Dialog requestId="pS" onRendered={onRendered} status="pending" />);
    expect(isRenderedAckRegistered("pS")).toBe(true);
    expect(onRendered).toHaveBeenCalledTimes(1);
    // The prompt is answered → status leaves "pending". The card may stay
    // mounted (showing the resolved row), but it must be OUT of the registry.
    rerender(<Dialog requestId="pS" onRendered={onRendered} status="resolved" />);
    expect(isRenderedAckRegistered("pS")).toBe(false);
    resendAllRenderedAcks();
    expect(onRendered).toHaveBeenCalledTimes(1); // no resend after resolve
  });

  it("two DISTINCT pending prompts both register + both resend on reconnect", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="a" onRendered={onRendered} />);
    render(<Dialog requestId="b" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(2);
    expect(mountedPendingCount()).toBe(2);
    resendAllRenderedAcks();
    expect(onRendered).toHaveBeenCalledTimes(4); // both resent
  });

  it("no onRendered callback → no throw, no registration (defensive)", () => {
    expect(() => render(<Dialog requestId="pN" onRendered={undefined} />)).not.toThrow();
    expect(isRenderedAckRegistered("pN")).toBe(false);
  });
});
