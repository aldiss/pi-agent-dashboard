import { afterEach, beforeEach, describe, expect, vi, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { PushToTalkButton } from "../client/PushToTalkButton.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static blobSize = 1500;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;

  constructor(_stream: MediaStream) {
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(MockMediaRecorder.blobSize)], { type: this.mimeType }),
    });
    this.onstop?.();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const fakeStream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

let visibilityState: DocumentVisibilityState = "visible";
let transcribeInit: RequestInit | undefined;
let telemetryBodies: Array<Record<string, unknown>> = [];
let getUserMedia: ReturnType<typeof vi.fn>;
let originalVisibilityDescriptor: PropertyDescriptor | undefined;
let originalCrypto: Crypto;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/telemetry")) {
      telemetryBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    transcribeInit = init;
    return new Response(JSON.stringify({ transcript: "accepted" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function drainMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function startRecording(): Promise<HTMLElement> {
  const button = screen.getByTestId("push-to-talk");
  await act(async () => {
    fireEvent.click(button);
    await drainMicrotasks();
  });
  expect(button.getAttribute("data-phase")).toBe("recording");
  return button;
}

function recordingStoppedTelemetry(): Record<string, unknown> | undefined {
  return telemetryBodies.find((body) => body.outcome === "recording-stopped");
}

function transcribeHeaders(): Record<string, string> {
  return (transcribeInit?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  MockMediaRecorder.instances = [];
  MockMediaRecorder.blobSize = 1500;
  telemetryBodies = [];
  transcribeInit = undefined;
  visibilityState = "visible";
  getUserMedia = vi.fn(async () => fakeStream);
  // @ts-expect-error jsdom has no MediaRecorder implementation.
  globalThis.MediaRecorder = MockMediaRecorder;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: vi.fn(() => REQUEST_ID) },
  });
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
  if (originalVisibilityDescriptor) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
  }
});

