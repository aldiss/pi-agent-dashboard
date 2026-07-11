import { describe, it, expect } from "vitest";
import { stripSpeakerEnvelopeForDisplay } from "../strip-speaker-envelope.js";

// A representative unguessable per-message nonce (as `speaker-wrap.ts` mints).
const NONCE = "3f9c1e77-2a4b-4c8d-9e10-aabbccddeeff";
const wellFormed =
  `<speaker id="op@x.com" name="aldiss" nonce="${NONCE}">\n` +
  `rotate the keys\n` +
  `</speaker nonce="${NONCE}">`;

describe("stripSpeakerEnvelopeForDisplay", () => {
  it("strips a well-formed envelope down to the body (no tags, no nonce)", () => {
    const out = stripSpeakerEnvelopeForDisplay(wellFormed);
    expect(out).toBe("rotate the keys");
    expect(out).not.toContain(NONCE);
    expect(out).not.toMatch(/speaker/i);
  });

  it("catches the NONCE-BEARING CLOSE tag that a naive `</speaker>`-only strip MISSES (the bug)", () => {
    const input = `<speaker nonce="${NONCE}">hello</speaker nonce="${NONCE}">`;
    // Demonstrate the bug: a naive close-strip leaves the nonce visible.
    const naive = input.replace(/<\/?speaker>/gi, "");
    expect(naive).toContain(NONCE); // ← the leak this fix exists to close
    // Our util removes it.
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).toBe("hello");
    expect(out).not.toContain(NONCE);
    expect(out).not.toContain("</speaker");
  });

  it("never leaks the nonce on a MALFORMED close (missing `>`, before a newline)", () => {
    const input = `<speaker nonce="${NONCE}">body\n</speaker nonce="${NONCE}"\ntrailing`;
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).not.toContain(NONCE);
  });

  it("never leaks the nonce on a MALFORMED open (missing `>`, at end of input)", () => {
    const input = `before\n<speaker id="x" name="y" nonce="${NONCE}"`;
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).not.toContain(NONCE);
  });

  it("strips MULTIPLE envelopes, leaking no nonce", () => {
    const n2 = "second-nonce-1234";
    const input =
      `<speaker nonce="${NONCE}">one</speaker nonce="${NONCE}">` +
      `\n<speaker nonce="${n2}">two</speaker nonce="${n2}">`;
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).not.toContain(NONCE);
    expect(out).not.toContain(n2);
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  it("strips NESTED envelopes, leaking neither nonce", () => {
    const nInner = "inner-nonce-9999";
    const input =
      `<speaker nonce="${NONCE}">outer <speaker nonce="${nInner}">inner</speaker nonce="${nInner}"> tail</speaker nonce="${NONCE}">`;
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).not.toContain(NONCE);
    expect(out).not.toContain(nInner);
  });

  it("is case-insensitive (matches the extension's sanitize discipline)", () => {
    const input = `<SPEAKER nonce="${NONCE}">hi</SPEAKER nonce="${NONCE}">`;
    expect(stripSpeakerEnvelopeForDisplay(input)).not.toContain(NONCE);
  });

  it("leaves normal content untouched (fast path)", () => {
    const normal = "just a normal message with no envelope at all";
    expect(stripSpeakerEnvelopeForDisplay(normal)).toBe(normal);
  });

  it("preserves the body's own internal content + newlines", () => {
    const input = `<speaker nonce="${NONCE}">\nline1\nline2\n</speaker nonce="${NONCE}">`;
    const out = stripSpeakerEnvelopeForDisplay(input);
    expect(out).toBe("line1\nline2");
  });

  it("handles empty input", () => {
    expect(stripSpeakerEnvelopeForDisplay("")).toBe("");
  });

  // ── The load-bearing SECURITY invariant: the nonce NEVER survives to render ──
  it("SECURITY: no nonce survives across well-formed / malformed / partial / multiple / nested cases", () => {
    const cases = [
      wellFormed,
      `<speaker nonce="${NONCE}">x</speaker nonce="${NONCE}">`,
      `<speaker nonce="${NONCE}">x\n</speaker nonce="${NONCE}"`, // malformed close
      `<speaker nonce="${NONCE}"`, // partial open, no body/close
      `a</speaker nonce="${NONCE}">b`, // stray nonce-bearing close only
      `<speaker nonce="${NONCE}"><speaker nonce="${NONCE}">n</speaker nonce="${NONCE}"></speaker nonce="${NONCE}">`,
      `text <speaker id="i" name="n" nonce="${NONCE}"> mid`, // open mid-line, no close
    ];
    for (const c of cases) {
      expect(stripSpeakerEnvelopeForDisplay(c)).not.toContain(NONCE);
    }
  });
});
