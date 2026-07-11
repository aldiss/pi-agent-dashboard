/**
 * N-3 — huddle phrase-alias classifier coverage.
 *
 * Proves the design's load-bearing N-3 property: the phrase→action mapping is
 * EXACT (never a loose substring match), so an ordinary prompt that merely
 * contains a keyword is NEVER hijacked into a huddle action. This is the
 * client-side classification that keeps the server free of a pre-gate text-match
 * (the v1-F4 hole): the client emits the TYPED action, gated operator-only at the
 * server chokepoint; a non-matching phrase stays a normal send_prompt.
 */
import { describe, it, expect } from "vitest";
import { classifyHuddlePhrase, normalizeHuddlePhrase } from "../huddle-phrase-alias.js";

describe("N-3 phrase-alias — exact start/recall phrases map", () => {
  it("maps start phrases", () => {
    expect(classifyHuddlePhrase("hold on")).toBe("huddle_start");
    expect(classifyHuddlePhrase("Hold On.")).toBe("huddle_start"); // normalized
    expect(classifyHuddlePhrase("  let's huddle  ")).toBe("huddle_start");
    expect(classifyHuddlePhrase("PAUSE!")).toBe("huddle_start");
  });

  it("maps recall phrases", () => {
    expect(classifyHuddlePhrase("ok agent, come back")).toBe("huddle_recall");
    expect(classifyHuddlePhrase("come back")).toBe("huddle_recall");
    expect(classifyHuddlePhrase("Resume")).toBe("huddle_recall");
    expect(classifyHuddlePhrase("end huddle")).toBe("huddle_recall");
  });
});

describe("N-3 phrase-alias — NO loose match (the v1-F4 hole stays closed)", () => {
  it("does NOT match a longer sentence that merely contains a keyword", () => {
    expect(classifyHuddlePhrase("don't pause the deploy")).toBeNull();
    expect(classifyHuddlePhrase("can you resume the failed job?")).toBeNull();
    expect(classifyHuddlePhrase("hold on to that thought while you refactor")).toBeNull();
    expect(classifyHuddlePhrase("we should come back to this file later")).toBeNull();
  });

  it("never matches a multi-line message (real content)", () => {
    expect(classifyHuddlePhrase("pause\nand think")).toBeNull();
    expect(classifyHuddlePhrase("hold on\n")).toBeNull();
  });

  it("returns null for empty / non-string / unrelated input", () => {
    expect(classifyHuddlePhrase("")).toBeNull();
    expect(classifyHuddlePhrase("deploy staging")).toBeNull();
    expect(classifyHuddlePhrase(undefined as unknown as string)).toBeNull();
  });
});

describe("N-3 phrase-alias — normalization", () => {
  it("trims, collapses whitespace, lowercases, strips trailing punctuation", () => {
    expect(normalizeHuddlePhrase("  Hold   On !! ")).toBe("hold on");
    expect(normalizeHuddlePhrase("RESUME?")).toBe("resume");
  });

  it("does not strip internal punctuation (only trailing)", () => {
    expect(normalizeHuddlePhrase("ok agent, come back")).toBe("ok agent, come back");
  });
});
