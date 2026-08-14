import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalSession } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import {
  createExternalSessionTranscriptReader,
  parseClaudeTranscript,
  parseCodexTranscript,
  pickNearestTranscript,
  readJsonlTail,
  listTranscriptCandidates,
} from "../transcript-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function session(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "claude-code:cc-one",
    runtime: "claude-code",
    tmuxSession: "cc-one",
    tmuxSocket: "pi",
    title: "cc-one",
    cwd: "/work/project",
    runtimePid: 101,
    state: "live",
    model: "Sonnet 4",
    effort: null,
    firstSeenAt: 1_000,
    lastLiveAt: 1_000,
    endedAt: null,
    output: "raw terminal fallback",
    outputAt: 1_000,
    outputChangedAt: null,
    lineCount: 1,
    ...overrides,
  };
}

function claudeUserRecord(text: string, id: string, timestamp = "2026-08-14T10:00:00.000Z") {
  return {
    uuid: id,
    timestamp,
    type: "user",
    message: { content: [{ type: "text", text }] },
  };
}

describe("parseClaudeTranscript", () => {
  it("normalizes messages, thinking, and correlated tool use/results in source order", () => {
    const parsed = parseClaudeTranscript([
      claudeUserRecord("Inspect the file", "user-1"),
      {
        uuid: "assistant-1",
        timestamp: "2026-08-14T10:00:01.000Z",
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "I should read it first." },
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/work/project/a.ts" },
            },
          ],
        },
      },
      {
        uuid: "result-1",
        timestamp: "2026-08-14T10:00:02.000Z",
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "export const value = 1;",
              is_error: false,
            },
          ],
        },
      },
    ]);

    expect(parsed.truncated).toBe(false);
    expect(parsed.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool_call",
      "tool_result",
    ]);
    expect(parsed.entries[0]).toMatchObject({
      id: expect.any(String),
      ts: Date.parse("2026-08-14T10:00:00.000Z"),
      kind: "user",
      text: "Inspect the file",
    });
    expect(parsed.entries[1]).toMatchObject({
      kind: "thinking",
      text: "I should read it first.",
    });
    expect(parsed.entries[2]).toMatchObject({
      kind: "assistant",
      text: "I will inspect it.",
    });
    expect(parsed.entries[3]).toMatchObject({
      kind: "tool_call",
      toolCallId: "tool-1",
      toolName: "Read",
      toolInput: { file_path: "/work/project/a.ts" },
    });
    expect(parsed.entries[4]).toMatchObject({
      kind: "tool_result",
      toolCallId: "tool-1",
      toolName: "Read",
      toolResult: "export const value = 1;",
      isError: false,
    });
  });

  it("returns the newest entries in order and marks an entry-cap truncation", () => {
    const parsed = parseClaudeTranscript(
      [
        claudeUserRecord("oldest", "u-1", "2026-08-14T10:00:00.000Z"),
        claudeUserRecord("middle", "u-2", "2026-08-14T10:00:01.000Z"),
        claudeUserRecord("newest", "u-3", "2026-08-14T10:00:02.000Z"),
      ],
      { maxEntries: 2 },
    );

    expect(parsed.truncated).toBe(true);
    expect(parsed.entries.map((entry) => entry.text)).toEqual(["middle", "newest"]);
  });

  it("caps a tool result by UTF-8 bytes without splitting a code point and adds an explicit marker", () => {
    const parsed = parseClaudeTranscript(
      [
        {
          uuid: "call",
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "tool-unicode", name: "Read", input: {} }],
          },
        },
        {
          uuid: "result",
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-unicode",
                content: "éééééééééééééééééééé",
              },
            ],
          },
        },
      ],
      { maxToolResultBytes: 24 },
    );

    const marker = "… truncated";
    const rendered = String(parsed.entries.find((entry) => entry.kind === "tool_result")?.toolResult);
    expect(parsed.truncated).toBe(true);
    expect(rendered.endsWith(marker)).toBe(true);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(24);
    const retained = rendered.slice(0, -marker.length);
    expect(retained).not.toContain("�");
  });
});

