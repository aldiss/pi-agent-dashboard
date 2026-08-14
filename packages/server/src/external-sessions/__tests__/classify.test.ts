/**
 * classify.ts — pure classification + liveness sub-predicate tests.
 *
 * Fixtures are the real argv strings observed on socket pi:
 *   codex child:  `node /opt/homebrew/bin/codex --yolo`
 *   claude child: `/Users/x/.local/bin/claude --dangerously-skip-permissions --effort max`
 *   pi root:      `pi`
 *   shell root:   `-zsh`
 */
import { describe, it, expect } from "vitest";
import {
  isPiRootArgv,
  classifyRuntime,
  runtimeArgvMatches,
  classifySession,
} from "../classify.js";

const CODEX_CHILD = "node /opt/homebrew/bin/codex --yolo";
const CLAUDE_CHILD =
  "/Users/vdrobkov/.local/bin/claude --dangerously-skip-permissions --effort max";
const HEADLESS_CLAUDE_CHILD = "claude --output-format stream-json";

describe("isPiRootArgv", () => {
  it("matches a bare `pi` root", () => {
    expect(isPiRootArgv("pi")).toBe(true);
    expect(isPiRootArgv("pi           ")).toBe(true); // trailing pad as tmux reports it
  });

  it("matches a pathed pi binary by basename", () => {
    expect(isPiRootArgv("/usr/local/bin/pi --resume")).toBe(true);
  });

  it("does NOT match a shell or a codex/claude root", () => {
    expect(isPiRootArgv("-zsh")).toBe(false);
    expect(isPiRootArgv("zsh")).toBe(false);
    expect(isPiRootArgv("-bash")).toBe(false);
    expect(isPiRootArgv(CODEX_CHILD)).toBe(false);
    expect(isPiRootArgv(CLAUDE_CHILD)).toBe(false);
  });

  it("does NOT match a `node`-led argv (the reason we can't reuse isPiCommandLine)", () => {
    expect(isPiRootArgv(CODEX_CHILD)).toBe(false);
  });
});

describe("classifyRuntime", () => {
  it("classifies a codex child as codex", () => {
    expect(classifyRuntime(["-zsh", CODEX_CHILD])).toBe("codex");
  });

  it("classifies an interactive claude child as claude-code", () => {
    expect(classifyRuntime(["-zsh", CLAUDE_CHILD])).toBe("claude-code");
  });

  it("returns null for a bare shell with no agent child", () => {
    expect(classifyRuntime(["-zsh"])).toBeNull();
  });

  it("prefers codex when both markers are present", () => {
    expect(classifyRuntime(["-zsh", CODEX_CHILD, CLAUDE_CHILD])).toBe("codex");
  });
});

describe("classifySession (pi-root-wins combinator)", () => {
  it("codex child → codex", () => {
    expect(classifySession({ rootArgv: "-zsh", childArgvs: [CODEX_CHILD] })).toBe("codex");
  });

  it("interactive claude child → claude-code", () => {
    expect(classifySession({ rootArgv: "-zsh", childArgvs: [CLAUDE_CHILD] })).toBe("claude-code");
  });

  it("pi root → skip (null)", () => {
    expect(classifySession({ rootArgv: "pi", childArgvs: [] })).toBeNull();
  });

  it("pi root WITH a headless claude stream-json child → still skipped (pi wins)", () => {
    expect(
      classifySession({ rootArgv: "pi", childArgvs: [HEADLESS_CLAUDE_CHILD] }),
    ).toBeNull();
  });

  it("bare shell, no agent → null", () => {
    expect(classifySession({ rootArgv: "-zsh", childArgvs: [] })).toBeNull();
  });
});

describe("runtimeArgvMatches (liveness sub-predicate)", () => {
  it("codex pid still running codex → true", () => {
    expect(runtimeArgvMatches("codex", CODEX_CHILD)).toBe(true);
  });

  it("claude-code pid still running claude → true", () => {
    expect(runtimeArgvMatches("claude-code", CLAUDE_CHILD)).toBe(true);
  });

  it("a recycled pid now a bare shell → false for both runtimes", () => {
    expect(runtimeArgvMatches("codex", "-zsh")).toBe(false);
    expect(runtimeArgvMatches("claude-code", "-zsh")).toBe(false);
  });

  it("does not cross-match (codex argv is not a claude match, and vice versa)", () => {
    expect(runtimeArgvMatches("claude-code", CODEX_CHILD)).toBe(false);
    expect(runtimeArgvMatches("codex", CLAUDE_CHILD)).toBe(false);
  });
});
