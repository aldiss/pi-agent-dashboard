import { describe, it, expect } from "vitest";
import {
  DIRECTIVE_MARKER,
  isHiddenDirectiveContent,
  isHiddenDirectiveItem,
} from "../operator-voice-directive.js";
import type { ChatMessage } from "../event-reducer.js";
import type { ToolCallGroup } from "../group-tool-calls.js";

// Real forced directive shape — the extension constructs the content as
// `[[operator-voice recompose-for=${originatingId}]] <prose>` (pi-operator-
// voice/src/index.ts:147). This exact prefix was captured in a live session
// JSONL (recompose-for=vm-6). NOT a fabricated shape.
const REAL_DIRECTIVE =
  "[[operator-voice recompose-for=vm-6]] The specific reply you just sent to the operator (message vm-6) used internal jargon that the operator-voice standard flags. Rewrite ONLY the prose of THAT message in plain language.";

// Real mid-body MENTION (must-not-break) — an existing extension test uses
// exactly this shape (door3-over-tag-per-turn.test.ts:215).
const MENTION_MIDBODY = "note the [[operator-voice recompose-for= marker in the design";

function userMsg(content: string): ChatMessage {
  return { id: "u", role: "user", content, timestamp: 0 };
}

describe("operator-voice-directive belt predicate", () => {
  it("exposes the marker mirrored from turn-origin.ts", () => {
    expect(DIRECTIVE_MARKER).toBe("[[operator-voice recompose-for=");
  });

  describe("isHiddenDirectiveContent — leading-token only", () => {
    it("hides a real forced directive (leading marker)", () => {
      expect(isHiddenDirectiveContent(REAL_DIRECTIVE)).toBe(true);
    });
    it("hides a leading directive with leading whitespace (trimStart parity)", () => {
      expect(isHiddenDirectiveContent("  \n[[operator-voice recompose-for=x]] rewrite")).toBe(true);
    });
    it("does NOT hide a mid-body mention (anti-injection must-not-break)", () => {
      expect(isHiddenDirectiveContent(MENTION_MIDBODY)).toBe(false);
    });
    it("does NOT hide a normal operator message", () => {
      expect(isHiddenDirectiveContent("Stop diagnosing. Retry the join now.")).toBe(false);
    });
    it("does NOT hide a message that merely contains the words operator-voice", () => {
      expect(isHiddenDirectiveContent("the operator-voice standard flags jargon")).toBe(false);
    });
  });

  describe("isHiddenDirectiveItem — role + group guards", () => {
    it("hides a user-role directive item", () => {
      expect(isHiddenDirectiveItem(userMsg(REAL_DIRECTIVE))).toBe(true);
    });
    it("does NOT hide an assistant row that quotes the marker (role guard)", () => {
      const assistant: ChatMessage = { id: "a", role: "assistant", content: REAL_DIRECTIVE, timestamp: 0 };
      expect(isHiddenDirectiveItem(assistant)).toBe(false);
    });
    it("does NOT hide a user mid-body mention", () => {
      expect(isHiddenDirectiveItem(userMsg(MENTION_MIDBODY))).toBe(false);
    });
    it("does NOT hide a ToolCallGroup (group guard)", () => {
      const group: ToolCallGroup = { type: "group", toolName: "bash", messages: [], summary: "x" };
      expect(isHiddenDirectiveItem(group)).toBe(false);
    });
    it("does NOT hide a normal user message", () => {
      expect(isHiddenDirectiveItem(userMsg("hello, please run the build"))).toBe(false);
    });
  });
});
