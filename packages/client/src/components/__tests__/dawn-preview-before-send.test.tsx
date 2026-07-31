/**
 * Dawn PREVIEW-BEFORE-SEND flow.
 *
 * Operator amendment: the recorder must show the transcribed words locally,
 * editable, and spool ONLY on a normal Send — using the final edited text plus
 * the pending audio — sending only the .json entry path downstream. This suite
 * drives the ONE parent-owned submit (CommandInput passes it to MobileComposer
 * as onSend, and uses it for its own send), so both surfaces are exercised
 * through the same mechanism.
 *
 * A minimal MediaRecorder stub makes the pending-audio path reachable in jsdom;
 * fetch is stubbed to stand in for the /spool endpoint.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";

let mobileProps: Record<string, unknown> | null = null;
let pttProps: Record<string, unknown> | null = null;

vi.mock("../../utils/platform.js", () => ({
  shouldUseMobileComposer: vi.fn(() => true),
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

// Minimal MediaRecorder: on stop() it emits one data chunk then fires onstop,
// which is exactly what the parent's Dawn audio capture consumes.
class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function stubSpoolFetch(entryPath = "/spool/vi-probe.json") {
  const fetchSpy = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, entryPath }),
    } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function spoolCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/api/plugins/voice-input/spool"));
}

function renderDawn(onSend: (t: string, i?: unknown) => void, sessionName = "Dawn") {
  return render(
    <CommandInput
      commands={[]}
      onSend={onSend as (t: string) => void}
      sessionId="sess-dawn"
      sessionName={sessionName}
      draft=""
      onDraftChange={() => {}}
    />,
  );
}

// Drive record → stop → transcript, leaving a pending dictation with real audio.
async function stageDictation(transcript = "buy milk") {
  const onDawnStreamChange = mobileProps?.onDawnStreamChange as (s: unknown) => void;
  const onVoiceTranscript = mobileProps?.onVoiceTranscript as (t: string) => void;
  await act(async () => {
    onDawnStreamChange({} as MediaStream); // recording starts → recorder.start()
    onDawnStreamChange(null); // recording stops → audio blob resolves
    onVoiceTranscript(transcript); // ASR result → preview shown, pending marked
  });
}

afterEach(() => {
  cleanup();
  mobileProps = null;
  pttProps = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Dawn preview-before-Send — transcript is shown, NOTHING spools before Send", () => {
  it("shows the raw transcript and makes ZERO /spool call at transcript time", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = stubSpoolFetch();
    const onDraftChange = vi.fn();
    render(
      <CommandInput commands={[]} onSend={() => {}} sessionId="sess-dawn" sessionName="Dawn"
        draft="" onDraftChange={onDraftChange} />,
    );
    await stageDictation("hello there");
    // Raw transcript shown locally...
    expect(onDraftChange).toHaveBeenCalledWith("hello there");
    // ...and NOTHING spooled yet.
    expect(spoolCalls(fetchSpy)).toEqual([]);
  });

  it("blocks a new recording (fail-closed mic) while a dictation is pending", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubSpoolFetch();
    mockedShouldUseMobile.mockReturnValue(true);
    renderDawn(() => {});
    expect(mobileProps?.micBlocked).toBe(false);
    await stageDictation();
    expect(mobileProps?.micBlocked).toBe(true);
  });
});

describe("Dawn Send — spools exactly once with FINAL text, path-only outbound", () => {
  it("spools the final EDITED text + pending audio once, and sends only the entry path", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = stubSpoolFetch("/spool/vi-final.json");
    const appOnSend = vi.fn();
    renderDawn(appOnSend);
    await stageDictation("buy milk");

    let sent: unknown;
    const submit = mobileProps?.onSend as (t: string) => Promise<boolean>;
    await act(async () => {
      sent = await submit("buy oat milk"); // operator edited the transcript before Send
    });

    // Exactly one spool call.
    const calls = spoolCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    // Spooled the FINAL edited text, not the original.
    const body = String((calls[0]?.[1] as { body?: unknown })?.body ?? "");
    expect(body).toContain("buy oat milk");
    expect(body).not.toContain("\"transcript\":\"buy milk\"");
    // Path-only outbound: downstream got the entry path, never the transcript.
    expect(appOnSend).toHaveBeenCalledTimes(1);
    expect(appOnSend).toHaveBeenCalledWith("process this dictation entry: /spool/vi-final.json", undefined);
    expect(sent).toBe(true);
    // Mic unblocked again after a successful send.
    expect(mobileProps?.micBlocked).toBe(false);
  });

  it("spools EXACTLY ONCE under a double/concurrent Send", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = stubSpoolFetch();
    const appOnSend = vi.fn();
    renderDawn(appOnSend);
    await stageDictation("buy milk");

    const submit = mobileProps?.onSend as (t: string) => Promise<boolean>;
    let r1: unknown, r2: unknown;
    await act(async () => {
      const p1 = submit("buy milk");
      const p2 = submit("buy milk"); // fired before the first resolves
      [r1, r2] = await Promise.all([p1, p2]);
    });
    expect(spoolCalls(fetchSpy)).toHaveLength(1);
    expect(appOnSend).toHaveBeenCalledTimes(1);
    // Exactly one of the two submits reports "sent".
    expect([r1, r2].filter((x) => x === true)).toHaveLength(1);
  });
});

describe("Dawn Send failure — preserves everything, sends nothing", () => {
  it("returns not-sent and calls no downstream onSend when the spool fails", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const appOnSend = vi.fn();
    renderDawn(appOnSend);
    await stageDictation("buy milk");

    let sent: unknown;
    const submit = mobileProps?.onSend as (t: string) => Promise<boolean>;
    await act(async () => {
      sent = await submit("buy milk");
    });
    expect(sent).toBe(false); // caller must NOT clear
    expect(appOnSend).not.toHaveBeenCalled(); // nothing sent, no raw fallback
    // Still pending → mic still blocked → the operator can retry Send.
    expect(mobileProps?.micBlocked).toBe(true);
  });
});

describe("Dawn pending is cleared safely on explicit-clear and session switch", () => {
  it("clears pending (and unblocks mic) when the composer is emptied", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubSpoolFetch();
    const { rerender } = render(
      <CommandInput commands={[]} onSend={() => {}} sessionId="sess-dawn" sessionName="Dawn"
        draft="hello" onDraftChange={() => {}} />,
    );
    await stageDictation("hello");
    expect(mobileProps?.micBlocked).toBe(true);
    await act(async () => {
      rerender(
        <CommandInput commands={[]} onSend={() => {}} sessionId="sess-dawn" sessionName="Dawn"
          draft="" onDraftChange={() => {}} />,
      );
    });
    expect(mobileProps?.micBlocked).toBe(false);
  });

  it("clears pending (and unblocks mic) on session switch", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubSpoolFetch();
    const { rerender } = render(
      <CommandInput commands={[]} onSend={() => {}} sessionId="sess-a" sessionName="Dawn"
        draft="hi" onDraftChange={() => {}} />,
    );
    await stageDictation("hi");
    expect(mobileProps?.micBlocked).toBe(true);
    await act(async () => {
      rerender(
        <CommandInput commands={[]} onSend={() => {}} sessionId="sess-b" sessionName="Dawn"
          draft="hi" onDraftChange={() => {}} />,
      );
    });
    expect(mobileProps?.micBlocked).toBe(false);
  });
});

describe("Non-Dawn is unchanged", () => {
  it("a non-Dawn pane never spools and sends the raw text", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = stubSpoolFetch();
    const appOnSend = vi.fn();
    renderDawn(appOnSend, "Peggy");
    const onVoiceTranscript = mobileProps?.onVoiceTranscript as (t: string) => void;
    await act(async () => {
      onVoiceTranscript("just text");
    });
    expect(mobileProps?.onDawnStreamChange).toBeUndefined();
    expect(mobileProps?.micBlocked).toBe(false);
    const submit = mobileProps?.onSend as (t: string) => Promise<boolean>;
    let sent: unknown;
    await act(async () => {
      sent = await submit("just text");
    });
    expect(spoolCalls(fetchSpy)).toEqual([]);
    expect(appOnSend).toHaveBeenCalledWith("just text", undefined);
    expect(sent).toBe(true);
  });
});

describe("Desktop parity — the same mic-block applies to the desktop button", () => {
  it("disables the desktop PushToTalkButton while a Dawn dictation is pending", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    stubSpoolFetch();
    mockedShouldUseMobile.mockReturnValue(false); // desktop
    render(
      <CommandInput commands={[]} onSend={() => {}} sessionId="sess-dawn" sessionName="Dawn"
        draft="" onDraftChange={() => {}} />,
    );
    expect(pttProps?.disabled).toBe(false);
    const onDawnStreamChange = pttProps?.onStreamChange as (s: unknown) => void;
    const onTranscript = pttProps?.onTranscript as (t: string) => void;
    await act(async () => {
      onDawnStreamChange({} as MediaStream);
      onDawnStreamChange(null);
      onTranscript("desktop dictation");
    });
    expect(pttProps?.disabled).toBe(true);
  });
});

describe("Dawn Send failure surfaces a READABLE error on both surfaces (dl-13343)", () => {
  it("passes dawnSendError=true to the mobile composer on failure, and clears it on a new dictation", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    mockedShouldUseMobile.mockReturnValue(true);
    renderDawn(() => {});
    await stageDictation("buy milk");
    expect(mobileProps?.dawnSendError).toBe(false);
    const submit = mobileProps?.onSend as (t: string) => Promise<boolean>;
    await act(async () => { await submit("buy milk"); });
    // Readable error is surfaced to the composer...
    expect(mobileProps?.dawnSendError).toBe(true);
    // ...and clears when the operator records again.
    await stageDictation("second try");
    expect(mobileProps?.dawnSendError).toBe(false);
  });

  it("renders a readable desktop error banner on failure and removes it on a new dictation", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    mockedShouldUseMobile.mockReturnValue(false); // desktop
    // Uncontrolled draft so the appended transcript actually populates local
    // state and enables the send button.
    const { queryByTestId, getByTestId } = render(
      <CommandInput commands={[]} onSend={() => {}} sessionId="sess-dawn" sessionName="Dawn" />,
    );
    const onDawnStreamChange = pttProps?.onStreamChange as (s: unknown) => void;
    const onTranscript = pttProps?.onTranscript as (t: string) => void;
    await act(async () => {
      onDawnStreamChange({} as MediaStream);
      onDawnStreamChange(null);
      onTranscript("desktop dictation");
    });
    expect(queryByTestId("dawn-send-error")).toBeNull();
    await act(async () => { fireEvent.click(getByTestId("send-button")); });
    await waitFor(() => expect(queryByTestId("dawn-send-error")).not.toBeNull());
    // A new recording clears the error.
    await act(async () => {
      onDawnStreamChange({} as MediaStream);
      onDawnStreamChange(null);
      onTranscript("retry dictation");
    });
    expect(queryByTestId("dawn-send-error")).toBeNull();
  });
});
