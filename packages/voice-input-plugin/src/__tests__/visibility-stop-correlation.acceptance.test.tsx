// @vitest-environment jsdom
/**
 * Acceptance: a real delivered visibilitychange crosses the exact client and
 * the real Fastify registrar/inject adapter with one privacy-safe correlation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import Fastify, { type FastifyInstance } from "fastify";
import { PushToTalkButton } from "../client/PushToTalkButton.js";
import { register } from "../server/index.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream) {}

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(4096)], { type: this.mimeType }),
    });
    this.onstop?.();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const fakeStream = {
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream;

interface AdapterCapture {
  telemetry: Array<{ body: Record<string, unknown>; status: number }>;
  transcribe: Array<{ headers: Record<string, string>; status: number }>;
}

let app: FastifyInstance;
let capture: AdapterCapture;
let consoleInfo: ReturnType<typeof vi.spyOn>;
const originalConsoleInfo = console.info.bind(console);

function responseHeaders(headers: Record<string, unknown>): HeadersInit {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = String(value);
  }
  return result;
}

beforeEach(async () => {
  capture = { telemetry: [], transcribe: [] };
  consoleInfo = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    // Tee-through is load-bearing: acceptance output visibly proves the
    // production-format logger:false fallback, while the spy verifies fields.
    originalConsoleInfo(...args);
  });

  // @ts-expect-error jsdom does not define MediaRecorder.
  globalThis.MediaRecorder = MockMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  app = Fastify({ logger: false });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // Deterministic sidecar adapter used by the real registrar.
    if (url.startsWith("http://voice-sidecar.test/health")) {
      return new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("http://voice-sidecar.test/transcribe")) {
      return new Response(JSON.stringify({
        transcript: "synthetic-nonempty",
        engine_used: "parakeet",
        duration_ms: 1,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Browser-to-dashboard adapter: real Fastify routing/parser/handler via inject.
    const request = new Request(`http://dashboard.test${url}`, init);
    const payload = request.method === "GET"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers.entries());
    const injected = await app.inject({
      method: request.method as "GET" | "POST",
      url,
      headers,
      payload,
    });

    if (url.includes("/telemetry")) {
      capture.telemetry.push({
        body: JSON.parse(payload?.toString("utf8") || "{}"),
        status: injected.statusCode,
      });
    }
    if (url.includes("/transcribe")) {
      capture.transcribe.push({
        headers,
        status: injected.statusCode,
      });
    }

    return new Response(injected.statusCode === 204 ? null : injected.body, {
      status: injected.statusCode,
      headers: responseHeaders(injected.headers),
    });
  }) as typeof fetch;

  await register(app, {
    sidecarUrl: "http://voice-sidecar.test",
    requestTimeoutMs: 120_000,
    engine: "parakeet",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

afterEach(async () => {
  cleanup();
  await app.close();
  vi.restoreAllMocks();
});

describe("visibility auto-stop correlation acceptance", () => {
  it("delivered visibilitychange is visibly interrupted and queryable across real telemetry + transcribe routes", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);

    const button = screen.getByTestId("push-to-talk");
    await act(async () => {
      fireEvent.click(button);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(button.getAttribute("data-phase")).toBe("recording"));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(button.getAttribute("data-phase")).toBe("interrupted");
      expect(button.getAttribute("data-stop-reason")).toBe("visibility-auto-stop");
      expect(button.getAttribute("title")).toBe(
        "Recording interrupted. The app went into background; the transcript may be incomplete. Tap the microphone to dismiss.",
      );
      expect(screen.getByTestId("ptt-interrupted-message").textContent).toContain(
        "app went into background",
      );
    });

    const stopTelemetry = capture.telemetry.find(
      (entry) => entry.body.outcome === "recording-stopped",
    );
    expect(stopTelemetry?.status).toBe(204);
    expect(stopTelemetry?.body).toMatchObject({
      phase: "client",
      outcome: "recording-stopped",
      stopReason: "visibility-auto-stop",
    });
    const requestId = String(stopTelemetry?.body.requestId ?? "");
    expect(requestId).toMatch(UUID_V4);

    expect(capture.transcribe).toHaveLength(1);
    expect(capture.transcribe[0].status).toBe(200);
    expect(capture.transcribe[0].headers["x-voice-stop-reason"]).toBe(
      "visibility-auto-stop",
    );
    expect(capture.transcribe[0].headers["x-voice-request-id"]).toBe(requestId);

    const voiceLogs = consoleInfo.mock.calls
      .map((args: unknown[]) => args.map(String).join(" "))
      .filter((line: string) => line.includes("voice.telemetry"));
    expect(voiceLogs.some((line: string) =>
      line.includes("outcome=recording-stopped")
      && line.includes("stopReason=visibility-auto-stop")
      && line.includes(`correlationId=${requestId}`)
    )).toBe(true);
    expect(voiceLogs.some((line: string) =>
      line.includes("phase=proxy-forward")
      && line.includes("stopReason=visibility-auto-stop")
      && line.includes(`correlationId=${requestId}`)
    )).toBe(true);
  });
});