describe("coordinated stop-reason/correlation contract", () => {
  it("GREEN acceptance: delivered hidden event auto-stops, uploads, and stays visibly interrupted until acknowledged", async () => {
    const onTranscript = vi.fn();
    const downstreamVisibilityListener = vi.fn();
    document.addEventListener("visibilitychange", downstreamVisibilityListener);
    render(<PushToTalkButton onTranscript={onTranscript} />);
    const button = await startRecording();

    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await drainMicrotasks();
    });

    expect(downstreamVisibilityListener).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances[0].stopCalls).toBe(1);
    expect(onTranscript).toHaveBeenCalledWith("accepted");
    expect(button.getAttribute("data-phase")).toBe("interrupted");
    expect(button.getAttribute("data-stop-reason")).toBe("visibility-auto-stop");
    expect(button.getAttribute("title")).toBe(
      "Recording interrupted. The app went into background; the transcript may be incomplete. Tap the microphone to dismiss.",
    );
    expect(button.style.color).toBe("var(--accent-yellow)");
    const message = screen.getByTestId("ptt-interrupted-message");
    expect(message.textContent).toContain("Recording interrupted");
    expect(message.textContent).toContain("app went into background");
    expect(button.getAttribute("aria-describedby")).toBe(message.id);

    const telemetry = recordingStoppedTelemetry();
    expect(telemetry).toEqual({
      phase: "client",
      outcome: "recording-stopped",
      sizeClass: "1-16KiB",
      stopReason: "visibility-auto-stop",
      requestId: REQUEST_ID,
    });
    const headers = (transcribeInit?.headers ?? {}) as Record<string, string>;
    expect(headers["x-voice-stop-reason"]).toBe("visibility-auto-stop");
    expect(headers["x-voice-request-id"]).toBe(REQUEST_ID);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
    });
    expect(button.getAttribute("data-phase")).toBe("interrupted");

    fireEvent.click(button);
    expect(button.getAttribute("data-phase")).toBe("idle");
    expect(button.hasAttribute("data-stop-reason")).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    document.removeEventListener("visibilitychange", downstreamVisibilityListener);
  });

  it("safety-net auto-stop uses the safety token, same request ID, and persistent interrupted UI", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = await startRecording();

    await act(async () => {
      vi.advanceTimersByTime(599_999);
      await drainMicrotasks();
    });
    expect(button.getAttribute("data-phase")).toBe("recording");

    await act(async () => {
      vi.advanceTimersByTime(1);
      await drainMicrotasks();
    });
    expect(button.getAttribute("data-phase")).toBe("interrupted");
    expect(button.getAttribute("data-stop-reason")).toBe("safety-net-auto-stop");
    expect(button.getAttribute("title")).toBe(
      "Recording interrupted. The 10-minute safety limit was reached; the transcript may be incomplete. Tap the microphone to dismiss.",
    );
    expect(screen.getByTestId("ptt-interrupted-message").textContent).toContain(
      "10-minute safety limit",
    );
    const telemetry = recordingStoppedTelemetry();
    expect(telemetry?.stopReason).toBe("safety-net-auto-stop");
    expect(telemetry?.requestId).toBe(REQUEST_ID);
    const headers = (transcribeInit?.headers ?? {}) as Record<string, string>;
    expect(headers["x-voice-stop-reason"]).toBe("safety-net-auto-stop");
    expect(headers["x-voice-request-id"]).toBe(telemetry?.requestId);
  });

  it("manual stop emits the manual token and returns to ordinary idle success", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = await startRecording();
    await act(async () => {
      fireEvent.click(button);
      await drainMicrotasks();
    });

    expect(button.getAttribute("data-phase")).toBe("idle");
    expect(button.hasAttribute("data-stop-reason")).toBe(false);
    const telemetry = recordingStoppedTelemetry();
    expect(telemetry?.stopReason).toBe("manual-stop");
    expect(telemetry?.requestId).toBe(REQUEST_ID);
    const headers = (transcribeInit?.headers ?? {}) as Record<string, string>;
    expect(headers["x-voice-stop-reason"]).toBe("manual-stop");
    expect(headers["x-voice-request-id"]).toBe(REQUEST_ID);
  });

  it("reason-first: a tiny visibility auto-stop is persistent interrupted, never operator-blaming error", async () => {
    MockMediaRecorder.blobSize = 256;
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = await startRecording();

    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await drainMicrotasks();
    });

    expect(button.getAttribute("data-phase")).toBe("interrupted");
    expect(button.getAttribute("data-stop-reason")).toBe("visibility-auto-stop");
    expect(button.getAttribute("data-interruption-detail")).toBe("too-brief-to-transcribe");
    expect(button.getAttribute("title")).not.toContain("Recording too short");
    expect(screen.getByTestId("ptt-interrupted-message").textContent).toContain(
      "too brief to transcribe",
    );
    expect(transcribeInit).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await drainMicrotasks();
    });
    expect(button.getAttribute("data-phase")).toBe("interrupted");
  });

  it("allocates a fresh opaque UUID for each new recording", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-a222-222222222222";
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: vi.fn().mockReturnValueOnce(firstId).mockReturnValueOnce(secondId) },
    });
    render(<PushToTalkButton onTranscript={vi.fn()} />);

    let button = await startRecording();
    await act(async () => {
      fireEvent.click(button);
      await drainMicrotasks();
    });
    const firstTelemetryId = String(recordingStoppedTelemetry()?.requestId ?? "");
    const firstHeaderId = transcribeHeaders()["x-voice-request-id"];

    telemetryBodies = [];
    transcribeInit = undefined;
    button = await startRecording();
    await act(async () => {
      fireEvent.click(button);
      await drainMicrotasks();
    });
    const secondTelemetryId = String(recordingStoppedTelemetry()?.requestId ?? "");
    const secondHeaderId = transcribeHeaders()["x-voice-request-id"];

    expect(firstTelemetryId).toBe(firstId);
    expect(firstHeaderId).toBe(firstId);
    expect(secondTelemetryId).toBe(secondId);
    expect(secondHeaderId).toBe(secondId);
    expect(secondTelemetryId).not.toBe(firstTelemetryId);
  });

  it("crypto fallback still emits a canonical RFC4122 v4 request ID reused across telemetry and upload", async () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.forEach((_value, index) => { bytes[index] = index * 11 + 3; });
          return bytes;
        },
      },
    });
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = await startRecording();
    await act(async () => {
      fireEvent.click(button);
      await drainMicrotasks();
    });
    const telemetryId = String(recordingStoppedTelemetry()?.requestId ?? "");
    const headers = (transcribeInit?.headers ?? {}) as Record<string, string>;
    expect(telemetryId).toMatch(UUID_V4);
    expect(headers["x-voice-request-id"]).toBe(telemetryId);
  });
});
