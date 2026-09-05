import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexSessionStore } from "../codex-session-store.js";

describe("Codex durable session and display history", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-store-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const session = { id: "codex-1234abcd", cwd: "/workspace", source: "dashboard" as const, runtime: "codex" as const,
    status: "streaming" as const, startedAt: 100, codexThreadId: "native-thread", codexThreadPath: "/native/rollout.jsonl", pid: 999, resuming: true };

  it("persists native identity immediately and restores a cold session without pi sessionFile", () => {
    const store = createCodexSessionStore(dir);
    store.save(session, true);
    expect(readFileSync(join(dir, `${session.id}.meta.json`), "utf8")).toContain("native-thread");
    store.dispose();
    const next = createCodexSessionStore(dir);
    expect(next.list()).toEqual([expect.objectContaining({ id: session.id, codexThreadId: "native-thread", runtime: "codex", status: "ended", resuming: false, currentTool: null })]);
    expect(next.list()[0].pid).toBeUndefined();
    expect(next.list()[0].sessionFile).toBeUndefined();
    next.dispose();
  });
  it("replays mapped events and closes an interrupted turn exactly once", () => {
    const store = createCodexSessionStore(dir);
    store.save(session, true);
    store.append(session.id, { eventType: "agent_start", timestamp: 1, data: {} });
    store.append(session.id, { eventType: "tool_execution_start", timestamp: 2, data: { toolCallId: "cmd", toolName: "bash", args: { command: "pwd" } } });
    store.append(session.id, { eventType: "message_update", timestamp: 3, data: { assistantMessageEvent: { type: "thinking_start" } } });
    const recovered = store.readEvents(session.id, true);
    expect(recovered.at(-1)).toMatchObject({ eventType: "agent_end", data: { messages: [{ stopReason: "error" }] } });
    expect(recovered.some(e => e.eventType === "tool_execution_end" && e.data.toolCallId === "cmd")).toBe(true);
    expect(recovered).toContainEqual(expect.objectContaining({ data: { assistantMessageEvent: { type: "thinking_end" } } }));
    expect(store.readEvents(session.id, true)).toEqual(recovered);
    store.dispose();
  });
  it("does not invent a restart error for completed history or a live partial replay", () => {
    const store = createCodexSessionStore(dir);
    store.save(session, true);
    store.append(session.id, { eventType: "agent_start", timestamp: 1, data: {} });
    expect(store.readEvents(session.id, false)).toHaveLength(1);
    store.append(session.id, { eventType: "agent_end", timestamp: 2, data: {} });
    expect(store.readEvents(session.id, true)).toHaveLength(2);
    store.dispose();
  });
  it("refuses path-shaped IDs", () => {
    const store = createCodexSessionStore(dir);
    expect(() => store.readEvents("../outside", true)).toThrow();
    expect(() => store.save({ ...session, id: "../outside" }, true)).toThrow();
    store.dispose();
  });
  it("keeps recovery records readable after a crash-truncated final line", () => {
    const store = createCodexSessionStore(dir);
    store.save(session, true);
    store.append(session.id, { eventType: "agent_start", timestamp: 1, data: {} });
    appendFileSync(join(dir, `${session.id}.jsonl`), '{"partial":');
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const recovered = store.readEvents(session.id, true);
      expect(recovered.at(-1)?.eventType).toBe("agent_end");
      clock.mockReturnValue(2000);
      expect(store.readEvents(session.id, true)).toEqual(recovered);
    } finally { clock.mockRestore(); store.dispose(); }
  });
});
