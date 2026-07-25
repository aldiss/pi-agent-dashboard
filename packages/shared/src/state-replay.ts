/**
 * State replay — synthesizes dashboard events from pi session entries
 * so the browser can rebuild the chat view after a reconnect or DB reset.
 */
import type {
  EventForwardMessage,
  OperatorDeliveryEventData,
  OperatorDeliveryWireMessage,
} from "./protocol.js";
import {
  isOperatorProseTool,
  sanitizeOperatorProseToolArgs,
} from "./operator-tool-visibility.js";

export const PERSISTED_DASHBOARD_ASSETS_FIELD = "dashboardAssets";

export interface PersistedDashboardAsset {
  hash: string;
  mimeType: string;
  data: string;
}

const ASSET_HASH = /^[a-f0-9]{16}$/;

/** Read the bounded, validated asset sidecar stored on a persisted message. */
export function readPersistedDashboardAssets(message: unknown): PersistedDashboardAsset[] {
  if (!message || typeof message !== "object") return [];
  const raw = (message as Record<string, unknown>)[PERSISTED_DASHBOARD_ASSETS_FIELD];
  if (!Array.isArray(raw)) return [];
  const assets: PersistedDashboardAsset[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const asset = value as Record<string, unknown>;
    if (typeof asset.hash !== "string" || !ASSET_HASH.test(asset.hash)) continue;
    if (typeof asset.mimeType !== "string" || !asset.mimeType.startsWith("image/")) continue;
    if (typeof asset.data !== "string" || asset.data.length === 0) continue;
    assets.push({ hash: asset.hash, mimeType: asset.mimeType, data: asset.data });
  }
  return assets;
}

/** Last reference wins for identical content hashes. */
export function collectPersistedDashboardAssets(
  entries: readonly unknown[],
): Record<string, { mimeType: string; data: string }> {
  const collected: Record<string, { mimeType: string; data: string }> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as { message?: unknown }).message;
    for (const asset of readPersistedDashboardAssets(message)) {
      collected[asset.hash] = { mimeType: asset.mimeType, data: asset.data };
    }
  }
  return collected;
}

/** Keep persisted bytes out of live/replay event frames after rebuilding the registry. */
export function withoutPersistedDashboardAssets<T>(message: T): T {
  if (!message || typeof message !== "object" ||
      !(PERSISTED_DASHBOARD_ASSETS_FIELD in (message as object))) return message;
  const copy = { ...(message as Record<string, unknown>) };
  delete copy[PERSISTED_DASHBOARD_ASSETS_FIELD];
  return copy as T;
}

/**
 * Clone assistant content so protected ask/push tool-call prose never rides in
 * dashboard live or replay message frames. The persisted pi entry is untouched;
 * dedicated lifecycle frames retain only their fixed status fields.
 */
export function withoutOperatorProseToolPayloads<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  if (record.role === "toolResult" && isOperatorProseTool(record.toolName)) {
    return {
      role: "toolResult",
      ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
      ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
      ...(record.isError === true ? { isError: true } : {}),
      content: "",
    } as unknown as T;
  }
  if (record.role !== "assistant" || !Array.isArray(record.content)) return message;
  let changed = false;
  const content = record.content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const block = part as Record<string, unknown>;
    if (block.type !== "toolCall" || !isOperatorProseTool(block.name)) return part;
    changed = true;
    return {
      type: "toolCall",
      ...(typeof block.id === "string" ? { id: block.id } : {}),
      ...(typeof block.name === "string" ? { name: block.name } : {}),
    };
  });
  return changed ? { ...record, content } as unknown as T : message;
}

/**
 * Convert pi session entries (from ctx.sessionManager.getBranch())
 * into dashboard event_forward messages that the event reducer can process.
 *
 * Only generates the minimal events needed to rebuild the chat view:
 * - message_start for user messages
 * - message_update + message_end for assistant messages
 * - tool_execution_start / tool_execution_end for tool calls
 * - model_select for model changes
 *
 * NOTE on entryId (per change: fix-per-message-fork):
 * Replay reads from the persisted JSONL, so each entry already has a
 * stable `id`. We attach it directly as `entryId` on both `message_start`
 * (user) and `message_end` (assistant) events. Replay therefore does NOT
 * need to emit an `entry_persisted` follow-up — the back-fill protocol
 * exists to bridge a timing gap that only happens for LIVE pi events on
 * pi 0.69+, where the bridge sees `message_start` before pi has assigned
 * the entry id. Replay has no such gap.
 */
