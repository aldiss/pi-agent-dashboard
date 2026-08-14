import { describe, expect, it } from "vitest";
import {
  decodeSessionRouteId,
  isExternalSessionId,
  sessionDetailPath,
} from "../session-route.js";

describe("external session routes", () => {
  it("encodes the runtime delimiter and literal percent characters", () => {
    expect(sessionDetailPath("codex:foo%")).toBe("/session/codex%3Afoo%25");
  });

  it("decodes only Wouter's preserved runtime delimiter", () => {
    // Wouter applies decodeURI first: %25 becomes %, while reserved %3A stays.
    expect(decodeSessionRouteId("codex%3Afoo%")).toBe("codex:foo%");
    expect(decodeSessionRouteId("claude-code%3Acc-pane")).toBe("claude-code:cc-pane");
  });

  it("accepts an already-decoded route and preserves the tmux suffix verbatim", () => {
    expect(decodeSessionRouteId("codex:foo%2Fbar")).toBe("codex:foo%2Fbar");
    expect(decodeSessionRouteId("ordinary-pi-id")).toBe("ordinary-pi-id");
  });

  it("uses the raw pathname to distinguish encoded separators from literal escapes", () => {
    expect(decodeSessionRouteId(
      "codex%3Afoo%2Fbar",
      "/session/codex%3Afoo%2Fbar",
    )).toBe("codex:foo/bar");
    expect(decodeSessionRouteId(
      "codex%3Afoo%2Fbar",
      "/session/codex%3Afoo%252Fbar",
    )).toBe("codex:foo%2Fbar");
  });

  it("recognizes only supported external runtime prefixes", () => {
    expect(isExternalSessionId("codex:foo")).toBe(true);
    expect(isExternalSessionId("claude-code:foo")).toBe(true);
    expect(isExternalSessionId("tui:foo")).toBe(false);
  });
});
