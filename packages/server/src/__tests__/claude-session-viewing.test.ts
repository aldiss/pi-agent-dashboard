/**
 * Tests for Claude-Code session viewing: the CC cwd encoder, the byte-bounded
 * transcript adapter (CC Anthropic shape → pi replay entries), and discovery
 * resolving a fixture ~/.claude/projects dir. Uses a temp-dir fixture; never
 * touches the real ~/.claude.
 *
 * See change: add-claude-code-session-viewing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { encodeClaudeCwd, deriveClaudeHeader } from "../claude-session-discovery.js";
import {
  claudeRecordsToReplayEntries,
  isClaudeSessionFile,
  loadClaudeSessionEntries,
  loadClaudeSessionWindow,
  CLAUDE_WINDOW,
  parseLines,
  extractText,
  claudeProjectsRoot,
} from "../claude-transcript-reader.js";

describe("encodeClaudeCwd", () => {
  it("replaces / and . with - and does not wrap (CC scheme, distinct from pi)", () => {
    expect(encodeClaudeCwd("/Users/vdrobkov/.pi/orchestration-state")).toBe(
      "-Users-vdrobkov--pi-orchestration-state",
    );
  });
  it("handles a plain path with no dots", () => {
    expect(encodeClaudeCwd("/Users/u/Copilot/living-comic")).toBe("-Users-u-Copilot-living-comic");
  });
  it("differs from the pi encoder (no --…-- wrap, dots replaced)", () => {
    const enc = encodeClaudeCwd("/a/.b");
    expect(enc.startsWith("--")).toBe(false);
    expect(enc).toBe("-a--b");
  });
});

describe("claudeRecordsToReplayEntries (the CC → pi adapter)", () => {
  it("maps an assistant tool_use block to a pi toolCall block + model_change", () => {
    const recs = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-20T10:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4.8",
          content: [
            { type: "text", text: "Let me read it." },
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/x/brief.md" } },
          ],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        },
      },
    ];
    const out = claudeRecordsToReplayEntries(recs);
    // first: model_change
    expect(out[0]).toMatchObject({ type: "model_change", modelId: "claude-opus-4.8" });
    // then: a pi message with toolCall (NOT tool_use) + text
    const msg = out[1];
    expect(msg.type).toBe("message");
    expect(msg.message.role).toBe("assistant");
    const blocks = msg.message.content;
    expect(blocks[0]).toEqual({ type: "text", text: "Let me read it." });
    expect(blocks[1]).toMatchObject({ type: "toolCall", id: "tu_1", name: "Read", arguments: { path: "/x/brief.md" } });
    expect(msg.message.usage).toMatchObject({ input: 100, output: 20, cacheRead: 5 });
  });

  it("folds a user tool_result block into a pi toolResult entry, resolving toolName from the prior tool_use", () => {
    const recs = [
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          model: "claude-opus-4.8",
          content: [{ type: "tool_use", id: "tu_42", name: "Bash", input: { cmd: "ls" } }],
        },
      },
      {
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_42", content: "file-a\nfile-b", is_error: false }],
        },
      },
    ];
    const out = claudeRecordsToReplayEntries(recs);
    const tr = out.find((e) => e.message?.role === "toolResult");
    expect(tr).toBeTruthy();
    expect(tr.message.toolCallId).toBe("tu_42");
    expect(tr.message.toolName).toBe("Bash"); // resolved from the earlier tool_use
    expect(tr.message.isError).toBe(false);
    expect(tr.message.content[0]).toMatchObject({ type: "text", text: "file-a\nfile-b" });
  });

  it("maps a plain-string user message to a pi user message", () => {
    const recs = [{ type: "user", uuid: "u1", message: { role: "user", content: "hello there" } }];
    const out = claudeRecordsToReplayEntries(recs);
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatchObject({ role: "user", content: "hello there" });
  });

  it("names-not-dumps bulky CC-only events (attachment / file-history-snapshot / mode)", () => {
    const recs = [
      { type: "mode", mode: "default", sessionId: "s" },
      { type: "attachment", uuid: "x", attachment: { huge: "x".repeat(1000) } },
      { type: "file-history-snapshot", uuid: "y", snapshot: { big: "y".repeat(1000) } },
      { type: "permission-mode", permissionMode: "bypass" },
    ];
    const out = claudeRecordsToReplayEntries(recs);
    expect(out).toHaveLength(0); // all skipped — bytes never enter the transcript
  });

  it("emits model_change only once across multiple assistant turns of the same model", () => {
    const a = (uuid: string) => ({
      type: "assistant",
      uuid,
      message: { role: "assistant", model: "claude-opus-4.8", content: [{ type: "text", text: "x" }] },
    });
    const out = claudeRecordsToReplayEntries([a("1"), a("2"), a("3")]);
    expect(out.filter((e) => e.type === "model_change")).toHaveLength(1);
  });
});

describe("extractText", () => {
  it("returns a plain string as-is", () => {
    expect(extractText("hi")).toBe("hi");
  });
  it("returns the first text block from an Anthropic array", () => {
    expect(extractText([{ type: "tool_use", id: "t", name: "X" }, { type: "text", text: "found" }])).toBe("found");
  });
  it("returns null for non-text content", () => {
    expect(extractText([{ type: "tool_use", id: "t", name: "X" }])).toBeNull();
  });
});

describe("isClaudeSessionFile (path guard)", () => {
  it("accepts a path under ~/.claude/projects", () => {
    const p = join(claudeProjectsRoot(), "-Users-u-proj", "abc.jsonl");
    expect(isClaudeSessionFile(p)).toBe(true);
  });
  it("rejects a pi session path", () => {
    expect(isClaudeSessionFile(join(os.homedir(), ".pi", "agent", "sessions", "x", "y.jsonl"))).toBe(false);
  });
  it("rejects a .. traversal escape", () => {
    const p = join(claudeProjectsRoot(), "..", "..", "etc", "passwd");
    expect(isClaudeSessionFile(p)).toBe(false);
  });
});

describe("loadClaudeSessionEntries + discovery (temp fixture, never touches real ~/.claude)", () => {
  let tmp: string;
  let projectsRoot: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(os.tmpdir(), "cc-view-test-"));
    // Point HOME at the temp dir so claudeProjectsRoot() resolves under it.
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    projectsRoot = join(tmp, ".claude", "projects");
    mkdirSync(projectsRoot, { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeCcLog(projEnc: string, id: string, lines: object[], mtime?: number): string {
    const dir = join(projectsRoot, projEnc);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    if (mtime !== undefined) utimesSync(p, mtime / 1000, mtime / 1000);
    return p;
  }

  it("loadClaudeSessionEntries reads a fixture CC log byte-bounded and adapts it", async () => {
    // claudeProjectsRoot reads homedir() which caches os.homedir? It reads process.env.HOME on posix.
    const { discoverClaudeSessionsForCwd } = await import("../claude-session-discovery.js");
    const enc = encodeClaudeCwd("/work/proj");
    const p = writeCcLog(enc, "sess-1", [
      { type: "mode", mode: "default", sessionId: "sess-1" },
      { type: "user", uuid: "u1", timestamp: "2026-06-20T10:00:00.000Z", cwd: "/work/proj", message: { role: "user", content: "do the thing" } },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-20T10:00:01.000Z",
        message: { role: "assistant", model: "claude-opus-4.8", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/x" } }] },
      },
      { type: "user", uuid: "u2", timestamp: "2026-06-20T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
    ]);
    const entries = loadClaudeSessionEntries(p);
    // user msg + model_change + assistant msg + toolResult
    expect(entries.some((e) => e.type === "model_change")).toBe(true);
    expect(entries.some((e) => e.message?.role === "user")).toBe(true);
    expect(entries.some((e) => e.message?.role === "toolResult" && e.message.toolName === "Read")).toBe(true);

    // discovery resolves it
    const found = discoverClaudeSessionsForCwd("/work/proj");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "sess-1", source: "claude-code", cwd: "/work/proj" });
    expect(found[0].name).toBe("do the thing"); // first user message as title
  });

  it("caps firstMessage at 200 chars in the header (Track 1, Fix 1)", () => {
    // A CC first user turn can be a 30 KB paste; deriveClaudeHeader must cap it.
    const enc = encodeClaudeCwd("/work/bigmsg");
    const bigText = "X".repeat(5000); // >1 KB
    const p = writeCcLog(enc, "sess-big", [
      { type: "user", uuid: "u1", cwd: "/work/bigmsg", message: { role: "user", content: bigText } },
    ]);
    const header = deriveClaudeHeader(p, enc);
    expect(header.firstMessage).toBeDefined();
    expect(header.firstMessage!.length).toBeLessThanOrEqual(200);
  });

  it("omits firstMessage from the discovered session DTO (Track 1, Fix 2)", async () => {
    // The list DTO must not carry firstMessage at all — it was ~91% of the
    // /api/sessions payload. The card renders `name` (always set for CC).
    const { discoverClaudeSessionsForCwd } = await import("../claude-session-discovery.js");
    const enc = encodeClaudeCwd("/work/nofm");
    writeCcLog(enc, "sess-nofm", [
      { type: "user", uuid: "u1", cwd: "/work/nofm", message: { role: "user", content: "x".repeat(2000) } },
    ]);
    const found = discoverClaudeSessionsForCwd("/work/nofm");
    expect(found).toHaveLength(1);
    expect(found[0].firstMessage).toBeUndefined();
    expect(found[0].name).toBeTruthy(); // name still derived → client display unaffected
  });

  it("discovery sorts newest-mtime first within a project dir", async () => {
    const { discoverClaudeSessionsForCwd } = await import("../claude-session-discovery.js");
    const enc = encodeClaudeCwd("/work/multi");
    const older = writeCcLog(enc, "old", [{ type: "user", message: { role: "user", content: "old one" } }], Date.now() - 100_000);
    const newer = writeCcLog(enc, "new", [{ type: "user", message: { role: "user", content: "new one" } }], Date.now());
    expect(older).toBeTruthy();
    expect(newer).toBeTruthy();
    const found = discoverClaudeSessionsForCwd("/work/multi");
    expect(found.map((s) => s.id)).toEqual(["new", "old"]); // newest first
  });

  it("parseLines drops the partial first line of a tail window", () => {
    const blob = `{"partial":`.concat("\n", JSON.stringify({ type: "user", message: { role: "user", content: "full" } }));
    const recs = parseLines(blob, { dropFirst: true });
    expect(recs).toHaveLength(1);
    expect(recs[0].message.content).toBe("full");
  });

  it("loadClaudeSessionWindow walks a >512 KB log backward to atStart, never whole-reading (Track 2, Fix A)", () => {
    // Build a CC log well over 2 windows (CLAUDE_WINDOW = 256 KB). Each line is
    // a distinct user turn with a sequence-tagged body so we can assert the
    // backward walk reaches the earliest turn and terminates at byte 0.
    const enc = encodeClaudeCwd("/work/bigpager");
    const lines: object[] = [];
    const PAD = "y".repeat(1024); // ~1 KB/line → ~700+ lines to exceed 512 KB
    for (let i = 0; i < 700; i++) {
      lines.push({ type: "user", uuid: `u${i}`, cwd: "/work/bigpager", message: { role: "user", content: `turn-${i} ${PAD}` } });
    }
    const p = writeCcLog(enc, "sess-pager", lines);
    const size = statSync(p).size;
    expect(size).toBeGreaterThan(512 * 1024);

    // Walk backward from EOF. Each window must read at most CLAUDE_WINDOW bytes,
    // the cursor must strictly decrease, and it must terminate at atStart with
    // nextBeforeOffset === 0 — without ever reading the whole file in one call.
    let before = size;
    let windows = 0;
    let sawAtStart = false;
    let totalEntries = 0;
    const cursors: number[] = [];
    while (windows < 50) {
      const res = loadClaudeSessionWindow(p, before, CLAUDE_WINDOW);
      windows++;
      totalEntries += res.entries.length;
      cursors.push(res.nextBeforeOffset);
      // The window covered at most CLAUDE_WINDOW bytes.
      expect(before - res.nextBeforeOffset).toBeLessThanOrEqual(CLAUDE_WINDOW);
      if (res.atStart) {
        sawAtStart = true;
        expect(res.nextBeforeOffset).toBe(0);
        break;
      }
      // Cursor must strictly decrease so the walk terminates.
      expect(res.nextBeforeOffset).toBeLessThan(before);
      before = res.nextBeforeOffset;
    }
    expect(sawAtStart).toBe(true);
    expect(windows).toBeGreaterThanOrEqual(3); // >512 KB / 256 KB ⇒ at least 3 windows
    expect(totalEntries).toBeGreaterThan(0);
    // Cursors strictly descend to 0.
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]).toBeLessThan(cursors[i - 1]);
    }

    // The earliest window (atStart) must contain turn-0; the tail window must
    // contain the last turn — proving the walk spans head-to-tail.
    const head = loadClaudeSessionWindow(p, CLAUDE_WINDOW, CLAUDE_WINDOW);
    expect(head.atStart).toBe(true);
    const headTexts = head.entries.map((e) => e.message?.content ?? "");
    expect(headTexts.some((t: string) => t.startsWith("turn-0 "))).toBe(true);

    const tail = loadClaudeSessionWindow(p, size, CLAUDE_WINDOW);
    expect(tail.atStart).toBe(false);
    const tailTexts = tail.entries.map((e) => e.message?.content ?? "");
    expect(tailTexts.some((t: string) => t.startsWith("turn-699 "))).toBe(true);
  });

  it("loadClaudeSessionEntries base window is tail-only for big files (Track 2, Fix A)", () => {
    // The cold-load base must be the TAIL (recent turns), so the pager can
    // prepend earlier windows coherently above it.
    const enc = encodeClaudeCwd("/work/tailbase");
    const lines: object[] = [];
    const PAD = "z".repeat(1024);
    for (let i = 0; i < 700; i++) {
      lines.push({ type: "user", uuid: `t${i}`, cwd: "/work/tailbase", message: { role: "user", content: `turn-${i} ${PAD}` } });
    }
    const p = writeCcLog(enc, "sess-tailbase", lines);
    expect(statSync(p).size).toBeGreaterThan(512 * 1024);
    const entries = loadClaudeSessionEntries(p);
    const texts = entries.map((e) => e.message?.content ?? "");
    // Tail present, earliest turn absent (it lives in an earlier window).
    expect(texts.some((t: string) => t.startsWith("turn-699 "))).toBe(true);
    expect(texts.some((t: string) => t.startsWith("turn-0 "))).toBe(false);
  });
});
