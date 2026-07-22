/**
 * door-3 MOVE-2 deterministic strip-and-show — reducer + maskJargonSpans tests.
 *
 * Proves the message_end 3-way disposition (voiceRecomposeState: held→HOLD /
 * terminal→STRIP-AND-SHOW / converged→RELEASE byte-identical), the absent-field
 * backward-compat (#2 verdict-only rule), and the strip core (jargon-id spans
 * masked, shape-* / observe as-is, repeated occurrences each masked, byte-identical
 * on non-masked spans, offset-drift whole-line fallback).
 *
 * Pure reducer state (no DOM). Operator-VISIBLE strip is proven separately by
 * ChatView.operator-strip-render.test.ts. See change: operator-voice-strip-and-show.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduceEvent,
  maskJargonSpans,
  JARGON_REDACTION_MARKER,
  type SessionState,
  type VoiceMatch,
} from "../event-reducer.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { Audience } from "@blackbelt-technology/pi-dashboard-shared/vendor/operator-voice-audience/audience-core.js";

function stateWith(audience: Audience | undefined): SessionState {
  return { ...createInitialState(), audience };
}
function asstStart(t: number): DashboardEvent {
  return { eventType: "message_start", timestamp: t, data: { message: { role: "assistant", content: [] } } } as DashboardEvent;
}
function textDelta(t: number, text: string): DashboardEvent {
  return { eventType: "message_update", timestamp: t, data: { message: { role: "assistant", content: [{ type: "text", text }] } } } as DashboardEvent;
}
function messageEnd(
  t: number,
  opts: { text: string; audience?: string; voiceVerdict?: string; voiceRecomposeState?: string; voiceMatches?: VoiceMatch[] },
): DashboardEvent {
  const message: Record<string, unknown> = { role: "assistant", content: [{ type: "text", text: opts.text }] };
  if (opts.audience !== undefined) message.audience = opts.audience;
  if (opts.voiceVerdict !== undefined) message.voiceVerdict = opts.voiceVerdict;
  if (opts.voiceRecomposeState !== undefined) message.voiceRecomposeState = opts.voiceRecomposeState;
  if (opts.voiceMatches !== undefined) message.voiceMatches = opts.voiceMatches;
  return { eventType: "message_end", timestamp: t, data: { message, entryId: "e1", nonce: "n1" } } as DashboardEvent;
}
/** Build aligned matches by locating each token in the held text (offsets exact). */
function matchesIn(text: string, specs: Array<{ match: string; mode: string; category: string; from?: number }>): VoiceMatch[] {
  return specs.map((s, i) => ({ id: `m${i}`, match: s.match, index: text.indexOf(s.match, s.from ?? 0), mode: s.mode, category: s.category }));
}

const JARGON = "Shipped per dl-11131 in \u00a716.1; retagged at tenure-16.";
const JARGON_MATCHES = matchesIn(JARGON, [
  { match: "dl-11131", mode: "enforce", category: "internal-id" },
  { match: "\u00a716.1", mode: "enforce", category: "internal-cite" },
  { match: "tenure-16", mode: "enforce", category: "internal-id" }, // tenure-ids emit as internal-id
]);