describe("parseCodexTranscript", () => {
  it("normalizes messages, reasoning, both call families, patch results, and statuses", () => {
    const parsed = parseCodexTranscript([
      {
        timestamp: "2026-08-14T11:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Run the checks" },
      },
      {
        timestamp: "2026-08-14T11:00:01.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "First inspect the repository." }],
        },
      },
      {
        timestamp: "2026-08-14T11:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "function-1",
          name: "exec_command",
          arguments: '{"cmd":"npm test"}',
        },
      },
      {
        timestamp: "2026-08-14T11:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "function-1",
          output: "12 tests passed",
        },
      },
      {
        timestamp: "2026-08-14T11:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "custom-1",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
      },
      {
        timestamp: "2026-08-14T11:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "custom-1",
          output: "Done!",
        },
      },
      {
        timestamp: "2026-08-14T11:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "patch-1",
          stdout: "Applied cleanly",
          success: true,
        },
      },
      {
        timestamp: "2026-08-14T11:00:07.000Z",
        type: "event_msg",
        payload: { type: "task_started", message: "Task started" },
      },
      {
        timestamp: "2026-08-14T11:00:08.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "All checks pass." },
      },
      {
        timestamp: "2026-08-14T11:00:09.000Z",
        type: "event_msg",
        payload: { type: "task_complete", message: "Task complete" },
      },
      {
        timestamp: "2026-08-14T11:00:10.000Z",
        type: "event_msg",
        payload: { type: "token_count", input_tokens: 100, output_tokens: 50 },
      },
    ]);

    expect(parsed.truncated).toBe(false);
    expect(parsed.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_result",
      "status",
      "assistant",
      "status",
    ]);
    expect(parsed.entries[0]).toMatchObject({ kind: "user", text: "Run the checks" });
    expect(parsed.entries[1]).toMatchObject({
      kind: "thinking",
      text: "First inspect the repository.",
    });
    expect(parsed.entries.find((entry) => entry.toolCallId === "function-1" && entry.kind === "tool_call"))
      .toMatchObject({
        toolName: "exec_command",
        toolInput: { cmd: "npm test" },
      });
    expect(parsed.entries.find((entry) => entry.toolCallId === "function-1" && entry.kind === "tool_result"))
      .toMatchObject({
        toolName: "exec_command",
        toolResult: "12 tests passed",
        isError: false,
      });
    expect(parsed.entries.find((entry) => entry.toolCallId === "custom-1" && entry.kind === "tool_call"))
      .toMatchObject({
        toolName: "apply_patch",
        toolInput: "*** Begin Patch",
      });
    expect(parsed.entries.find((entry) => entry.toolCallId === "custom-1" && entry.kind === "tool_result"))
      .toMatchObject({
        toolName: "apply_patch",
        toolResult: "Done!",
      });
    expect(parsed.entries.find((entry) => entry.toolCallId === "patch-1")).toMatchObject({
      kind: "tool_result",
      toolName: "apply_patch",
      toolResult: "Applied cleanly",
      isError: false,
    });
    expect(parsed.entries.filter((entry) => entry.kind === "status").map((entry) => entry.text))
      .toEqual(["Task started", "Task complete"]);
    expect(parsed.entries.some((entry) => entry.text?.includes("token"))).toBe(false);
  });

  it("renders textual message blocks without leaking encrypted content", () => {
    const parsed = parseCodexTranscript([
      {
        timestamp: "2026-08-14T11:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: [
            { type: "output_text", text: "Visible answer" },
            { type: "encrypted_content", encrypted_content: "ciphertext" },
          ],
        },
      },
    ]);

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.text).toBe("Visible answer");
    expect(parsed.entries[0]?.text).not.toContain("ciphertext");
  });

  it("keeps generated entry ids stable when the physical tail window slides", () => {
    const retained = {
      timestamp: "2026-08-14T11:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Retained answer" },
    };
    const first = parseCodexTranscript([
      {
        timestamp: "2026-08-14T11:00:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Dropped answer" },
      },
      retained,
    ]);
    const slid = parseCodexTranscript([retained]);

    expect(first.entries[1]?.id).toBe(slid.entries[0]?.id);
  });

  it("keeps the newest entries within an aggregate response-byte budget", () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      timestamp: `2026-08-14T11:00:${String(index).padStart(2, "0")}.000Z`,
      type: "event_msg",
      payload: { type: "agent_message", message: `${index}:${"x".repeat(80)}` },
    }));
    const parsed = parseCodexTranscript(records, {
      maxEntries: 20,
      maxResponseBytes: 350,
    });

    expect(parsed.truncated).toBe(true);
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(parsed.entries.at(-1)?.text).toContain("9:");
    expect(Buffer.byteLength(JSON.stringify(parsed.entries), "utf8")).toBeLessThanOrEqual(350);
  });
});

describe("listTranscriptCandidates", () => {
  it("does not admit nested Claude subagent transcripts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-dashboard-claude-candidates-"));
    tempDirs.push(root);
    const nested = path.join(root, "subagents");
    await mkdir(nested);
    const mainPath = path.join(root, "main.jsonl");
    await writeFile(mainPath, "{}\n", "utf8");
    await writeFile(path.join(nested, "agent.jsonl"), "{}\n", "utf8");

    const candidates = await listTranscriptCandidates(root, "claude-code");

    expect(candidates.map((candidate) => candidate.path)).toEqual([mainPath]);
  });
});

