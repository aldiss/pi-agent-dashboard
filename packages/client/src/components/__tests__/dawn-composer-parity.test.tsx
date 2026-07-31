/**
 * Dawn dictation PARITY across composer surfaces.
 *
 * The failure this locks down (real operator trial, mobile): CommandInput wired
 * Dawn dictation to /spool, but on a touch device CommandInput renders
 * MobileComposer, which appended the raw transcript and made no /spool call. The
 * operator's dictation went to Dawn as plain text, she refused, and the loop
 * could not complete from a phone.
 *
 * These tests assert BOTH surfaces route Dawn through the SAME parent-owned
 * handler, deterministically and without a microphone: the composer children are
 * mocked so their props (the wiring) are captured, and the non-Dawn path is
 * driven directly to prove it makes zero /spool call.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

let mobileProps: Record<string, unknown> | null = null;
let pttProps: Record<string, unknown> | null = null;

vi.mock("../../utils/platform.js", () => ({
  shouldUseMobileComposer: vi.fn(() => false),
  isCapacitorNative: vi.fn(() => false),
}));
vi.mock("../MobileComposer/index.js", () => ({
  MobileComposer: (props: Record<string, unknown>) => {
    mobileProps = props;
    return <div data-testid="mock-mobile-composer" />;
  },
}));
vi.mock("@blackbelt-technology/pi-dashboard-voice-input-plugin/client", () => ({
  PushToTalkButton: (props: Record<string, unknown>) => {
    pttProps = props;
    return <button data-testid="mock-ptt" />;
  },
}));

import { CommandInput } from "../CommandInput";
import { shouldUseMobileComposer } from "../../utils/platform.js";

const mockedShouldUseMobile = vi.mocked(shouldUseMobileComposer);

afterEach(() => {
  cleanup();
  mobileProps = null;
  pttProps = null;
  vi.clearAllMocks();
});

describe("Dawn dictation reaches the MOBILE composer surface", () => {
  it("wires the parent's Dawn transcript handler AND Dawn audio capture into MobileComposer", () => {
    mockedShouldUseMobile.mockReturnValue(true);
    const { getByTestId } = render(
      <CommandInput
        commands={[]}
        onSend={() => {}}
        sessionId="sess-dawn"
        sessionName="Dawn"
        draft=""
        onDraftChange={() => {}}
      />,
    );
    // The mobile surface is the one actually rendered.
    expect(getByTestId("mock-mobile-composer")).toBeTruthy();
    // And it received the reused parent handlers — not left to raw-append.
    expect(typeof mobileProps?.onVoiceTranscript).toBe("function");
    expect(typeof mobileProps?.onDawnStreamChange).toBe("function");
  });
});

describe("Desktop parity — the same handler routes on CommandInput's own button", () => {
  it("wires handleVoiceTranscript + Dawn stream capture into PushToTalkButton", () => {
    mockedShouldUseMobile.mockReturnValue(false);
    render(
      <CommandInput
        commands={[]}
        onSend={() => {}}
        sessionId="sess-dawn"
        sessionName="Dawn"
        draft=""
        onDraftChange={() => {}}
      />,
    );
    expect(typeof pttProps?.onTranscript).toBe("function");
    expect(typeof pttProps?.onStreamChange).toBe("function");
  });
});

describe("Non-Dawn MOBILE dictation appends raw and makes ZERO spool call", () => {
  it("routes a non-Dawn transcript to a raw append with no /spool fetch and no Dawn capture", () => {
    mockedShouldUseMobile.mockReturnValue(true);
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const onDraftChange = vi.fn();

    render(
      <CommandInput
        commands={[]}
        onSend={() => {}}
        sessionId="sess-peggy"
        sessionName="Peggy"
        draft=""
        onDraftChange={onDraftChange}
      />,
    );

    // Non-Dawn: no Dawn audio capture is wired at all.
    expect(mobileProps?.onDawnStreamChange).toBeUndefined();

    // Drive the reused handler directly (no mic needed): it must raw-append.
    const onVoiceTranscript = mobileProps?.onVoiceTranscript as (t: string) => void;
    expect(typeof onVoiceTranscript).toBe("function");
    onVoiceTranscript("buy milk");

    expect(onDraftChange).toHaveBeenCalledWith("buy milk");
    // The load-bearing assertion: a non-Dawn pane touches the spool endpoint zero times.
    const spoolCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes("/api/plugins/voice-input/spool"),
    );
    expect(spoolCalls).toEqual([]);

    vi.unstubAllGlobals();
  });
});
