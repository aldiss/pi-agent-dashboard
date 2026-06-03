/**
 * PushToTalkButton click-to-toggle behavior tests.
 *
 * Covers (per voice-input-ux-option-b execution brief 2026-05-14, gate G3):
 *   - idle  --click--> recording state transition
 *   - recording  --click--> uploading state transition
 *   - 10min safety-net auto-stops recording when no second click arrives
 *   - aria-pressed reflects state correctly (false in idle, true in recording)
 *   - title / aria-label updates per phase
 *
 * Operator-direct ratification 2026-05-14 ~12:55 CEST: Option B
 * (click-to-toggle) replaces press-and-hold. Risk #12 10min safety-net
 * preserved (and arguably more important now — a forgotten second click
 * would otherwise leave the mic hot indefinitely).
 *
 * jsdom does not implement MediaRecorder or navigator.mediaDevices.getUserMedia,
 * so both are mocked. The mock MediaRecorder synchronously emits a 1500-byte
 * data chunk on stop() so the upload-path crosses the >1KB short-recording
 * guard without depending on real audio bytes.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { PushToTalkButton } from "../client/PushToTalkButton.js";

// ── MediaRecorder mock ────────────────────────────────────────────────────────

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(_stream: MediaStream) {
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    // Emit a synthetic 1500-byte chunk so the >1KB short-recording guard
    // in PushToTalkButton allows the upload path to proceed.
    const blob = new Blob([new Uint8Array(1500)], { type: "audio/webm" });
    const dataEvent = { data: blob };
    this.ondataavailable?.(dataEvent);
    for (const cb of this.listeners["dataavailable"] ?? []) cb(dataEvent);
    this.onstop?.();
    for (const cb of this.listeners["stop"] ?? []) cb({});
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter(c => c !== cb);
  }
}

// ── getUserMedia mock ─────────────────────────────────────────────────────────

const fakeStream: MediaStream = {
  getTracks: () => [{ stop: () => undefined }],
} as unknown as MediaStream;

// ── fetch mock ────────────────────────────────────────────────────────────────

function buildOkFetch(transcript: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ sidecarHealthy: true, respawnCount: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ transcript, engine_used: "test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockMediaRecorder.instances = [];
  // @ts-expect-error jsdom does not provide MediaRecorder
  globalThis.MediaRecorder = MockMediaRecorder;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  globalThis.fetch = buildOkFetch("hello world") as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("PushToTalkButton — click-to-toggle (Option B, 2026-05-14)", () => {
  it("idle aria-pressed is false and title carries click-language by default", () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("data-phase")).toBe("idle");
    const title = button.getAttribute("title") ?? "";
    expect(title.toLowerCase()).toContain("click");
    expect(title.toLowerCase()).not.toContain("hold");
    expect(title.toLowerCase()).not.toContain("release");
    // aria-label mirrors title for screen-reader parity.
    expect(button.getAttribute("aria-label")).toBe(title);
  });

  it("first click transitions idle → recording (data-phase + aria-pressed flip)", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");

    await act(async () => {
      fireEvent.click(button);
      // Allow getUserMedia microtask + recorder.start to land.
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(button.getAttribute("data-phase")).toBe("recording");
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const title = button.getAttribute("title") ?? "";
    expect(title.toLowerCase()).toContain("recording");
    expect(title.toLowerCase()).toContain("click to stop");
  });

  it("second click transitions recording → uploading (and onTranscript fires on success)", async () => {
    const onTranscript = vi.fn();
    render(<PushToTalkButton onTranscript={onTranscript} />);
    const button = screen.getByTestId("push-to-talk");

    // First click: start recording.
    await act(async () => {
      fireEvent.click(button);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(button.getAttribute("data-phase")).toBe("recording");
    });

    // Second click: stop + upload.
    await act(async () => {
      fireEvent.click(button);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // After upload resolves we land back in idle; transient `uploading` is
    // observable via the disabled flag during the transition. Assert the
    // round-trip rather than racing the transient.
    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("hello world");
    });
    expect(button.getAttribute("data-phase")).toBe("idle");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("10min safety-net auto-stops recording when no second click arrives", async () => {
    // Fake timers from the start so the safety-net setTimeout(600_000)
    // scheduled inside startRecording is captured by the fake-timer system.
    // Use ONLY Promise.resolve() to drain microtasks (no setTimeout(0) which
    // would never fire under fake timers).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const onTranscript = vi.fn();
    render(<PushToTalkButton onTranscript={onTranscript} />);
    const button = screen.getByTestId("push-to-talk");

    // Phase 1: click → startRecording (await-getUserMedia is a real Promise,
    // not a setTimeout, so microtask drain alone is enough).
    await act(async () => {
      fireEvent.click(button);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(button.getAttribute("data-phase")).toBe("recording");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // Phase 2: advance past 10min safety-net cap. The fired callback invokes
    // stopRecordingRef.current(false) synchronously; the rest of the
    // stopRecording chain (recorder.stop → chunks → fetch → setPhase) drains
    // via microtasks.
    await act(async () => {
      vi.advanceTimersByTime(600_001);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    // Restore real timers BEFORE waitFor (waitFor schedules via setTimeout).
    vi.useRealTimers();

    await waitFor(() => {
      const phase = button.getAttribute("data-phase");
      expect(phase === "uploading" || phase === "idle").toBe(true);
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("button has no pointer-event handlers (click-to-toggle, not press-and-hold)", () => {
    // Regression guard: the press-and-hold UX wired onPointerDown / onPointerUp
    // / onPointerCancel / onPointerLeave. Click-to-toggle drops all of them in
    // favor of a single onClick. React attaches synthetic listeners, so we
    // can't read .onpointerdown directly — instead, prove behavior by firing
    // pointer events and asserting the recording state does NOT advance.
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");

    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);

    // Pointer events are no-ops under click-to-toggle; phase stays idle.
    expect(button.getAttribute("data-phase")).toBe("idle");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
