import { describe, expect, it, vi } from "vitest";
import type { ExternalSession } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import { mapExternalSession, mergeExternalSessions } from "../external-session-mapper.js";

function external(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "codex:done-cx-gap2",
    runtime: "codex",
    tmuxSession: "done-cx-gap2",
    tmuxSocket: "pi",
    title: "done-cx-gap2",
    cwd: "/private/tmp/gap2-wt",
    runtimePid: 4242,
    state: "live",
    model: "gpt-5.6-sol",
    effort: "ultra",
    firstSeenAt: 1_000,
    lastLiveAt: 9_000,
    endedAt: null,
    output: "working",
    outputAt: 9_000,
    outputChangedAt: 8_000,
    lineCount: 12,
    ...overrides,
  };
}

describe("mapExternalSession", () => {
  it("maps a live pane to an ordinary read-only dashboard session", () => {
    expect(mapExternalSession(external())).toMatchObject({
      id: "codex:done-cx-gap2",
      cwd: "/private/tmp/gap2-wt",
      source: "codex",
      name: "done-cx-gap2",
      status: "active",
      model: "codex/gpt-5.6-sol",
      thinkingLevel: "ultra",
      startedAt: 1_000,
      lastActivityAt: 8_000,
      bridgeConnected: true,
      pid: 4242,
      currentTool: null,
      external: {
        runtime: "codex",
        tmuxSession: "done-cx-gap2",
        readOnly: true,
        outputChangedAt: 8_000,
        lineCount: 12,
      },
    });
  });

  it("keeps first-load activity neutral and fills nullable cwd/model", () => {
    const mapped = mapExternalSession(external({
      runtime: "claude-code",
      id: "claude-code:cc-roleaudit-w1",
      cwd: null,
      model: null,
      effort: null,
      outputChangedAt: null,
    }));

    expect(mapped.cwd).toBe("");
    expect(mapped.model).toBe("claude-code/unknown model");
    expect(mapped.external?.outputChangedAt).toBeUndefined();
    expect(mapped.lastActivityAt).toBe(9_000);
  });

  it("maps ended panes to frozen ended sessions without interactive fields", () => {
    const mapped = mapExternalSession(external({ state: "ended", endedAt: 12_000 }));

    expect(mapped.status).toBe("ended");
    expect(mapped.endedAt).toBe(12_000);
    expect(mapped.sessionFile).toBeUndefined();
  });

  it("never emits a non-finite startedAt", () => {
    vi.spyOn(Date, "now").mockReturnValue(55_000);
    expect(mapExternalSession(external({ firstSeenAt: Number.NaN })).startedAt).toBe(55_000);
    vi.restoreAllMocks();
  });
});

describe("mergeExternalSessions", () => {
  it("adds mapped panes to a derived array without mutating the WebSocket-owned map", () => {
    const native = new Map([
      ["pi-1", {
        id: "pi-1",
        cwd: "/private/tmp/gap2-wt",
        source: "tui" as const,
        status: "active" as const,
        startedAt: 500,
      }],
    ]);

    const merged = mergeExternalSessions(native, [external()]);

    expect(merged.map((session) => session.id)).toEqual(["pi-1", "codex:done-cx-gap2"]);
    expect(native.size).toBe(1);
    expect(native.has("codex:done-cx-gap2")).toBe(false);
  });
});
