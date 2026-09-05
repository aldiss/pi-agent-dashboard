import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { isProcessAlive } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { createCodexAdapter } from "../codex-adapter.js";
import type { CodexAdapter, RuntimeEvent } from "../types.js";

it.skipIf(process.env.PI_CODEX_LIVE_TEST !== "1")("real app-server: tool, retained second turn, interrupt, native cold resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-live-workspace-"));
  const code = `cedar-${randomUUID()}`;
  const events: RuntimeEvent[] = [];
  const config = { enabled: true, model: process.env.PI_CODEX_TEST_MODEL ?? "gpt-6-astra",
    baseUrl: process.env.PI_CODEX_TEST_BASE_URL ?? "http://127.0.0.1:4143/v1", envKey: "OPENAI_API_KEY", reasoningEffort: "low" };
  let adapter: CodexAdapter | undefined;
  const create = (threadId?: string) => createCodexAdapter({ cwd, config, threadId,
    onProcess: () => {}, onThread: () => {}, onEvent: event => events.push(event), onExit: () => {} });
  const waitFor = async (predicate: () => boolean, timeout = 60_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for live Codex event");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const completeTurn = async (text: string) => {
    const start = events.length;
    await adapter!.send({ text });
    await waitFor(() => events.slice(start).some(e => e.eventType === "agent_end"));
    const turn = events.slice(start);
    const end = turn.find(e => e.eventType === "agent_end")!;
    expect(end.data.messages?.some((m: any) => m.stopReason === "error"), JSON.stringify(end.data)).not.toBe(true);
    return turn;
  };
  const assistantText = (turn: RuntimeEvent[]) => turn.filter(e => e.eventType === "message_end" && e.data.message?.role === "assistant")
    .flatMap(e => e.data.message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try {
    adapter = await create();
    const firstPid = adapter.pid;
    const threadId = adapter.threadId;
    const first = await completeTurn(`Run pwd once using the command tool. Remember verification code ${code} for later turns, then reply SAVED.`);
    expect(first.some(e => e.eventType === "tool_execution_start")).toBe(true);
    expect(first.some(e => e.eventType === "tool_execution_end")).toBe(true);
    expect(first.some(e => e.eventType === "tool_execution_end" && !e.data.isError && String(e.data.result).includes(basename(cwd)))).toBe(true);
    expect(first.some(e => e.eventType === "message_update" && e.data.message?.content?.some((b: any) => b.type === "text" && b.text))).toBe(true);
    expect(assistantText(first)).toContain("SAVED");
    const second = await completeTurn("Reply only with the verification code I asked you to remember in the previous turn. Do not use tools.");
    expect(assistantText(second)).toContain(code);
    console.info(JSON.stringify({ liveCheck: "tool-and-two-turn-context", pass: true, threadId, pid: firstPid }));

    const abortStart = events.length;
    await adapter.send({ text: "Use the command tool to run sleep 20, then reply DONE. Do not skip the command." });
    await waitFor(() => events.slice(abortStart).some(e => e.eventType === "tool_execution_start" && String(e.data.args?.command).includes("sleep")));
    expect(adapter.isStreaming()).toBe(true);
    await adapter.abort();
    expect(adapter.isStreaming()).toBe(false);
    expect(events.slice(abortStart).some(e => e.eventType === "agent_end")).toBe(true);
    const interrupted = events.slice(abortStart);
    for (const start of interrupted.filter(e => e.eventType === "tool_execution_start")) {
      expect(interrupted.some(e => e.eventType === "tool_execution_end" && e.data.toolCallId === start.data.toolCallId)).toBe(true);
    }
    console.info(JSON.stringify({ liveCheck: "mid-tool-interrupt", pass: true, threadId }));

    await adapter.dispose();
    if (firstPid) expect(isProcessAlive(firstPid)).toBe(false);
    adapter = await create(threadId);
    expect(adapter.pid).not.toBe(firstPid);
    expect(adapter.threadId).toBe(threadId);
    const resumed = await completeTurn("Reply only with the verification code I asked you to remember earlier. Do not use tools.");
    expect(assistantText(resumed)).toContain(code);
    const resumedPid = adapter.pid;
    await adapter.dispose();
    adapter = undefined;
    if (resumedPid) expect(isProcessAlive(resumedPid)).toBe(false);
    const evidence = { pass: true, threadId, firstPid, resumedPid, pwdOutputVerified: true, retainedSecondTurnContext: true,
      interruptedDuringTool: true, allInterruptedToolsClosed: true, retainedColdResumeContext: true, bothChildrenExited: true,
      firstTurnTextSnapshots: first.filter(e => e.eventType === "message_update" && e.data.message?.role === "assistant").length };
    if (process.env.PI_CODEX_LIVE_EVIDENCE) writeFileSync(process.env.PI_CODEX_LIVE_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.info(JSON.stringify(evidence));
  } finally {
    await adapter?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 240_000);
