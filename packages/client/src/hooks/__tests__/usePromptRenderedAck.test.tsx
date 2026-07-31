import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { usePromptRenderedAck } from "../usePromptRenderedAck.js";

afterEach(() => { cleanup(); });

// Pete dl-13358 B1 + dl-r3 C1: the ACK fires from the ACTUAL dialog-component
// mount (a useEffect, post-DOM-commit). AT-LEAST-ONCE on mount/reconnect: a
// remount RE-SENDS (recovering a dropped first send); the server's idempotent
// markRendered dedups. A component that never mounts fires zero.

function Dialog({ requestId, onRendered }: { requestId: string; onRendered?: (id: string) => void }) {
  usePromptRenderedAck(requestId, onRendered);
  return <div data-testid="dialog">{requestId}</div>;
}

describe("usePromptRenderedAck (B1 mount ACK — at-least-once, C1)", () => {
  it("a REAL mount fires the ACK (post-commit useEffect)", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="p1" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(onRendered).toHaveBeenCalledWith("p1");
  });

  it("[able-to-fail] a component that NEVER mounts fires ZERO ACK (delivered stays false)", () => {
    const onRendered = vi.fn();
    render(<div data-testid="no-dialog">renderer did not mount the picker</div>);
    expect(onRendered).not.toHaveBeenCalled();
  });

  // ── C1 core: at-least-once — REMOUNT re-sends (recovers a dropped first send). ──
  it("[C1 able-to-fail] REMOUNT of the same promptId RE-SENDS the ACK (at-least-once retry)", () => {
    const onRendered = vi.fn();
    const { unmount } = render(<Dialog requestId="p2" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    unmount(); // e.g. session switch / socket disconnect discards the card
    render(<Dialog requestId="p2" onRendered={onRendered} />); // reconnect-replay re-mounts
    // The permanent-Set (exactly-once-forever) code stayed at 1 here (RED — a
    // dropped first send could never recover). At-least-once re-sends → 2.
    expect(onRendered).toHaveBeenCalledTimes(2);
  });

  it("[C1] drop-then-reconnect: a DROPPED first send is recovered on remount (delivered becomes true)", () => {
    // Model the transport: the first ACK send is dropped (send throws / socket
    // gone); the second (remount) reaches the server. `delivered` tracks whether
    // the server ever received an ACK.
    let deliveredToServer = false;
    let dropNext = true; // first send is dropped
    const onRendered = vi.fn((_id: string) => {
      if (dropNext) { dropNext = false; return; } // dropped in transit
      deliveredToServer = true; // reached server → markRendered
    });
    const { unmount } = render(<Dialog requestId="p3" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(deliveredToServer).toBe(false); // first send dropped
    unmount();
    render(<Dialog requestId="p3" onRendered={onRendered} />); // reconnect remount
    expect(onRendered).toHaveBeenCalledTimes(2); // retried
    expect(deliveredToServer).toBe(true); // GREEN — recovered (pre-fix: false forever)
  });

  it("two DISTINCT promptIds each fire on mount", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="a" onRendered={onRendered} />);
    render(<Dialog requestId="b" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(2);
    expect(onRendered).toHaveBeenCalledWith("a");
    expect(onRendered).toHaveBeenCalledWith("b");
  });

  it("no onRendered callback → no throw (defensive)", () => {
    expect(() => render(<Dialog requestId="p4" onRendered={undefined} />)).not.toThrow();
  });
});
