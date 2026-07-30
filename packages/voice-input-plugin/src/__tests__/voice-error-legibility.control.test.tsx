/**
 * Voice control M6 (CLIENT) — the CLASS-LEVEL error-legibility control.
 *
 * The amendment's whole thesis: an operator-facing state whose distinguishing
 * reason lives ONLY in `title`/`aria-label` is imperceptible on a hover-absent
 * touch device (iOS PWA). The previous cycle fixed the interrupted family and
 * left the identical mechanism standing in the ERROR family and in
 * `idle-service-starting`. The previous suite went GREEN over that gap precisely
 * because it asserted only `interrupted ≠ error` and NEVER that error renders
 * words. This control closes exactly that hole.
 *
 * It runs in a plain git-archive checkout: it imports the REAL in-repo component
 * by relative path, drives it to each error cause + the service-starting state,
 * asserts what it actually RENDERS (GREEN), and proves able-to-fail against the
 * in-repo legacy fixture whose pre-fix contract carries the cause in `title`
 * only, with zero on-screen words and a 6s auto-clear (RED). No aliases, no
 * orchestration-state paths, no external codebase copy.
 *
 * The property under test is NOT "the three error strings differ" — it is
 * "can any operator-facing state be told apart from every other, on a touch
 * device, from rendered pixels alone." So the assertions read on-screen words
 * (with <style>/<svg> stripped), never `title`/`aria-label`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { PushToTalkButton, VOICE_MESSAGES } from "../client/PushToTalkButton.js";
import { LegacyPushToTalkButton } from "./__fixtures__/legacy-behaviours.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

/** Upload-path outcome the mocked /transcribe fetch should produce. */
type TranscribeMode =
  | "ok"
  | "no-speech" // 422 EmptyTranscriptError
  | "empty-200" // 200 with empty transcript (defense-in-depth)
  | "http-500"; // generic non-typed HTTP failure

let transcribeMode: TranscribeMode = "ok";
let healthOk = true;
let getUserMediaImpl: () => Promise<MediaStream>;
let visibilityState: DocumentVisibilityState = "visible";
let originalVisibility: PropertyDescriptor | undefined;
let originalCrypto: Crypto;

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

