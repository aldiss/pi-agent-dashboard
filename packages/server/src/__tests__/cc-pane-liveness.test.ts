/**
 * CC-pane liveness parser + TTL-cache tests (F4 — dl-2732).
 *
 * Pure-parse + cache behavior only; no real `tmux` spawn (the live probe is
 * fail-safe-to-empty and exercised at integration time).
 */
import { describe, it, expect } from "vitest";
import { parseClaudePanes, createClaudePaneProbe, type ClaudePane } from "../cc-pane-liveness.js";

describe("parseClaudePanes", () => {
  it("keeps only claude panes, drops pi/shell panes", () => {
    const raw = [
      "cc-row-hygiene-build\tclaude.exe\t/work/dash\t64011",
      "bert-tenure-34\tpi\t/work/os\t1234",
      "cc-composer\tclaude\t/work/cc\t41155",
      "shell\tzsh\t/home\t999",
    ].join("\n");
    expect(parseClaudePanes(raw)).toEqual<ClaudePane[]>([
      { sessionName: "cc-row-hygiene-build", cwd: "/work/dash", pid: 64011 },
      { sessionName: "cc-composer", cwd: "/work/cc", pid: 41155 },
    ]);
  });

  it("tolerates a non-numeric / missing pid (pid → 0)", () => {
    expect(parseClaudePanes("cc-x\tclaude\t/work/x\t")).toEqual([
      { sessionName: "cc-x", cwd: "/work/x", pid: 0 },
    ]);
  });

  it("ignores blank lines and malformed rows", () => {
    const raw = "\n\ncc-ok\tclaude\t/w\t5\nbad-row-no-tabs\n";
    expect(parseClaudePanes(raw)).toEqual([{ sessionName: "cc-ok", cwd: "/w", pid: 5 }]);
  });

  it("empty input → empty list (fail-safe)", () => {
    expect(parseClaudePanes("")).toEqual([]);
  });
});

describe("createClaudePaneProbe — TTL cache", () => {
  it("collapses repeated calls within the TTL into one underlying list()", () => {
    let calls = 0;
    let t = 0;
    const probe = createClaudePaneProbe({
      ttlMs: 2000,
      now: () => t,
      list: () => {
        calls++;
        return [{ sessionName: `cc-${calls}`, cwd: "/w", pid: calls }];
      },
    });
    probe.listClaudePanes(); // miss → calls=1
    probe.listClaudePanes(); // hit
    t = 1999;
    probe.listClaudePanes(); // still hit
    expect(calls).toBe(1);
    t = 2001;
    probe.listClaudePanes(); // expired → calls=2
    expect(calls).toBe(2);
  });
});
