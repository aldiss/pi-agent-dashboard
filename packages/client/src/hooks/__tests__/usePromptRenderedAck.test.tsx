import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { usePromptRenderedAck } from "../usePromptRenderedAck.js";
import { __resetPromptRenderedAckLedger } from "../../lib/prompt-rendered-ack.js";

afterEach(() => { cleanup(); __resetPromptRenderedAckLedger(); });

// Pete dl-13358 B1: the ACK fires from the ACTUAL dialog-component mount
// (a useEffect, post-DOM-commit), exactly once per promptId — NOT at
// message-received / state-enqueue time. A component that never mounts fires
// zero; remount/reconnect fires no duplicate.

function Dialog({ requestId, onRendered }: { requestId: string; onRendered?: (id: string) => void }) {
  usePromptRenderedAck(requestId, onRendered);
  return <div data-testid="dialog">{requestId}</div>;
}

describe("usePromptRenderedAck (B1 mount ACK)", () => {
  it("a REAL mount fires exactly one ACK (post-commit useEffect)", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="p1" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(onRendered).toHaveBeenCalledWith("p1");
  });

  it("[able-to-fail] a component that NEVER mounts fires ZERO ACK (delivered stays false)", () => {
    const onRendered = vi.fn();
    // Render a tree that does NOT include the Dialog (renderer failed / hidden branch).
    render(<div data-testid="no-dialog">renderer did not mount the picker</div>);
    expect(onRendered).not.toHaveBeenCalled();
  });

  it("REMOUNT of the same promptId fires NO duplicate ACK (idempotent ledger)", () => {
    const onRendered = vi.fn();
    const { unmount } = render(<Dialog requestId="p2" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(1);
    unmount(); // e.g. session switch
    render(<Dialog requestId="p2" onRendered={onRendered} />); // reconnect-replay re-mounts
    expect(onRendered).toHaveBeenCalledTimes(1); // still ONE — no false dup
  });

  it("two DISTINCT promptIds each fire once", () => {
    const onRendered = vi.fn();
    render(<Dialog requestId="a" onRendered={onRendered} />);
    render(<Dialog requestId="b" onRendered={onRendered} />);
    expect(onRendered).toHaveBeenCalledTimes(2);
    expect(onRendered).toHaveBeenCalledWith("a");
    expect(onRendered).toHaveBeenCalledWith("b");
  });

  it("no onRendered callback → no throw (defensive)", () => {
    expect(() => render(<Dialog requestId="p3" onRendered={undefined} />)).not.toThrow();
  });
});