async function drain(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/**
 * On-screen words only: clone the node, strip <style>/<svg>, read textContent.
 * This is the touch-perceptible channel — NOT `title`/`aria-label`.
 */
function visibleWords(el: Element | null | undefined): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("style, svg").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function driveToError(mode: TranscribeMode, blobSize = 1500): Promise<HTMLElement> {
  transcribeMode = mode;
  ControlMediaRecorder.blobSize = blobSize;
  const button = screen.getByTestId("push-to-talk");
  await act(async () => { fireEvent.click(button); await drain(); });
  expect(button.getAttribute("data-phase")).toBe("recording");
  await act(async () => { fireEvent.click(button); await drain(); });
  return button;
}

/** The persistent note the current phase renders (error OR interrupted). */
function noteEl(): HTMLElement | null {
  return (
    screen.queryByTestId("ptt-error-message") ??
    screen.queryByTestId("ptt-interrupted-message")
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  transcribeMode = "ok";
  healthOk = true;
  visibilityState = "visible";
  ControlMediaRecorder.blobSize = 1500;
  getUserMediaImpl = async () => fakeStream;
  // @ts-expect-error jsdom has no MediaRecorder.
  globalThis.MediaRecorder = ControlMediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(() => getUserMediaImpl()) },
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
    if (url.includes("/health")) {
      return new Response("{}", { status: healthOk ? 200 : 503 });
    }
    if (url.includes("/telemetry")) return new Response(null, { status: 204 });
    // /transcribe
    if (transcribeMode === "no-speech") {
      return new Response(JSON.stringify({ type: "EmptyTranscriptError" }), {
        status: 422, headers: { "content-type": "application/json" },
      });
    }
    if (transcribeMode === "empty-200") {
      return new Response(JSON.stringify({ transcript: "" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (transcribeMode === "http-500") {
      return new Response(JSON.stringify({ error: "boom" }), {
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

describe("voice control M6 — every error state renders its cause as on-screen words", () => {
  it("GREEN: error states render NON-EMPTY visible text (the assertion the old suite lacked)", async () => {
    render(
      <>
        <span data-testid="render-probe">known-positive rendered probe</span>
        <PushToTalkButton onTranscript={vi.fn()} />
      </>,
    );
    const probe = screen.getByTestId("render-probe").textContent;

    // Sub-1KiB manual stop → pre-POST SHORT_BLOB error (never hits /transcribe).
    const button = await driveToError("ok", 256);

    const words = visibleWords(noteEl());
    const rendered = {
      probe,
      phase: button.getAttribute("data-phase"),
      errorKind: button.getAttribute("data-error-kind"),
      colour: button.style.color,
      words,
    };
    console.log(`CONTROL M6 GREEN(renders-words) ${JSON.stringify(rendered)}`);

    expect(probe).toBe("known-positive rendered probe");            // known-positive
    expect(button.getAttribute("data-phase")).toBe("error");
    // THE assertion the previous suite never made: error renders WORDS.
    expect(words.length).toBeGreaterThan(0);
    expect(words).not.toBe("");
    // …and those words carry the actual guidance, not just a bare label.
    expect(words).toContain("Recording too short");
  });

  it("GREEN: SHORT_BLOB / NO_SPEECH / EMPTY_RESPONSE are pairwise distinct by RENDERED WORDS + a stable per-kind cue", async () => {
    const seen: Record<string, { words: string; kind: string | null }> = {};

    // SHORT_BLOB — pre-POST, sub-1KiB.
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    let button = await driveToError("ok", 256);
    seen.SHORT_BLOB = {
      words: visibleWords(noteEl()),
      kind: button.getAttribute("data-error-kind"),
    };
    cleanup();

    // NO_SPEECH — 422 EmptyTranscriptError (≥1KiB so it uploads).
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    button = await driveToError("no-speech", 1500);
    seen.NO_SPEECH = {
      words: visibleWords(noteEl()),
      kind: button.getAttribute("data-error-kind"),
    };
    cleanup();

    // EMPTY_RESPONSE — 200 with an empty transcript (defense-in-depth).
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    button = await driveToError("empty-200", 1500);
    seen.EMPTY_RESPONSE = {
      words: visibleWords(noteEl()),
      kind: button.getAttribute("data-error-kind"),
    };

    console.log(`CONTROL M6 GREEN(pairwise-distinct) ${JSON.stringify(seen)}`);

    // Every one renders words.
    for (const k of ["SHORT_BLOB", "NO_SPEECH", "EMPTY_RESPONSE"] as const) {
      expect(seen[k].words.length).toBeGreaterThan(0);
    }
    // Pairwise DISTINCT by rendered words (not by title).
    expect(seen.SHORT_BLOB.words).not.toBe(seen.NO_SPEECH.words);
    expect(seen.SHORT_BLOB.words).not.toBe(seen.EMPTY_RESPONSE.words);
    expect(seen.NO_SPEECH.words).not.toBe(seen.EMPTY_RESPONSE.words);
    // Each carries the exact shared message copy on-screen.
    expect(seen.SHORT_BLOB.words).toContain(VOICE_MESSAGES.SHORT_BLOB);
    expect(seen.NO_SPEECH.words).toContain(VOICE_MESSAGES.NO_SPEECH);
    expect(seen.EMPTY_RESPONSE.words).toContain(VOICE_MESSAGES.EMPTY_RESPONSE);
    // Stable per-kind cue (machine token) is also pairwise distinct.
    expect(seen.SHORT_BLOB.kind).toBe("short-blob");
    expect(seen.NO_SPEECH.kind).toBe("no-speech");
    expect(seen.EMPTY_RESPONSE.kind).toBe("empty-response");
    // And the on-screen eyebrow kicker differs too (a second visible cue).
    expect(seen.SHORT_BLOB.words).toContain("Too short");
    expect(seen.NO_SPEECH.words).toContain("No speech");
    expect(seen.EMPTY_RESPONSE.words).toContain("Empty result");
  });

  it("GREEN: a manually-triggered error PERSISTS past the old 6s window (no silent self-clear)", async () => {
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = await driveToError("ok", 256); // SHORT_BLOB
    expect(button.getAttribute("data-phase")).toBe("error");
    const before = visibleWords(noteEl());

    // Advance well past the pre-amendment ERROR_AUTO_CLEAR_MS = 6000.
    await act(async () => { vi.advanceTimersByTime(6000); await drain(); });
    const phaseAfter6s = button.getAttribute("data-phase");
    await act(async () => { vi.advanceTimersByTime(30_000); await drain(); });
    const phaseAfter36s = button.getAttribute("data-phase");
    const after = visibleWords(noteEl());

    console.log(`CONTROL M6 GREEN(persists) ${JSON.stringify({ before: before.slice(0, 40), phaseAfter6s, phaseAfter36s, stillHasWords: after.length > 0 })}`);

    expect(phaseAfter6s).toBe("error");     // did NOT self-clear at 6s
    expect(phaseAfter36s).toBe("error");    // still there much later
    expect(after.length).toBeGreaterThan(0); // words never vanished
    expect(after).toBe(before);              // same message, unchanged
  });

  it("GREEN: a mic-permission denial renders a distinct, legible cause (not a bare red circle)", async () => {
    getUserMediaImpl = async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    };
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    const button = screen.getByTestId("push-to-talk");
    await act(async () => { fireEvent.click(button); await drain(); });

    const words = visibleWords(noteEl());
    console.log(`CONTROL M6 GREEN(mic-permission) ${JSON.stringify({ kind: button.getAttribute("data-error-kind"), words })}`);

    expect(button.getAttribute("data-phase")).toBe("error");
    expect(button.getAttribute("data-error-kind")).toBe("mic-permission");
    expect(words.length).toBeGreaterThan(0);
    expect(words).toContain("Mic blocked");                  // stable cue on-screen
    expect(words).toContain("Microphone permission denied"); // full reason on-screen
  });

  it("GREEN: idle-service-starting is perceptible vs idle-ready by rendered words + visible disabled dimming", async () => {
    // idle-ready first (health ok): no pill, enabled, full opacity.
    healthOk = true;
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    let button = screen.getByTestId("push-to-talk");
    await act(async () => { await drain(); });
    const ready = {
      pill: screen.queryByTestId("ptt-status-pill")?.textContent ?? "<none>",
      disabled: button.hasAttribute("disabled"),
      opacity: button.style.opacity,
      phase: button.getAttribute("data-phase"),
    };
    cleanup();

    // service-starting (health probe fails → sidecarHealthy=false).
    healthOk = false;
    render(<PushToTalkButton onTranscript={vi.fn()} />);
    button = screen.getByTestId("push-to-talk");
    await act(async () => { await drain(); });
    const starting = {
      pillWords: visibleWords(screen.queryByTestId("ptt-status-pill")),
      disabled: button.hasAttribute("disabled"),
      opacity: button.style.opacity,
      phase: button.getAttribute("data-phase"),
    };

    console.log(`CONTROL M6 GREEN(service-starting) ${JSON.stringify({ ready, starting })}`);

    // idle-ready: no pill, enabled, undimmed.
    expect(ready.pill).toBe("<none>");
    expect(ready.disabled).toBe(false);
    expect(ready.opacity).toBe("1");
    // idle-service-starting: rendered WORDS + a visible disabled treatment.
    expect(starting.phase).toBe("idle");
    expect(starting.pillWords.length).toBeGreaterThan(0);
    expect(starting.pillWords).toContain("Voice service starting");
    expect(starting.disabled).toBe(true);
    expect(Number(starting.opacity)).toBeLessThan(1); // perceptibly dimmed, not just a bare attribute
  });
});

describe("voice control M6 — ABLE-TO-FAIL against the pre-fix legacy contract", () => {
  it("RED: the pre-fix error family renders ZERO on-screen words, so the causes are indistinguishable on touch", () => {
    // Drive the legacy fixture to each of the three causes; the cause lives only
    // in `title`, so the on-screen words are empty for all three.
    const causes = [
      VOICE_MESSAGES.SHORT_BLOB,
      VOICE_MESSAGES.NO_SPEECH,
      VOICE_MESSAGES.EMPTY_RESPONSE,
    ];
    const legacy = causes.map((msg) => {
      render(<LegacyPushToTalkButton driveTo="error" errorMessage={msg} />);
      const button = screen.getByTestId("push-to-talk");
      const row = {
        title: button.getAttribute("title"),
        errorNote: screen.queryByTestId("ptt-error-message"),
        words: visibleWords(button.parentElement),
      };
      cleanup();
      return row;
    });
    console.log(`CONTROL M6 RED(legacy-error-family) ${JSON.stringify(legacy.map((r) => ({ title: r.title, words: r.words })))}`);

    // Titles DO differ (the info exists) …
    expect(legacy[0].title).not.toBe(legacy[1].title);
    // … but there is no rendered error note at all …
    for (const r of legacy) expect(r.errorNote).toBeNull();
    // … and the on-screen words are empty for every cause → indistinguishable
    // on a hover-absent touch device. THIS is what the GREEN half forbids.
    for (const r of legacy) expect(r.words).toBe("");
  });

  it("RED: the pre-fix error self-clears to idle after 6s (the words that were never there also vanish)", () => {
    render(<LegacyPushToTalkButton driveTo="error" errorMessage={VOICE_MESSAGES.SHORT_BLOB} />);
    const button = screen.getByTestId("push-to-talk");
    expect(button.getAttribute("data-phase")).toBe("error");
    act(() => { vi.advanceTimersByTime(6000); });
    const after = button.getAttribute("data-phase");
    console.log(`CONTROL M6 RED(legacy-auto-clear) ${JSON.stringify({ after })}`);
    expect(after).toBe("idle"); // self-erased — the GREEN half proves the real one does NOT
  });

  it("RED: the pre-fix warming service is indistinguishable from ready (no pill, no visible dimming)", () => {
    // ready
    render(<LegacyPushToTalkButton driveTo="idle" />);
    let button = screen.getByTestId("push-to-talk");
    const ready = {
      pill: screen.queryByTestId("ptt-status-pill"),
      words: visibleWords(button.parentElement),
      style: button.getAttribute("style") ?? "",
    };
    cleanup();
    // warming
    render(<LegacyPushToTalkButton driveTo="idle" serviceStarting />);
    button = screen.getByTestId("push-to-talk");
    const starting = {
      pill: screen.queryByTestId("ptt-status-pill"),
      words: visibleWords(button.parentElement),
      style: button.getAttribute("style") ?? "",
    };
    console.log(`CONTROL M6 RED(legacy-service) ${JSON.stringify({ readyWords: ready.words, startingWords: starting.words, sameStyle: ready.style === starting.style })}`);

    // Pre-fix: no pill either way, no rendered words either way, and the resting
    // visual style is identical — the ONLY difference is a bare `disabled`
    // attribute + a hover title. Indistinguishable on touch by pixels.
    expect(ready.pill).toBeNull();
    expect(starting.pill).toBeNull();
    expect(ready.words).toBe("");
    expect(starting.words).toBe("");
    expect(ready.style).toBe(starting.style); // no visible dimming pre-fix
  });
});