describe("maskJargonSpans — strip filter + offset basis", () => {
  it("masks each jargon-id enforce span (internal-id dl+tenure, internal-cite §); non-masked byte-identical", () => {
    const out = maskJargonSpans(JARGON, JARGON_MATCHES);
    for (const tok of ["dl-11131", "\u00a716.1", "tenure-16"]) expect(out).not.toContain(tok);
    // non-jargon prose survives verbatim
    expect(out.startsWith("Shipped per ")).toBe(true);
    expect(out).toContain(" in ");
    expect(out).toContain("; retagged at ");
    expect(out).toContain(JARGON_REDACTION_MARKER);
  });

  it("§-cite (internal-cite enforce) strips; themed-name (observe) renders as-is", () => {
    // The exact leak the real-emit co-verify caught: §-cites are category
    // internal-cite (were missing from the strip set); themed-names emit observe.
    const text = "See \u00a716.1 — approved by Joan.";
    const matches: VoiceMatch[] = [
      ...matchesIn(text, [{ match: "\u00a716.1", mode: "enforce", category: "internal-cite" }]),
      ...matchesIn(text, [{ match: "Joan", mode: "observe", category: "themed-name" }]),
    ];
    const out = maskJargonSpans(text, matches);
    expect(out).not.toContain("\u00a716.1"); // §-cite masked
    expect(out).toContain("Joan");            // themed-name observe → shown as-is
    expect(out).toContain("approved by ");
  });

  it("theater-praise (ENFORCE but a prose word, not an id-token) renders as-is; the id-token still strips", () => {
    // operator-lexicon.json: theater-praise is enforce (12 entries: excellent,
    // superb, …) but a PROSE word — masking mid-sentence corrupts prose, so it is
    // deliberately NOT in JARGON_ID_CATEGORIES (re-compose owns theater; strip owns
    // id-tokens). Verified against the emitter, not the re-handed set.
    const text = "Excellent — shipped per dl-11131.";
    const matches: VoiceMatch[] = [
      ...matchesIn(text, [{ match: "Excellent", mode: "enforce", category: "theater-praise" }]),
      ...matchesIn(text, [{ match: "dl-11131", mode: "enforce", category: "internal-id" }]),
    ];
    const out = maskJargonSpans(text, matches);
    expect(out).toContain("Excellent");     // theater-praise enforce → NOT stripped (stylistic)
    expect(out).not.toContain("dl-11131");  // id-token IS stripped
    expect(out).toContain("shipped per ");
  });

  it("repeated token → EACH occurrence masked", () => {
    const text = "dl-1 and dl-1 again";
    const matches = matchesIn(text, [
      { match: "dl-1", mode: "enforce", category: "internal-id" },
      { match: "dl-1", mode: "enforce", category: "internal-id", from: 1 },
    ]);
    const out = maskJargonSpans(text, matches);
    expect(out).toBe(`${JARGON_REDACTION_MARKER} and ${JARGON_REDACTION_MARKER} again`);
  });

  it("shape-* enforce + ALL observe hits render AS-IS (never masked)", () => {
    const text = "keep this shape and this name Bert observed";
    const matches: VoiceMatch[] = [
      ...matchesIn(text, [{ match: "shape", mode: "enforce", category: "shape-a-legible-opening" }]),
      ...matchesIn(text, [{ match: "Bert", mode: "observe", category: "themed-name" }]),
    ];
    expect(maskJargonSpans(text, matches)).toBe(text);
  });

  it("zero eligible matches → text unchanged", () => {
    expect(maskJargonSpans("plain reply, no jargon", [])).toBe("plain reply, no jargon");
  });

  it("offset-DRIFT (misaligned index) → whole-line redaction fallback", () => {
    const text = "line one is clean\nline two has dl-9999 jargon\nline three clean";
    // Deliberately wrong offset (does not slice back to the token) → forces fallback.
    const matches: VoiceMatch[] = [{ id: "x", match: "dl-9999", index: 0, mode: "enforce", category: "internal-id" }];
    const out = maskJargonSpans(text, matches);
    expect(out).not.toContain("dl-9999");           // jargon gone
    expect(out).toContain("line one is clean");       // other lines survive
    expect(out).toContain("line three clean");
    expect(out.split("\n")[1]).toBe(JARGON_REDACTION_MARKER); // the jargon line redacted whole
  });
});

describe("reducer message_end disposition (voiceRecomposeState 3-way)", () => {
  function runToEnd(end: DashboardEvent): SessionState {
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, JARGON));
    expect(s.streamingText).toBe("");     // held, nothing live
    expect(s.heldOperatorText).toBe(JARGON);
    return reduceEvent(s, end);
  }

  it("terminal → STRIP-AND-SHOW (masked real content committed)", () => {
    const s = runToEnd(messageEnd(3, { text: JARGON, audience: "operator", voiceVerdict: "enforce-hit", voiceRecomposeState: "terminal", voiceMatches: JARGON_MATCHES }));
    const asst = s.messages.filter((m) => m.role === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0].content).not.toContain("dl-11131");
    expect(asst[0].content).toContain("Shipped per ");
    expect(asst[0].content).toContain(JARGON_REDACTION_MARKER);
    expect(s.heldOperatorText).toBe("");
  });

  it("held → HOLD (render nothing; re-drive coming)", () => {
    const s = runToEnd(messageEnd(3, { text: JARGON, audience: "operator", voiceVerdict: "enforce-hit", voiceRecomposeState: "held", voiceMatches: JARGON_MATCHES }));
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(s.heldOperatorText).toBe("");
  });

  it("converged → RELEASE byte-identical (real content, unmasked)", () => {
    const clean = "All shipped, plainly.";
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, clean));
    s = reduceEvent(s, messageEnd(3, { text: clean, audience: "operator", voiceVerdict: "clean", voiceRecomposeState: "converged" }));
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([clean]);
  });

  it("BACKWARD-COMPAT: voiceRecomposeState ABSENT + enforce-hit → HOLD (#2 rule)", () => {
    const s = runToEnd(messageEnd(3, { text: JARGON, audience: "operator", voiceVerdict: "enforce-hit", voiceMatches: JARGON_MATCHES }));
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(0); // #2 behavior preserved
  });

  it("BACKWARD-COMPAT: voiceRecomposeState ABSENT + clean → RELEASE byte-identical (#2 rule)", () => {
    const clean = "Plain reply.";
    let s = stateWith("operator");
    s = reduceEvent(s, asstStart(1));
    s = reduceEvent(s, textDelta(2, clean));
    s = reduceEvent(s, messageEnd(3, { text: clean, audience: "operator", voiceVerdict: "clean" }));
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([clean]);
  });
});
