import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DashboardEvent, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { readSessionMeta, writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { createMetaPersistence } from "../meta-persistence.js";

/** Display journal stays separate from Codex's native thread rollout. */
export function createCodexSessionStore(directory = join(homedir(), ".pi", "dashboard", "codex-sessions")) {
  const persistence = createMetaPersistence();
  const eventFile = (id: string) => {
    if (!/^codex-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid Codex session id");
    return join(directory, `${id}.jsonl`);
  };
  const append = (id: string, event: DashboardEvent) => {
    const file = eventFile(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Leading separator also isolates a crash-truncated final record.
    appendFileSync(file, "\n" + JSON.stringify(event) + "\n", { mode: 0o600 });
  };
  return {
    save(session: DashboardSession, immediate = false) {
      const file = eventFile(session.id);
      if (session.runtime !== "codex" || !session.codexThreadId) throw new Error("Missing Codex thread identity");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const meta = { ...session, pid: undefined, sessionFile: undefined, contextTokens: session.contextTokens ?? undefined };
      if (immediate) writeSessionMeta(file, meta);
      else persistence.save(file, meta);
    },
    list(): DashboardSession[] {
      if (!existsSync(directory)) return [];
      return readdirSync(directory).flatMap<DashboardSession>(file => {
        if (!/^codex-[a-zA-Z0-9-]+\.meta\.json$/.test(file)) return [];
        const id = file.slice(0, -".meta.json".length);
        const meta = readSessionMeta(eventFile(id));
        if (meta?.runtime !== "codex" || !meta.codexThreadId || typeof meta.cwd !== "string" || !isAbsolute(meta.cwd)) return [];
        return [{ ...meta, id, runtime: "codex", source: "dashboard", cwd: meta.cwd,
          startedAt: meta.startedAt ?? Date.now(), status: "ended", endedAt: meta.endedAt ?? Date.now(),
          pid: undefined, resuming: false, currentTool: null, dataUnavailable: false }];
      });
    },
    append,
    readEvents(id: string, recoverInterrupted = false): DashboardEvent[] {
      const file = eventFile(id);
      if (!existsSync(file)) return [];
      const events: DashboardEvent[] = [];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.eventType === "string" && typeof event.timestamp === "number" && event.data) events.push(event);
        } catch { /* Crash may leave the final journal line incomplete. */ }
      }
      if (!recoverInterrupted) return events;
      const tools = new Set<string>();
      let active = false;
      let assistant: any;
      let thinking = false;
      for (const event of events) {
        const data = event.data as { toolCallId?: string; message?: { role?: string }; assistantMessageEvent?: { type?: string } };
        if (event.eventType === "agent_start") active = true;
        if (event.eventType === "agent_end") active = false;
        if (event.eventType === "tool_execution_start" && typeof data.toolCallId === "string") tools.add(data.toolCallId);
        if (event.eventType === "tool_execution_end" && typeof data.toolCallId === "string") tools.delete(data.toolCallId);
        if ((event.eventType === "message_start" || event.eventType === "message_update") && data.message?.role === "assistant") assistant = data.message;
        if (event.eventType === "message_end" && data.message?.role === "assistant") assistant = undefined;
        if (data.assistantMessageEvent?.type === "thinking_start") thinking = true;
        if (data.assistantMessageEvent?.type === "thinking_end") thinking = false;
      }
      if (!active && tools.size === 0 && !assistant && !thinking) return events;
      const add = (eventType: string, data: any) => {
        const event = { eventType, data, timestamp: Date.now() };
        append(id, event); events.push(event);
      };
      for (const toolCallId of tools) add("tool_execution_end", { toolCallId, result: "Interrupted by dashboard restart", isError: true });
      if (thinking) add("message_update", { assistantMessageEvent: { type: "thinking_end" } });
      if (assistant) add("message_end", { message: assistant });
      add("agent_end", { messages: [{ stopReason: "error", errorMessage: "Codex turn interrupted by dashboard restart" }] });
      return events;
    },
    flush() { persistence.flushAll(); },
    dispose() { persistence.flushAll(); persistence.dispose(); },
  };
}
