/**
 * Tests for the editorial status-as-color mapping (`getActivityKind`).
 * It drives the SessionCard status rail / dot / status-text hue, so its
 * branch order must agree with ActivityIndicator. See the Editorial Craft
 * skin build.
 */
import { describe, it, expect } from "vitest";
import { getActivityKind } from "../components/SessionCard.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function makeSession(over: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1",
    status: "idle",
    startedAt: 0,
    source: "tui",
    ...over,
  } as DashboardSession;
}

describe("getActivityKind", () => {
  it("returns error first when hasError, overriding everything else", () => {
    expect(getActivityKind(makeSession({ status: "streaming", currentTool: "edit_file" }), true)).toBe("error");
  });

  it("maps resuming to live", () => {
    expect(getActivityKind(makeSession({ status: "ended", resuming: true }))).toBe("live");
  });

  it("maps an ended session to idle, or unread when it has unviewed activity", () => {
    expect(getActivityKind(makeSession({ status: "ended" }))).toBe("idle");
    expect(getActivityKind(makeSession({ status: "ended", unread: true }))).toBe("unread");
  });

  it("maps ask_user to wait (awaiting operator input)", () => {
    expect(getActivityKind(makeSession({ status: "streaming", currentTool: "ask_user" }))).toBe("wait");
  });

  it("maps an active tool to live (work happening now)", () => {
    expect(getActivityKind(makeSession({ status: "streaming", currentTool: "bash" }))).toBe("live");
  });

  it("maps streaming-without-tool to think (reasoning)", () => {
    expect(getActivityKind(makeSession({ status: "streaming" }))).toBe("think");
  });

  it("maps an idle/active alive session to wait (awaiting input)", () => {
    expect(getActivityKind(makeSession({ status: "idle" }))).toBe("wait");
    expect(getActivityKind(makeSession({ status: "active" }))).toBe("wait");
  });

  it("agrees with the ActivityIndicator branch order: ask_user wins over generic tool", () => {
    // ask_user is checked before the generic currentTool branch in both places.
    const s = makeSession({ status: "streaming", currentTool: "ask_user" });
    expect(getActivityKind(s)).toBe("wait");
  });
});
