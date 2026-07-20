/**
 * Tier-1 read-only visibility — the MESSAGE-LANE builder (design v0.3 Tier-1
 * §"What Tier-1 IS" #3, the message lane). Turns durable session entries into
 * the `SessionState` the existing `<ChatView>` read-path renders — reading them
 * THROUGH the P1 cloned-DTO facade, exactly as the spec's additive-safety proof
 * (a) requires.
 *
 * The read-path, end to end:
 *
 *   ReadonlySessionManagerLike (live mgr on server / fixture in demo)
 *     → createClonedSessionFacade  (P1: deep-clone + deep-freeze every getter —
 *                                   severs aliasing into the never-drop core)
 *     → facade.getEntries()        (frozen SessionEntryDto[])
 *     → normalizeThreadEntries     (thread_delivery custom rows → narrative rows
 *                                   the canonical replay understands; committed
 *                                   ORDER preserved — no reordering, no drop)
 *     → replayEntriesAsEvents      (shared, committed — unchanged)
 *     → reduceEvent loop           (client reducer — unchanged)
 *     → SessionState               → <ChatView disableToolGrouping defaultFilter=…>
 *
 * READ-ONLY + additive: this NEVER mutates the facade output (it maps the frozen
 * DTOs into NEW plain objects for replay — the frozen originals are untouched),
 * writes nothing, and confers no authority. It does NOT modify the committed P1
 * facade or the committed shared `state-replay.ts`.
 *
 * M11 (disable tool-grouping) is applied at the RENDER site (`<ChatView
 * disableToolGrouping>`), not here — this builder emits every native row; the
 * lane simply does not collapse them. The two together keep every committed row
 * visible in native order.
 */
import {
  createClonedSessionFacade,
  type ReadonlySessionManagerLike,
  type SessionEntryDto,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";
import { replayEntriesAsEvents } from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";
import {
  createInitialState,
  reduceEvent,
  type SessionState,
} from "./event-reducer.js";

/**
 * The `thread_delivery` custom-message shape (grounded own-hand against pi
 * 0.80.3 — see `packages/extension/src/thread-durability/recover-evidence.ts`):
 *   `{type:"custom_message", customType:"thread_delivery", content, display,
 *     details:{delivery_id, thread_id, attempt, holder_epoch}, id, parentId}`
 */
interface ThreadDeliveryDetails {
  delivery_id?: string;
  thread_id?: string;
  attempt?: number;
  holder_epoch?: number;
  [k: string]: unknown;
}

/**
 * `replayEntriesAsEvents` (committed shared core, NOT modified) understands
 * `type:"message"` + `type:"model_change"` and SKIPS everything else — so a
 * `custom_message`/`thread_delivery` entry would be silently dropped from the
 * message lane. Rather than fold that handling into the committed replay (which
 * would touch core), we NORMALIZE here: map each `thread_delivery` custom row
 * into a synthetic `type:"message"` narrative entry (role `user`, skill-less)
 * that carries the delivery envelope as its content. Committed ORDER is
 * preserved (a 1:1 positional map — no reorder, no drop); ordinary `message` /
 * `model_change` entries pass through verbatim.
 *
 * This is a DISPLAY projection only: it invents no delivery, asserts no status,
 * and never writes. It exists purely so the durable `thread_delivery` provenance
 * rows are VISIBLE in the read-only lane alongside ordinary session content.
 */
export function normalizeThreadEntries(entries: readonly SessionEntryDto[]): unknown[] {
  return entries.map((entry) => {
    if (entry.type === "custom_message" && (entry as { customType?: string }).customType === "thread_delivery") {
      const details = ((entry as { details?: ThreadDeliveryDetails }).details ?? {}) as ThreadDeliveryDetails;
      const rawDisplay = (entry as { display?: unknown }).display;
      const display = typeof rawDisplay === "string"
        ? rawDisplay
        : typeof entry.content === "string"
          ? entry.content
          : "";
      const deliveryId = details.delivery_id ?? "—";
      const attempt = typeof details.attempt === "number" ? details.attempt : 0;
      // A synthetic narrative row (role:user) the committed replay understands.
      // Labeled so the operator sees it IS a thread-delivery provenance row, not
      // ordinary chat. content is a plain string (replay reads msg.content or
      // an array of {type:'text'} parts; a string is the simplest faithful form).
      const content = `**thread_delivery** \`${deliveryId}\` · attempt ${attempt}\n\n${display}`;
      return {
        type: "message",
        id: entry.id,
        parentId: entry.parentId,
        timestamp: entry.timestamp,
        message: { role: "user", content },
      };
    }
    // Ordinary message / model_change / other — pass the frozen DTO through as a
    // plain (shallow-cloned) object so replay reads it without touching the
    // frozen original. (replay only reads; the shallow copy is belt-and-braces.)
    return { ...entry };
  });
}

/**
 * Build the message-lane `SessionState` from a `ReadonlySessionManagerLike`
 * handle — the read-path THROUGH the P1 cloned-DTO facade. The facade is the
 * mandated seam: we read `getEntries()` (frozen DTOs), normalize the
 * thread-delivery rows, then run the committed replay + reduce.
 *
 * `sessionId` labels the synthesized events (cosmetic — the lane renders one
 * thread's entries). Returns a fully-reduced `SessionState` ready for
 * `<ChatView state={…} disableToolGrouping defaultFilter={…}/>`.
 */
export function buildMessageLaneStateFromManager(
  mgr: ReadonlySessionManagerLike,
  sessionId = "thread-message-lane",
): SessionState {
  const facade = createClonedSessionFacade(mgr); // P1 seam — clone + freeze
  const frozenEntries = facade.getEntries(); // frozen SessionEntryDto[]
  return buildMessageLaneStateFromEntries(frozenEntries, sessionId);
}

/**
 * Build the message-lane `SessionState` directly from already-facade-read
 * entries (the DTOs a server route would serialize from `facade.getEntries()`
 * and ship to the client). Normalizes the thread-delivery rows, replays, and
 * reduces. Kept separate from the manager path so the live client (which
 * receives DTOs over REST, already cloned server-side by the facade) and the
 * demo (which reads a fixture manager through the facade in-process) share the
 * identical normalize→replay→reduce tail.
 */
export function buildMessageLaneStateFromEntries(
  entries: readonly SessionEntryDto[],
  sessionId = "thread-message-lane",
): SessionState {
  const normalized = normalizeThreadEntries(entries);
  const events = replayEntriesAsEvents(sessionId, normalized as unknown[]);
  let state = createInitialState();
  for (const { event } of events) {
    state = reduceEvent(state, event);
  }
  // A read-only history lane is never "streaming" — it is a settled snapshot.
  state.isStreaming = false;
  state.status = "ended";
  return state;
}