describe("pickNearestTranscript", () => {
  it("selects the nearest birth time at or after process start, never the newest file", () => {
    expect(
      pickNearestTranscript(
        [
          { path: "/transcripts/before.jsonl", birthtimeMs: 900 },
          { path: "/transcripts/right.jsonl", birthtimeMs: 1_005 },
          { path: "/transcripts/newest.jsonl", birthtimeMs: 9_000 },
        ],
        1_000,
      ),
    ).toBe("/transcripts/right.jsonl");
  });

  it("returns null when no transcript was born at or after process start", () => {
    expect(
      pickNearestTranscript([{ path: "/transcripts/old.jsonl", birthtimeMs: 999 }], 1_000),
    ).toBeNull();
  });
});

describe("createExternalSessionTranscriptReader", () => {
  it("maps two Claude sessions in one cwd to distinct files using each pid start time", async () => {
    const home = "/home/tester";
    const root = path.join(home, ".claude", "projects", "-work-project");
    const firstPath = path.join(root, "first.jsonl");
    const secondPath = path.join(root, "second.jsonl");
    const roots: Array<[string, string]> = [];
    const reader = createExternalSessionTranscriptReader({
      homedir: () => home,
      readProcessInfo: (pid) => ({
        startTimeMs: pid === 101 ? 1_000 : 2_000,
        env: {},
      }),
      listCandidates: async (candidateRoot, runtime) => {
        roots.push([candidateRoot, runtime]);
        return [
          { path: firstPath, birthtimeMs: 1_050 },
          { path: secondPath, birthtimeMs: 2_050 },
        ];
      },
      pathExists: async () => true,
      readTail: async (transcriptPath) => ({
        records: [claudeUserRecord(transcriptPath === firstPath ? "first pane" : "second pane", transcriptPath)],
        truncated: false,
      }),
    });

    const first = await reader.read(session());
    const second = await reader.read(
      session({ id: "claude-code:cc-two", tmuxSession: "cc-two", runtimePid: 202 }),
    );

    expect(first).toMatchObject({
      source: "claude-code",
      transcriptPath: firstPath,
      truncated: false,
    });
    expect(first.entries.map((entry) => entry.text)).toEqual(["first pane"]);
    expect(second).toMatchObject({
      source: "claude-code",
      transcriptPath: secondPath,
      truncated: false,
    });
    expect(second.entries.map((entry) => entry.text)).toEqual(["second pane"]);
    expect(roots).toEqual([
      [root, "claude-code"],
      [root, "claude-code"],
    ]);
  });

  it("uses CODEX_HOME from the runtime environment", async () => {
    const codexHome = "/tmp/codex-launch-home-cx-one";
    const transcriptPath = path.join(codexHome, "sessions", "2026", "08", "14", "rollout.jsonl");
    const listCandidates = vi.fn(async () => [{ path: transcriptPath, birthtimeMs: 1_010 }]);
    const reader = createExternalSessionTranscriptReader({
      homedir: () => "/home/tester",
      readProcessInfo: () => ({ startTimeMs: 1_000, env: { CODEX_HOME: codexHome } }),
      listCandidates,
      pathExists: async () => true,
      readTail: async () => ({
        records: [
          {
            type: "event_msg",
            payload: { type: "agent_message", message: "Codex transcript" },
          },
        ],
        truncated: false,
      }),
    });

    const response = await reader.read(
      session({
        id: "codex:cx-one",
        runtime: "codex",
        tmuxSession: "cx-one",
        runtimePid: 303,
      }),
    );

    expect(listCandidates).toHaveBeenCalledWith(path.join(codexHome, "sessions"), "codex");
    expect(response).toMatchObject({ source: "codex", transcriptPath });
    expect(response.entries[0]).toMatchObject({ kind: "assistant", text: "Codex transcript" });
  });

  it("reuses a cached location for the same pid, then re-resolves on pid change or disappearance", async () => {
    const oldPath = "/home/tester/.claude/projects/-work-project/old.jsonl";
    const newPidPath = "/home/tester/.claude/projects/-work-project/new-pid.jsonl";
    const replacementPath = "/home/tester/.claude/projects/-work-project/replacement.jsonl";
    let candidates = [{ path: oldPath, birthtimeMs: 1_010 }];
    const existing = new Set([oldPath, newPidPath, replacementPath]);
    const listCandidates = vi.fn(async () => candidates);
    const reader = createExternalSessionTranscriptReader({
      homedir: () => "/home/tester",
      readProcessInfo: (pid) => ({ startTimeMs: pid === 101 ? 1_000 : 2_000, env: {} }),
      listCandidates,
      pathExists: async (transcriptPath) => existing.has(transcriptPath),
      readTail: async (transcriptPath) => ({
        records: [claudeUserRecord(transcriptPath, transcriptPath)],
        truncated: false,
      }),
    });

    await reader.read(session());
    await reader.read(session());
    expect(listCandidates).toHaveBeenCalledTimes(1);

    candidates = [{ path: newPidPath, birthtimeMs: 2_010 }];
    const afterPidChange = await reader.read(session({ runtimePid: 202 }));
    expect(afterPidChange.transcriptPath).toBe(newPidPath);
    expect(listCandidates).toHaveBeenCalledTimes(2);

    existing.delete(newPidPath);
    candidates = [{ path: replacementPath, birthtimeMs: 2_020 }];
    const afterDisappearance = await reader.read(session({ runtimePid: 202 }));
    expect(afterDisappearance.transcriptPath).toBe(replacementPath);
    expect(listCandidates).toHaveBeenCalledTimes(3);
  });

  it("returns an explicit capture fallback with no blank transcript when location fails", async () => {
    const listCandidates = vi.fn();
    const reader = createExternalSessionTranscriptReader({
      homedir: () => "/home/tester",
      readProcessInfo: () => null,
      listCandidates,
      pathExists: async () => false,
      readTail: vi.fn(),
    });

    const response = await reader.read(session());

    expect(response).toMatchObject({
      id: "claude-code:cc-one",
      source: "capture",
      entries: [],
      truncated: false,
    });
    expect(response).not.toHaveProperty("transcriptPath");
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it("freezes the last parsed transcript after a session ends", async () => {
    const transcriptPath = "/home/tester/.claude/projects/-work-project/one.jsonl";
    let text = "last live transcript";
    const readTail = vi.fn(async () => ({
      records: [claudeUserRecord(text, text)],
      truncated: false,
    }));
    const reader = createExternalSessionTranscriptReader({
      homedir: () => "/home/tester",
      readProcessInfo: () => ({ startTimeMs: 1_000, env: {} }),
      listCandidates: async () => [{ path: transcriptPath, birthtimeMs: 1_010 }],
      pathExists: async () => true,
      readTail,
    });

    const live = await reader.read(session());
    text = "must not replace frozen transcript";
    const ended = await reader.read(
      session({ state: "ended", endedAt: 2_000, lastLiveAt: 1_500 }),
    );

    expect(live.entries[0]?.text).toBe("last live transcript");
    expect(ended.entries[0]?.text).toBe("last live transcript");
    expect(readTail).toHaveBeenCalledTimes(1);
  });

  it("opens a retained ended session from a location primed while its pid was live", async () => {
    const transcriptPath = "/home/tester/.claude/projects/-work-project/one.jsonl";
    let processAvailable = true;
    const readProcessInfo = vi.fn(() => processAvailable
      ? { startTimeMs: 1_000, env: {} }
      : null);
    const reader = createExternalSessionTranscriptReader({
      homedir: () => "/home/tester",
      readProcessInfo,
      listCandidates: async () => [{ path: transcriptPath, birthtimeMs: 1_010 }],
      pathExists: async () => true,
      readTail: async () => ({
        records: [claudeUserRecord("ended transcript", "ended")],
        truncated: false,
      }),
    });

    await reader.prime([session()]);
    processAvailable = false;
    const response = await reader.read(session({ state: "ended", endedAt: 2_000 }));

    expect(response.source).toBe("claude-code");
    expect(response.entries[0]?.text).toBe("ended transcript");
    expect(readProcessInfo).toHaveBeenCalledTimes(1);
  });
});

describe("readJsonlTail read-only behavior", () => {
  it("returns only newest complete rows when byte and record limits cut the head", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-dashboard-transcript-tail-"));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, "session.jsonl");
    const newest = JSON.stringify(claudeUserRecord("newest", "newest"));
    await writeFile(
      transcriptPath,
      `${JSON.stringify(claudeUserRecord("x".repeat(2_000), "old"))}\n${newest}\n`,
      "utf8",
    );

    const tail = await readJsonlTail(transcriptPath, {
      maxReadBytes: Buffer.byteLength(newest, "utf8") + 1,
      maxRecords: 1,
    });

    expect(tail.truncated).toBe(true);
    expect(tail.records).toEqual([claudeUserRecord("newest", "newest")]);
  });

  it("repeatedly reads a real transcript without changing its mtime or size", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-dashboard-transcript-reader-"));
    tempDirs.push(dir);
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify(claudeUserRecord("one", "one")),
        JSON.stringify(claudeUserRecord("two", "two")),
        "",
      ].join("\n"),
      "utf8",
    );
    const before = await stat(transcriptPath);

    const first = await readJsonlTail(transcriptPath, { maxReadBytes: 4_096 });
    const second = await readJsonlTail(transcriptPath, { maxReadBytes: 4_096 });
    const after = await stat(transcriptPath);

    expect(first.records).toHaveLength(2);
    expect(second.records).toEqual(first.records);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
