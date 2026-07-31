import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLIENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "client",
  "PushToTalkButton.tsx",
);

/**
 * Regression: microphone left live at the OS level after recording stopped.
 *
 * Observed on a physical iPhone (2026-07-31): the dashboard reported dictation
 * complete, yet iOS kept the orange recording indicator lit and offered its
 * "Stop lydoptagelse?" sheet.
 *
 * Mechanism: a CONSUMER holds its own MediaRecorder on the same MediaStream —
 * the Dawn spool recorder wired through `onStreamChange` in CommandInput. When
 * this component ended the stream's tracks BEFORE notifying that consumer, the
 * consumer's recorder was stranded in state "recording" on an already-dead
 * stream; its stop() could not complete and WebKit never released the capture
 * session.
 *
 * The invariant: at every release site, `onStreamChange(null)` must be invoked
 * BEFORE `getTracks().forEach(t => t.stop())`, so consumers can close their own
 * recorders while the stream is still live.
 *
 * This is a source-order assertion by design. The failure is a WebKit capture-
 * session behaviour that neither jsdom nor Chromium reproduces, so a behavioural
 * test would pass while the device still leaked the microphone.
 */
describe("mic release ordering — consumers notified before tracks end", () => {
  const src = readFileSync(CLIENT, "utf8");

  it("has at least one release site (guards against the probe silently matching nothing)", () => {
    const stops = src.match(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(3);
  });

  it("notifies onStreamChange(null) before ending tracks at EVERY release site", () => {
    const lines = src.split("\n");
    const stopLines: number[] = [];
    lines.forEach((l, i) => {
      if (/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(l)) stopLines.push(i);
    });
    expect(stopLines.length).toBeGreaterThan(0);

    for (const stopAt of stopLines) {
      // The nulling notification must appear in the preceding window, not after.
      const before = lines.slice(Math.max(0, stopAt - 12), stopAt).join("\n");
      const after = lines.slice(stopAt + 1, stopAt + 10).join("\n");
      const notifiedBefore = /onStreamChangeRef\.current\?\.\(null\)/.test(before);
      const notifiedAfter = /onStreamChangeRef\.current\?\.\(null\)/.test(after);
      expect(
        notifiedBefore,
        `track-stop at source line ${stopAt + 1} is not preceded by onStreamChange(null)`,
      ).toBe(true);
      expect(
        notifiedAfter,
        `track-stop at source line ${stopAt + 1} is FOLLOWED by onStreamChange(null) — consumers are told too late`,
      ).toBe(false);
    }
  });
});