/**
 * @param knownContextWindow Optional override for the context window size,
 *   typically `session.contextWindow` from `.meta.json` (which was persisted
 *   from a live `turn_end` event). When provided, it is used in place of the
 *   `inferContextWindow(modelId)` heuristic for every synthesized
 *   `stats_update` event. The heuristic ignores Sonnet's 1M variant and
 *   pins Claude to 200k, so passing the persisted value avoids a brief
 *   200k flicker on reload before the next live `turn_end` arrives.
 */
export function replayEntriesAsEvents(
  sessionId: string,
  entries: any[],
  knownContextWindow?: number,
): EventForwardMessage[] {
  const messages: EventForwardMessage[] = [];
  const openToolCalls = new Set<string>(); // track tool calls without results
  const toolNamesById = new Map<string, string>();

  let currentModel = "";

  for (const entry of entries) {
    if (!entry || !entry.type) continue;
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

    if (entry.type === "model_change") {
      currentModel = entry.modelId ?? "";
    }

    if (entry.type === "message" && entry.message) {
      const withoutAssets = withoutPersistedDashboardAssets(entry.message);
      const knownToolName = withoutAssets?.role === "toolResult" &&
        typeof withoutAssets.toolCallId === "string"
        ? toolNamesById.get(withoutAssets.toolCallId)
        : undefined;
      const msg = withoutOperatorProseToolPayloads(
        knownToolName && !withoutAssets.toolName
          ? { ...withoutAssets, toolName: knownToolName }
          : withoutAssets,
      );

      if (msg.role === "user") {
        messages.push(makeEvent(sessionId, "message_start", ts, { message: msg, entryId: entry.id }));
      }

      if (msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [];
        // Iterate content[] in order so synthetic block-events fire in
        // canonical content-array order. message_end's reorder pass also
        // enforces this order against the assembled messages[] window,
        // so emit-order here is for clarity not correctness.
        //
        // Synthesize thinking_start + thinking_delta + thinking_end
        // events for each persisted `{type:"thinking"}` block so the
        // reducer creates `role:"thinking"` rows in messages[]. Without
        // these synthetic events, persisted thinking content is silently
        // dropped on cold-replay (browser reload / server restart /
        // cold session load via directoryService.loadSessionEvents).
        // pi emits these natively during live streaming; replay must
        // mirror that contract.
        // See investigation: pi-dashboard-thinking-block-streaming-
        // state-loss-investigation-2026-05-25.
        for (let idx = 0; idx < content.length; idx++) {
          const part = content[idx];
          if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.length > 0) {
            messages.push(makeEvent(sessionId, "message_update", ts, {
              assistantMessageEvent: { type: "thinking_start", contentIndex: idx },
            }));
            messages.push(makeEvent(sessionId, "message_update", ts, {
              assistantMessageEvent: { type: "thinking_delta", contentIndex: idx, delta: part.thinking },
            }));
            messages.push(makeEvent(sessionId, "message_update", ts, {
              assistantMessageEvent: { type: "thinking_end", contentIndex: idx, signature: part.thinkingSignature },
            }));
          }
          if (part?.type === "toolCall") {
            if (typeof part.id === "string" && typeof part.name === "string") {
              toolNamesById.set(part.id, part.name);
            }
            messages.push(makeEvent(sessionId, "tool_execution_start", ts, {
              toolCallId: part.id,
              toolName: part.name,
              args: sanitizeOperatorProseToolArgs(part.name, typeof part.arguments === "string"
                ? tryParseJson(part.arguments)
                : part.arguments),
            }));
            openToolCalls.add(part.id);
          }
        }
        // Emit message_update (sets streamingText) then message_end (finalizes)
        const wireMessage = msg as OperatorDeliveryWireMessage;
        messages.push(makeEvent(sessionId, "message_update", ts, { message: wireMessage, entryId: entry.id }));
        messages.push(makeEvent(sessionId, "message_end", ts, { message: wireMessage, entryId: entry.id }));

        // Emit stats_update if usage data is present
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          const cost = usage.cost as Record<string, number> | undefined;
          const totalTokens = usage.totalTokens as number | undefined;
          const statsData: Record<string, unknown> = {
            tokensIn: (usage.input as number) ?? 0,
            tokensOut: (usage.output as number) ?? 0,
            cost: cost?.total ?? 0,
            turnUsage: {
              input: (usage.input as number) ?? 0,
              output: (usage.output as number) ?? 0,
              cacheRead: (usage.cacheRead as number) ?? 0,
              cacheWrite: (usage.cacheWrite as number) ?? 0,
            },
          };
          // Include context usage estimate from totalTokens
          if (totalTokens && totalTokens > 0) {
            statsData.contextUsage = {
              tokens: totalTokens,
              contextWindow: knownContextWindow ?? inferContextWindow(currentModel),
            };
          }
          messages.push(makeEvent(sessionId, "stats_update", ts, statsData));
        }
      }

      // Tool results: toolCallId and toolName are at the message level
      // Structure: { role: "toolResult", toolCallId, toolName, content: [{type:"text",text:"..."}], isError }
      if (msg.role === "toolResult" && msg.toolCallId) {
        const protectedOperatorTool = isOperatorProseTool(msg.toolName);
        const resultText = protectedOperatorTool ? "" : Array.isArray(msg.content)
          ? msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : typeof msg.content === "string" ? msg.content : "";
        // Extract image content blocks if present
        const imageBlocks = Array.isArray(msg.content)
          ? msg.content.filter((c: any) => c.type === "image" && c.data && c.mimeType)
          : [];
        const eventData: Record<string, unknown> = {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName ?? "unknown",
          result: resultText,
          isError: msg.isError ?? false,
        };
        if (!protectedOperatorTool && imageBlocks.length > 0) {
          eventData.images = imageBlocks.map((c: any) => ({ data: c.data, mimeType: c.mimeType }));
        }
        // Include tool details (e.g. AgentDetails from pi-subagents) if present
        if (!protectedOperatorTool && msg.details && typeof msg.details === "object") {
          eventData.details = msg.details;
        }
        messages.push(makeEvent(sessionId, "tool_execution_end", ts, eventData));
        openToolCalls.delete(msg.toolCallId);
        toolNamesById.delete(msg.toolCallId);
      }
    }

    if (entry.type === "model_change") {
      messages.push(makeEvent(sessionId, "model_select", ts, {
        type: "model_select",
        model: { provider: entry.provider, id: entry.modelId },
      }));
    }
  }

  // Close any orphaned tool calls (agent killed mid-execution)
  for (const toolCallId of openToolCalls) {
    const startEvent = messages.find(
      (m) => m.event.eventType === "tool_execution_start" && (m.event.data as any).toolCallId === toolCallId,
    );
    const ts = startEvent ? startEvent.event.timestamp : Date.now();
    messages.push(makeEvent(sessionId, "tool_execution_end", ts, {
      toolCallId,
      toolName: (startEvent?.event.data as any)?.toolName ?? "unknown",
      result: "",
      isError: false,
    }));
  }

  return messages;
}

function makeEvent(
  sessionId: string,
  eventType: string,
  timestamp: number,
  data: OperatorDeliveryEventData,
): EventForwardMessage {
  return {
    type: "event_forward",
    sessionId,
    event: {
      eventType,
      timestamp,
      data: { type: eventType, ...data },
    },
  };
}

function tryParseJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

/** Infer context window size from model ID */
function inferContextWindow(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes("claude") && (id.includes("opus") || id.includes("sonnet") || id.includes("haiku"))) return 200_000;
  if (id.includes("gpt-4o")) return 128_000;
  if (id.includes("gpt-4")) return 128_000;
  if (id.includes("o1") || id.includes("o3") || id.includes("o4")) return 200_000;
  if (id.includes("gemini")) return 1_000_000;
  if (id.includes("deepseek")) return 128_000;
  return 200_000; // safe default
}
