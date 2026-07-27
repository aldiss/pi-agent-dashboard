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
import { _debugReadBuffer, _debugReset } from "../client/telemetry.js";

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

  // ── vector-glyph contract (mic-rewrite 2026-06-28) ──────────────────────────
  // The pre-rewrite button rendered emoji (🎤/🔴/⏳) which ignore `style.color`.
  // The rewrite renders inline-SVG Material glyphs that inherit `currentColor`,
  // so they finally respect the theme token driven by the button's style.color.

  it("idle renders a vector SVG glyph (not emoji) that inherits currentColor", () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");

    // A real <svg> glyph is present, tagged with the current phase.
    const icon = screen.getByTestId("ptt-icon");
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("data-icon-phase")).toBe("idle");

    // The path paints with currentColor — the whole point of dropping emoji.
    const path = icon.querySelector("path");
    expect(path?.getAttribute("fill")).toBe("currentColor");

    // No emoji glyph survives anywhere in the button.
    expect(button.textContent ?? "").not.toMatch(/[🎤🔴⏳]/u);

    // currentColor is fed by the theme token, not a hardcoded hex.
    expect((button as HTMLElement).style.color).toContain("--text-secondary");
  });

  it("recording paints the calm accent token and shows the vector pulse ring (no red emoji)", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");

    await act(async () => {
      fireEvent.click(button);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(button.getAttribute("data-phase")).toBe("recording");
    });

    // Recording reads CALM: var(--accent-primary), never an alarming red token/emoji.
    expect((button as HTMLElement).style.color).toContain("--accent-primary");
    expect((button as HTMLElement).style.color).not.toContain("--accent-red");

    // The calm vector pulse ring is present and carries no hardcoded color —
    // it borders with currentColor, so it inherits the accent token above.
    // (jsdom drops the `currentColor` keyword when re-serializing the `border`
    //  shorthand, so assert structure + absence-of-hardcoded-color instead.)
    const ring = screen.getByTestId("ptt-pulse-ring");
    expect(ring).toBeTruthy();
    expect(ring.style.border).toContain("2px solid");
    expect(ring.style.border).not.toMatch(/#|rgb|hsl/i);

    // The glyph tracks the phase and still inherits currentColor.
    const icon = screen.getByTestId("ptt-icon");
    expect(icon.getAttribute("data-icon-phase")).toBe("recording");
    expect(icon.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(button.textContent ?? "").not.toMatch(/[🎤🔴⏳]/u);
  });
});

// ── D1: health-gate zero-POST attempt observability (Pete dl-12308 #1) ─────────
// The LEADING zero-POST branch: an operator clicking while the sidecar is
// unhealthy/stale. Prior behaviour natively disabled the button OR silently
// `return`ed in onClick — recording NOTHING anywhere, which is the primary
// suspected cause of the original incident. The fix records the attempt before
// refusing, while preserving the disabled ANNOUNCEMENT (aria-disabled) + look.

/** A fetch whose /health reports UNHEALTHY (503), so sidecarHealthy flips false. */
function buildUnhealthyFetch(): { fetch: typeof fetch; transcribeCalls: () => number } {
  let transcribeCalls = 0;
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ healthy: false }), { status: 503 });
    }
    if (url.includes("/transcribe")) {
      transcribeCalls++;
      return new Response(JSON.stringify({ transcript: "should-not-happen" }), { status: 200 });
    }
    // telemetry sink drain: 200 but ack nothing (keeps record buffered/inspectable)
    return new Response(JSON.stringify({ ok: true, acked: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, transcribeCalls: () => transcribeCalls };
}

describe("PushToTalkButton — D1 health-gate attempt is observable (not silently dropped)", () => {
  beforeEach(() => {
    _debugReset();
    MockMediaRecorder.instances = [];
    // @ts-expect-error jsdom does not provide MediaRecorder
    globalThis.MediaRecorder = MockMediaRecorder;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream) },
    });
  });
  afterEach(() => {
    _debugReset();
  });

  it("clicking while sidecar unhealthy records a sidecar_unhealthy_gate no_post AND issues NO transcribe POST", async () => {
    const probe = buildUnhealthyFetch();
    globalThis.fetch = probe.fetch;
    const onTranscript = vi.fn();
    render(<PushToTalkButton onTranscript={onTranscript} />);
    const button = screen.getByTestId("push-to-talk");

    // Wait for the health poll to mark the sidecar unhealthy.
    await waitFor(() => {
      expect(button.getAttribute("aria-disabled")).toBe("true");
    });
    // It is NOT natively disabled — the click must be able to fire.
    expect((button as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    // The attempt is recorded locally (persist-first), even though nothing POSTed.
    const gateRecords = _debugReadBuffer().filter(
      (r) => r.event === "no_post" && r.reason === "sidecar_unhealthy_gate"
    );
    expect(gateRecords.length).toBe(1);
    // And crucially: NO transcribe POST was issued, and no transcript delivered.
    expect(probe.transcribeCalls()).toBe(0);
    expect(onTranscript).not.toHaveBeenCalled();
    // Recording never started.
    expect(MockMediaRecorder.instances.length).toBe(0);
  });

  it("MUTATION/RED — the old silent early-return (no emit) is rejected by this guard", () => {
    // Model the pre-fix behaviour: gate returns WITHOUT emitting. The guard the
    // green test relies on (a persisted gate record) must then fail.
    _debugReset();
    const brokenOnClickGate = () => {
      // if (!sidecarHealthy) return;  ← no emit (the original defect)
    };
    brokenOnClickGate();
    const gateRecords = _debugReadBuffer().filter(
      (r) => r.event === "no_post" && r.reason === "sidecar_unhealthy_gate"
    );
    expect(() => expect(gateRecords.length).toBe(1)).toThrow(); // RED: it is 0
  });

  it("preserves the disabled ANNOUNCEMENT + LOOK while remaining clickable (a11y)", async () => {
    globalThis.fetch = buildUnhealthyFetch().fetch;
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");
    await waitFor(() => {
      expect(button.getAttribute("aria-disabled")).toBe("true");
    });
    // Announced unavailable to assistive tech …
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // … dimmed for sighted users …
    expect((button as HTMLElement).style.opacity).toBe("0.5");
    expect((button as HTMLElement).style.cursor).toBe("not-allowed");
    // … but NOT natively disabled, so the click still reaches onClick.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
