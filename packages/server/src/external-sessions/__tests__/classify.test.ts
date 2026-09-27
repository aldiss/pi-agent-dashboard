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

/**
 * Identity comes from the program being run, never from argument text.
 *
 * Real argv observed on socket pi: pi is launched through node, either as its
 * npm bin or via the guarded pi-releases launcher. Both carry the model name
 * as an argument, so a model like `claude-opus-5` or `gpt-5.3-codex` used to
 * label a pi session as an external claude-code/codex session.
 */
const NODE_PI_ROOT =
  "/opt/homebrew/bin/node /opt/homebrew/bin/pi --name Portico-12 --provider github-copilot --model claude-opus-5 --thinking xhigh";
const GUARDED_PI_ROOT =
  "/opt/homebrew/bin/node /opt/homebrew/lib/pi-releases/guarded-18197-215-0871/candidate.mjs --name Portico-12 --session /x.jsonl --provider github-copilot --model claude-opus-5 --thinking xhigh";
const GUARDED_PI_CODEX_MODEL =
  "/opt/homebrew/bin/node /opt/homebrew/lib/pi-releases/guarded-18197-215-0871/baseline.mjs --name Worker --model gpt-5.3-codex";

describe("program identity, not argument text", () => {
  it("recognizes a node-launched pi as pi", () => {
    expect(isPiRootArgv(NODE_PI_ROOT)).toBe(true);
  });

  it("recognizes the guarded pi-releases launcher as pi", () => {
    expect(isPiRootArgv(GUARDED_PI_ROOT)).toBe(true);
    expect(isPiRootArgv(GUARDED_PI_CODEX_MODEL)).toBe(true);
  });

  it("a model name in the arguments never labels a session", () => {
    expect(classifyRuntime(["-zsh", "/some/tool --model claude-opus-5"])).toBeNull();
    expect(classifyRuntime(["-zsh", "node /x/runner.mjs --model gpt-5.3-codex"])).toBeNull();
  });

  it("a guarded pi pane is skipped, not reported as an external session", () => {
    expect(classifySession({ rootArgv: GUARDED_PI_ROOT, childArgvs: [] })).toBeNull();
    expect(classifySession({ rootArgv: GUARDED_PI_CODEX_MODEL, childArgvs: [] })).toBeNull();
  });

  it("a guarded pi pane with a headless claude child is still skipped (pi wins)", () => {
    expect(
      classifySession({ rootArgv: GUARDED_PI_ROOT, childArgvs: [HEADLESS_CLAUDE_CHILD] }),
    ).toBeNull();
  });

  it("liveness does not accept a pi process whose arguments mention a runtime", () => {
    expect(runtimeArgvMatches("claude-code", GUARDED_PI_ROOT)).toBe(false);
    expect(runtimeArgvMatches("codex", GUARDED_PI_CODEX_MODEL)).toBe(false);
  });

  it("still classifies real node-launched and pathed agents by their program", () => {
    expect(classifyRuntime(["-zsh", "node /opt/homebrew/bin/claude --effort max"])).toBe("claude-code");
    expect(classifyRuntime(["-zsh", "/opt/homebrew/bin/claude --output-format stream-json"])).toBe("claude-code");
    expect(classifyRuntime(["-zsh", "node --no-warnings /opt/homebrew/bin/codex --yolo"])).toBe("codex");
  });
});
