/**
 * scanner.ts — registry transition + liveness-predicate tests.
 *
 * The registry is driven with injected deps (`scan`, `isLive`, `now`) so every
 * transition is deterministic — no tmux, no real pids. The negative-control
 * test proves the must-not-lie guard: a broken (always-live) predicate keeps a
 * dead session live; the real predicate correctly reports it ended.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETENTION_MS,
  createExternalSessionRegistry,
  isExternalSessionLive,
  parseModelEffort,
  type ExternalSessionObservation,
} from "../scanner.js";
import type { ExternalSession } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

function obs(over: Partial<ExternalSessionObservation> = {}): ExternalSessionObservation {
  return {
    runtime: "codex",
    tmuxSession: "cx-gap2",
    runtimePid: 40716,
    cwd: "/private/tmp/gap2-wt",
    model: "gpt-5.6-sol",
    effort: "ultra",
    output: "line-1\nline-2",
    lineCount: 2,
    ...over,
  };
}

/** A mutable clock so retention windows are exercised deterministically. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("registry — discovery + transitions", () => {
  it("a NEW session appears as state:live", () => {
    const reg = createExternalSessionRegistry({
      scan: () => [obs()],
      isLive: () => true,
      now: () => 5_000,
    });
    reg.refresh();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("codex:cx-gap2");
    expect(list[0]!.state).toBe("live");
    expect(list[0]!.output).toBe("line-1\nline-2");
    expect(list[0]!.firstSeenAt).toBe(5_000);
    expect(list[0]!.endedAt).toBeNull();
    expect(list[0]!.outputChangedAt).toBeNull();
  });

  it("updates outputChangedAt only when captured output text differs", () => {
    let observations = [obs({ output: "v1", lineCount: 1 })];
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => true,
      now: c.now,
    });
    reg.refresh();
    const first = reg.list()[0]!;
    expect(first.output).toBe("v1");
    const firstOutputAt = first.outputAt;
    expect(first.outputChangedAt).toBeNull(); // first sample is neutral

    c.advance(2_500);
    reg.refresh();
    const unchanged = reg.list()[0]!;
    expect(unchanged.outputAt).toBeGreaterThan(firstOutputAt);
    expect(unchanged.outputChangedAt).toBeNull();

    c.advance(2_500);
    observations = [obs({ output: "v1\nv2", lineCount: 2 })];
    reg.refresh();
    const second = reg.list()[0]!;
    expect(second.state).toBe("live");
    expect(second.output).toBe("v1\nv2");
    expect(second.lineCount).toBe(2);
    expect(second.outputChangedAt).toBe(c.now());
    expect(second.lastLiveAt).toBe(second.outputAt);

    const changedAt = second.outputChangedAt;
    c.advance(2_500);
    reg.refresh();
    expect(reg.list()[0]!.outputChangedAt).toBe(changedAt);
  });

  it("live → (predicate false) → ended: freezes output, keeps in list, sets endedAt", () => {
    let observations = [obs({ output: "final-frame", lineCount: 1 })];
    let live = true;
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: c.now,
    });
    reg.refresh();
    expect(reg.list()[0]!.state).toBe("live");

    // Kill it: gone from the scan AND the predicate now reports dead.
    c.advance(2_500);
    observations = [];
    live = false;
    reg.refresh();

    const ended = reg.list();
    expect(ended).toHaveLength(1); // KEPT — not dropped the instant it died
    expect(ended[0]!.state).toBe("ended");
    expect(ended[0]!.endedAt).toBe(c.now());
    expect(ended[0]!.output).toBe("final-frame"); // FROZEN at last live capture
  });

  it("ended session stays until the retention window elapses, then prunes", () => {
    let observations = [obs()];
    let live = true;
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: c.now,
      retentionMs: 10_000,
    });
    reg.refresh();

    // Transition to ended.
    observations = [];
    live = false;
    c.advance(2_500);
    reg.refresh();
    expect(reg.list()[0]!.state).toBe("ended");

    // Just before the window → still present.
    c.advance(9_999);
    reg.refresh();
    expect(reg.list()).toHaveLength(1);

    // Past the window → pruned.
    c.advance(2);
    reg.refresh();
    expect(reg.list()).toHaveLength(0);
  });

  it("uses a 24-hour default ended-session retention", () => {
    expect(DEFAULT_RETENTION_MS).toBe(24 * 60 * 60 * 1_000);

    let observations = [obs()];
    let live = true;
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: c.now,
    });
    reg.refresh();

    observations = [];
    live = false;
    c.advance(2_500);
    reg.refresh();

    c.advance(DEFAULT_RETENTION_MS - 1);
    reg.refresh();
    expect(reg.list()).toHaveLength(1);
  });

  it("does not prune an expired ended session while capture polling keeps its view lease active", () => {
    let observations = [obs({ output: "frozen", lineCount: 1 })];
    let live = true;
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: c.now,
      retentionMs: 10_000,
      viewGraceMs: 5_000,
    });
    reg.refresh();

    observations = [];
    live = false;
    c.advance(2_500);
    reg.refresh();

    c.advance(9_999);
    expect(reg.captureOne("codex:cx-gap2")?.state).toBe("ended");

    c.advance(2); // retention elapsed, but detail capture touched the view lease
    reg.refresh();
    expect(reg.list()).toHaveLength(1);

    c.advance(4_000);
    expect(reg.captureOne("codex:cx-gap2")?.state).toBe("ended");
    reg.refresh();
    expect(reg.list()).toHaveLength(1);

    c.advance(5_001); // polling stopped and the grace window elapsed
    reg.refresh();
    expect(reg.list()).toHaveLength(0);
  });

  it("captureOne returns fresh output when live, and never re-reads a dead pane when ended", () => {
    let observations = [obs({ output: "old", lineCount: 1 })];
    let live = true;
    let liveReads = 0;
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: c.now,
      captureLive: () => {
        liveReads++;
        return { status: 0, output: "fresh-drill-in", lineCount: 1 };
      },
    });
    reg.refresh();
    const liveCap = reg.captureOne("codex:cx-gap2");
    expect(liveCap?.state).toBe("live");
    expect(liveCap?.output).toBe("fresh-drill-in"); // live → fresh read
    expect(liveReads).toBe(1);
    // Detail uses a 1000-line capture while refresh uses 200 lines. It must not
    // replace or activity-stamp the canonical list sample solely because the
    // capture depths differ.
    expect(reg.list()[0]!.output).toBe("old");
    expect(reg.list()[0]!.outputChangedAt).toBeNull();

    c.advance(1_000);
    reg.captureOne("codex:cx-gap2");
    expect(reg.list()[0]!.outputChangedAt).toBeNull();

    c.advance(1_000);
    reg.refresh();
    expect(reg.list()[0]!.output).toBe("old");
    expect(reg.list()[0]!.outputChangedAt).toBeNull();

    observations = [];
    live = false;
    c.advance(2_500);
    reg.refresh();
    const endedCap = reg.captureOne("codex:cx-gap2");
    expect(endedCap?.state).toBe("ended");
    expect(endedCap?.output).toBe("fresh-drill-in"); // frozen at last capture
    expect(liveReads).toBe(2); // did NOT re-read the dead pane after the two live reads
  });

  it("captureOne returns null for an unknown id", () => {
    const reg = createExternalSessionRegistry({ scan: () => [], isLive: () => true });
    expect(reg.captureOne("codex:nope")).toBeNull();
  });
});

describe("isExternalSessionLive — the single discrete predicate", () => {
  const base: ExternalSession = {
    id: "codex:cx-gap2",
    runtime: "codex",
    tmuxSession: "cx-gap2",
    tmuxSocket: "pi",
    title: "cx-gap2",
    cwd: "/private/tmp/gap2-wt",
    runtimePid: 40716,
    state: "live",
    model: "gpt-5.6-sol",
    effort: "ultra",
    firstSeenAt: 0,
    lastLiveAt: 0,
    endedAt: null,
    output: "x",
    outputAt: 0,
    outputChangedAt: null,
    lineCount: 1,
  };

  it("live only when session exists AND pid alive AND argv still matches runtime", () => {
    expect(
      isExternalSessionLive(base, {
        hasSession: () => true,
        procAlive: () => true,
        procArgv: () => "node /opt/homebrew/bin/codex --yolo",
      }),
    ).toBe(true);
  });

  it("dead when the tmux session is gone", () => {
    expect(
      isExternalSessionLive(base, {
        hasSession: () => false,
        procAlive: () => true,
        procArgv: () => "node /opt/homebrew/bin/codex --yolo",
      }),
    ).toBe(false);
  });

  it("dead when the runtime pid is no longer alive", () => {
    expect(
      isExternalSessionLive(base, {
        hasSession: () => true,
        procAlive: () => false,
        procArgv: () => "node /opt/homebrew/bin/codex --yolo",
      }),
    ).toBe(false);
  });

  it("dead when the pid was recycled into a bare shell (argv no longer matches)", () => {
    expect(
      isExternalSessionLive(base, {
        hasSession: () => true,
        procAlive: () => true,
        procArgv: () => "-zsh",
      }),
    ).toBe(false);
  });
});

describe("broken liveness predicate would keep a dead session live (negative control)", () => {
  it("with the predicate stubbed always-true, a killed session is WRONGLY reported live", () => {
    let observations = [obs()];
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => true, // BROKEN: always-live (the bug the supervisor reproduces)
      now: c.now,
    });
    reg.refresh();
    // Kill it — gone from tmux.
    observations = [];
    c.advance(2_500);
    reg.refresh();

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe("live"); // WRONG — a dead pane looks live
  });

  it("with the REAL predicate restored, the same killed session correctly reports ended", () => {
    let observations = [obs()];
    let paneAlive = true; // drives the real predicate's has-session + pid checks
    const c = clock();
    const reg = createExternalSessionRegistry({
      scan: () => observations,
      // No `isLive` override → the registry uses the real isExternalSessionLive,
      // wired to these deps. Killing the pane flips all three checks to dead.
      hasSession: () => paneAlive,
      procAlive: () => paneAlive,
      procArgv: () => (paneAlive ? "node /opt/homebrew/bin/codex --yolo" : "-zsh"),
      now: c.now,
    });
    reg.refresh();
    expect(reg.list()[0]!.state).toBe("live");

    // Kill it.
    observations = [];
    paneAlive = false;
    c.advance(2_500);
    reg.refresh();

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe("ended"); // CORRECT — the guard holds
    expect(list[0]!.endedAt).toBe(c.now());
  });
});

describe("parseModelEffort — best-effort, never throws", () => {
  it("parses the Codex banner", () => {
    const text = "› Summarize recent commits\n  gpt-5.6-sol ultra · /private/tmp/gap2-wt · Main [default]";
    expect(parseModelEffort("codex", text)).toEqual({ model: "gpt-5.6-sol", effort: "ultra" });
  });

  it("parses the Claude Code banner (model only, no effort)", () => {
    const text = "▝▜█████▛▘  Opus 4 (1M context) · API Usage Billing";
    expect(parseModelEffort("claude-code", text)).toEqual({
      model: "Opus 4 (1M context)",
      effort: null,
    });
  });

  it("returns nulls when nothing matches", () => {
    expect(parseModelEffort("codex", "no banner here")).toEqual({ model: null, effort: null });
    expect(parseModelEffort("claude-code", "no banner here")).toEqual({ model: null, effort: null });
  });
});
