/**
 * Voice control M1 + M2 (CLIENT), redesigned to run in a plain git-archive
 * checkout: imports the REAL in-repo component by relative path, asserts what it
 * actually renders (GREEN), and proves able-to-fail against an in-repo legacy
 * fixture (RED). No aliases, no orchestration-state paths, no external codebase.
 *
 * M1 — an automatic/partial termination is distinguishable, on a touch device,
 *      from an ordinary error, by rendered words + glyph + colour (not hover).
 * M2 — a tiny automatic stop reads reason-first ("too brief to transcribe"),
 *      persists until acknowledged, and never blames the operator.
 *
 * The able-to-fail halves render the legacy fixture (pre-fix contract: interrupted
 * looks identical to a red error, zero rendered words, error auto-clears) and
 * assert the SAME discriminators the real component passes now FAIL — proving the
 * control discriminates rather than rubber-stamping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { PushToTalkButton } from "../client/PushToTalkButton.js";
import { LegacyPushToTalkButton } from "./__fixtures__/legacy-behaviours.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

class ControlMediaRecorder {
  static blobSize = 1500;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream) {}
  start(): void { this.state = "recording"; }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(ControlMediaRecorder.blobSize)], { type: this.mimeType }),
    });
    this.onstop?.();
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
let visibilityState: DocumentVisibilityState = "visible";
let transcribeMode: "ok" | "error" = "ok";
let requestUrls: string[] = [];
let originalVisibility: PropertyDescriptor | undefined;
let originalCrypto: Crypto;

async function drain(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}
async function startRecording(): Promise<HTMLElement> {
  const button = screen.getByTestId("push-to-talk");
  await act(async () => { fireEvent.click(button); await drain(); });
  expect(button.getAttribute("data-phase")).toBe("recording");
  return button;
}
async function visibilityStop(): Promise<void> {
  await act(async () => {
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await drain();
  });
}
function iconPath(): string {
  return screen.getByTestId("ptt-icon").querySelector("path")?.getAttribute("d") ?? "<absent>";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  visibilityState = "visible";
  transcribeMode = "ok";
  requestUrls = [];
  ControlMediaRecorder.blobSize = 1500;
  // @ts-expect-error jsdom has no MediaRecorder.
  globalThis.MediaRecorder = ControlMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
  originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: vi.fn(() => REQUEST_ID) },
  });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestUrls.push(url);
    if (url.includes("/health")) return new Response("{}", { status: 200 });
    if (url.includes("/telemetry")) return new Response(null, { status: 204 });
    if (transcribeMode === "error") {
      return new Response(JSON.stringify({ error: "forced" }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ transcript: "synthetic-nonempty" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
});

describe("voice control M1 — interrupted is touch-distinguishable from error", () => {
  it("GREEN: real component differs by rendered words, glyph, and colour", async () => {
    render(
      <>
        <span data-testid="render-probe">known-positive rendered probe</span>
        <PushToTalkButton onTranscript={vi.fn()} />
      </>,
    );
    const probe = screen.getByTestId("render-probe").textContent;
    const interruptedButton = await startRecording();
    await visibilityStop();
    const interrupted = {
      phase: interruptedButton.getAttribute("data-phase"),
      colour: interruptedButton.style.color,
      glyph: iconPath(),
      renderedText: screen.queryByTestId("ptt-interrupted-message")?.textContent ?? "<absent>",
      transcribeCalls: requestUrls.filter((u) => u.includes("/transcribe")).length,
    };

    cleanup();
    visibilityState = "visible";
    requestUrls = [];
    transcribeMode = "error";
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const errorButton = await startRecording();
    await act(async () => { fireEvent.click(errorButton); await drain(); });
    const error = {
      phase: errorButton.getAttribute("data-phase"),
      colour: errorButton.style.color,
      glyph: iconPath(),
    };

    console.log(`CONTROL M1 GREEN ${JSON.stringify({ probe, interrupted, error })}`);

    expect(probe).toBe("known-positive rendered probe");            // known-positive
    expect(interrupted.phase).toBe("interrupted");
    expect(interrupted.renderedText).toContain("Recording interrupted");
    expect(interrupted.renderedText).toContain("app went into background");
    expect(interrupted.colour).not.toBe(error.colour);
    expect(interrupted.glyph).not.toBe(error.glyph);
    expect(interrupted.transcribeCalls).toBe(1);
  });

  it("ABLE-TO-FAIL: the same discriminators FAIL on the pre-fix legacy fixture", () => {
    // Pre-fix: an auto-truncated stop had nowhere to go but `error`; it rendered
    // the SAME red alert-circle as a plain error, with zero rendered words.
    render(<LegacyPushToTalkButton driveTo="error" autoStopTruncated />);
    const legacyInterrupted = {
      phase: screen.getByTestId("push-to-talk").getAttribute("data-phase"),
      colour: screen.getByTestId("push-to-talk").style.color,
      glyph: iconPath(),
      renderedText: screen.queryByTestId("ptt-interrupted-message")?.textContent ?? "<absent>",
    };
    cleanup();
    render(<LegacyPushToTalkButton driveTo="error" />);
    const legacyError = {
      colour: screen.getByTestId("push-to-talk").style.color,
      glyph: iconPath(),
    };
    console.log(`CONTROL M1 RED(legacy) ${JSON.stringify({ legacyInterrupted, legacyError })}`);

    // Prove the control WOULD catch the defect: on the legacy contract the
    // interrupted rendering is NOT distinguishable and carries no words.
    expect(legacyInterrupted.phase).not.toBe("interrupted");         // no interrupted phase existed
    expect(legacyInterrupted.renderedText).toBe("<absent>");         // no rendered words
    expect(legacyInterrupted.colour).toBe(legacyError.colour);       // same colour as error
    expect(legacyInterrupted.glyph).toBe(legacyError.glyph);         // same glyph as error
  });
});

describe("voice control M2 — reason-first tiny auto-stop, persistent", () => {
  it("GREEN: real component is interrupted / too-brief and persists past the error timer", async () => {
    ControlMediaRecorder.blobSize = 256;
    render(
      <>
        <span data-testid="render-probe">known-positive rendered probe</span>
        <PushToTalkButton onTranscript={vi.fn()} />
      </>,
    );
    const probe = screen.getByTestId("render-probe").textContent;
    const button = await startRecording();
    await visibilityStop();
    const beforeTimer = {
      phase: button.getAttribute("data-phase"),
      detail: button.getAttribute("data-interruption-detail"),
      title: button.getAttribute("title"),
      renderedText: screen.queryByTestId("ptt-interrupted-message")?.textContent ?? "<absent>",
      transcribeCalls: requestUrls.filter((u) => u.includes("/transcribe")).length,
    };
    await act(async () => { vi.advanceTimersByTime(60_000); await drain(); });
    const afterTimerPhase = button.getAttribute("data-phase");

    console.log(`CONTROL M2 GREEN ${JSON.stringify({ probe, beforeTimer, afterTimerPhase })}`);

    expect(probe).toBe("known-positive rendered probe");
    expect(beforeTimer.phase).toBe("interrupted");
    expect(beforeTimer.detail).toBe("too-brief-to-transcribe");
    expect(beforeTimer.title).not.toContain("Recording too short");
    expect(beforeTimer.renderedText).toContain("too brief to transcribe");
    expect(beforeTimer.transcribeCalls).toBe(0);
    expect(afterTimerPhase).toBe("interrupted");                     // persists, no auto-clear
  });

  it("ABLE-TO-FAIL: the pre-fix legacy fixture blames the operator and auto-clears", () => {
    render(<LegacyPushToTalkButton driveTo="error" autoStopTruncated />);
    const button = screen.getByTestId("push-to-talk");
    const before = {
      phase: button.getAttribute("data-phase"),
      title: button.getAttribute("title"),
      renderedText: screen.queryByTestId("ptt-interrupted-message")?.textContent ?? "<absent>",
    };
    // Pre-fix `error` auto-clears to idle after 6s.
    act(() => { vi.advanceTimersByTime(6000); });
    const afterPhase = button.getAttribute("data-phase");
    console.log(`CONTROL M2 RED(legacy) ${JSON.stringify({ before, afterPhase })}`);

    expect(before.phase).toBe("error");                              // not interrupted
    expect(before.title).toContain("Recording too short");           // operator-blaming
    expect(before.renderedText).toBe("<absent>");                    // no reason on screen
    expect(afterPhase).toBe("idle");                                 // self-erased
  });
});
