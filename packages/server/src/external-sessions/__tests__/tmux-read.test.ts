/**
 * tmux-read.ts — the read-only allowlist guard is the security boundary of the
 * whole surface. These tests prove a disallowed subcommand THROWS before it can
 * spawn, and that allowed reads pass through with `-L pi` prepended and their
 * exit `.status` surfaced (never swallowed).
 */
import { describe, it, expect } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import {
  runTmux,
  hasSession,
  capture,
  listSessions,
  paneRootPid,
  DisallowedTmuxSubcommandError,
  ALLOWED_SUBCOMMANDS,
  type SpawnSyncFn,
} from "../tmux-read.js";

function fakeSpawn(
  result: Partial<SpawnSyncReturns<string>>,
  onCall?: (cmd: string, args: readonly string[]) => void,
): SpawnSyncFn {
  return ((cmd: string, args: readonly string[]) => {
    onCall?.(cmd, args);
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null, ...result } as SpawnSyncReturns<string>;
  }) as SpawnSyncFn;
}

describe("allowlist guard", () => {
  it("allows exactly the five non-destructive reads", () => {
    expect([...ALLOWED_SUBCOMMANDS].sort()).toEqual(
      ["capture-pane", "display-message", "has-session", "list-panes", "list-sessions"].sort(),
    );
  });

  it.each([
    "send-keys",
    "kill-session",
    "kill-pane",
    "resize-pane",
    "resize-window",
    "select-pane",
    "set-option",
    "respawn-pane",
    "swap-pane",
  ])("THROWS on the destructive/focus-stealing subcommand %s — never spawns", (sub) => {
    let spawned = false;
    const spy = fakeSpawn({}, () => { spawned = true; });
    expect(() => runTmux(sub, [], spy)).toThrow(DisallowedTmuxSubcommandError);
    expect(spawned).toBe(false); // proved: refused BEFORE executing
  });

  it("prepends `-L pi` and the subcommand for an allowed read", () => {
    let seenArgs: readonly string[] = [];
    const spy = fakeSpawn({ status: 0, stdout: "" }, (_cmd, args) => { seenArgs = args; });
    runTmux("has-session", ["-t", "cx-gap2"], spy);
    expect(seenArgs).toEqual(["-L", "pi", "has-session", "-t", "cx-gap2"]);
  });
});

describe("exit-code discipline", () => {
  it("hasSession is true only on status 0", () => {
    expect(hasSession("cx-gap2", fakeSpawn({ status: 0 }))).toBe(true);
    expect(hasSession("gone", fakeSpawn({ status: 1 }))).toBe(false);
  });

  it("capture surfaces a non-zero status (pane gone) and yields empty output", () => {
    const r = capture("gone", 200, fakeSpawn({ status: 1, stdout: "stale" }));
    expect(r.status).toBe(1);
    expect(r.output).toBe("");
    expect(r.lineCount).toBe(0);
  });

  it("capture returns trimmed output + line count on success", () => {
    const r = capture("cx-gap2", 200, fakeSpawn({ status: 0, stdout: "a\nb\nc\n\n" }));
    expect(r.status).toBe(0);
    expect(r.output).toBe("a\nb\nc");
    expect(r.lineCount).toBe(3);
  });

  it("capture adds `-S -<lines>` scrollback when requested", () => {
    let seenArgs: readonly string[] = [];
    capture("cx-gap2", 200, fakeSpawn({ status: 0, stdout: "" }, (_c, a) => { seenArgs = a; }));
    expect(seenArgs).toContain("-S");
    expect(seenArgs).toContain("-200");
  });

  it("listSessions dedupes to one entry per session with its pane pid", () => {
    const out = "cx-gap2\t100\ncx-gap2\t101\ncc-probe\t200\n";
    const sessions = listSessions(fakeSpawn({ status: 0, stdout: out }));
    expect(sessions).toEqual([
      { sessionName: "cx-gap2", panePid: 100 },
      { sessionName: "cc-probe", panePid: 200 },
    ]);
  });

  it("listSessions returns [] on tmux failure", () => {
    expect(listSessions(fakeSpawn({ status: 1, stdout: "" }))).toEqual([]);
  });

  it("paneRootPid parses the first pane pid, null on failure", () => {
    expect(paneRootPid("cx-gap2", fakeSpawn({ status: 0, stdout: "38767\n" }))).toBe(38767);
    expect(paneRootPid("gone", fakeSpawn({ status: 1, stdout: "" }))).toBeNull();
  });
});
