/**
 * Event reducer: builds session UI state from a stream of events.
 * (state, event) → new state
 */
import type { DashboardEvent, FlowState, ArchitectState, MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { isFlowEvent, reduceFlowEvent } from "@blackbelt-technology/pi-dashboard-flows-plugin/reducer";
import { isArchitectEvent, reduceArchitectEvent } from "@blackbelt-technology/pi-dashboard-flows-plugin/reducer";
import { parseSkillBlock, type SkillBlock } from "@blackbelt-technology/pi-dashboard-shared/skill-block-parser.js";
import { readAudienceStamp } from "./message-filter-classifier.js";

/**
 * Read the stamp-at-emit audience off a raw message envelope (`data.message`)
 * and preserve it faithfully (F1/F2). The operator-voice extension stamps
 * `msg.audience` on the finalized `message_end` envelope for BOTH roles; this
 * retains it on the ChatMessage so the classifier reads the authoritative signal.
 *
 * We PRESERVE a present value verbatim — valid, `unknown` (the ratified 3rd
 * state), OR corrupt (incl `null`) — so the classifier's 4-state triage sees it
 * and fails a corrupt/unknown-present stamp OPEN (shown), rather than the reducer
 * collapsing it to undefined and letting a worker-ctx retrospective hide it. Only
 * a truly-ABSENT (`undefined`) value stays undefined (→ retrospective).
 *
 * Sol fix-cycle-3 F1: user rows ARE stamped now — the extension `message_end`
 * hook fires for user messages too and returns a stamped replacement. This reader
 * is used on BOTH the assistant paths AND the user-row back-fill (message_end).
 */
function readMessageAudience(msg: unknown): "operator" | "agent" | "unknown" | undefined {
  if (msg && typeof msg === "object" && "audience" in (msg as object)) {
    const raw = (msg as { audience?: unknown }).audience;
    const read = readAudienceStamp(raw);
    if (read.state === "valid") return read.value;
    if (read.state === "unknown") return "unknown";
    // Preserve a corrupt-present value (incl null) as a sentinel the classifier
    // fails open on. `null` becomes the string "unknown"? No — keep the raw so the
    // classifier's readAudienceStamp re-derives corrupt→shown. But ChatMessage's
    // typed field can't hold null; map corrupt-present → "unknown" (also shown,
    // also exempt), preserving the "present-but-not-agent → shown" invariant.
    if (read.state === "corrupt") return "unknown";
  }
  return undefined;
}


export interface ChatImage {
  data: string;
  mimeType: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "thinking" | "bashOutput" | "commandFeedback" | "interactiveUi" | "turnSeparator" | "rawEvent";
  content: string;
  images?: ChatImage[];
  toolName?: string;
  toolCallId?: string;
  isStreaming?: boolean;
  timestamp: number;
  args?: Record<string, unknown>;
  result?: string;
  toolStatus?: "running" | "complete" | "error";
  /** Epoch ms when the block started (for live elapsed counter) */
  startedAt?: number;
  /** Duration in ms (set when complete) */
  duration?: number;
  /** Turn index for scroll-to-turn navigation */
  turnIndex?: number;
  /** Structured metadata from tool (e.g. AgentDetails from pi-subagents) */
  toolDetails?: Record<string, unknown>;
  /** Session entry ID (for fork-from-message) */
  entryId?: string;
  /**
   * Bridge-stamped nonce that ties this ChatMessage to a later
   * entry_persisted event. Set on user message_start (where entryId is
   * not yet known) and on message_end. The reducer uses it to back-fill
   * `entryId` once persistence completes. See change: fix-per-message-fork.
   */
  nonce?: string;
  /**
   * Parsed skill-invocation metadata for user messages whose persisted
   * content matches the `<skill name=...>...</skill>\n\nargs` envelope (pi's
   * `_expandSkillCommand` output, also produced by the dashboard bridge).
   * `content` is preserved as the raw expanded string for copy semantics;
   * the renderer uses `skill` to produce a collapsible card.
   * See change: render-skill-invocations-collapsibly.
   */
  skill?: SkillBlock;
  /**
   * SERVER-STAMPED author of this turn (multi-operator, Surface A). Present on
   * a committed user turn only when a per-author queue entry correlated it
   * (dashboard-message-queue path, flag on). The renderer shows op-1/op-2
   * attribution chrome ONLY when this is set — absent in single-operator mode
   * (flag off) → no chrome, byte-unchanged. See MessageAuthor.
   */
  author?: MessageAuthor;
  /**
   * Stamp-at-emit audience (operator-addressed vs mesh chatter vs unknown).
   * Source of truth for the operator-voice classifier + the "Mesh chatter"
   * toggle, stamped by the extension `message_end` hook for BOTH user and
   * assistant rows (Sol fix-cycle-3 F1). Three states: `operator` (shown+linted),
   * `agent` (hide-eligible+exempt), `unknown` (shown+exempt — the ratified
   * fail-open, also used for a corrupt-present wire value). Absent (pre-stamp
   * history) → the classifier's retrospective heuristic derives it from the
   * session tier. See message-filter-classifier.ts + the pi-operator-voice
   * extension (src/audience.ts, the emit-side authority).
   */
  audience?: "operator" | "agent" | "unknown";
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "running" | "complete" | "error";
  result?: string;
}

export interface TurnStat {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Index into user messages for click-to-scroll (-1 if no user message for this turn) */
  turnIndex: number;
}

const MAX_TURN_STATS = 50;

export interface PendingPrompt {
  text: string;
  images?: ChatImage[];
}

/**
 * A single message in the visible follow-up queue (dashboard-message-queue/v1).
 *
 * Promotes the single-slot `pendingPrompt` into an ordered list so the queue
 * lifecycle (enqueued → dispatched → replied) is VISIBLE, never inferred.
 *
 * State machine:
 *   - "optimistic"  — pushed by `handleSend` the instant the user sends while
 *                     streaming. 0ms feedback; not yet confirmed by the bridge.
 *   - "confirmed"   — the bridge acked the enqueue (`message_enqueued`) or the
 *                     authoritative `queue_state` snapshot includes it. This is
 *                     the message genuinely sitting in pi's follow-up queue.
 *   - "failed"      — an "optimistic" entry whose confirmation never arrived
 *                     within the stuck-timeout window (disconnect failure mode).
 *                     Rendered as "failed — tap to retry". Makes loss VISIBLE.
 *
 * (There is no distinct "dispatching" state: the dispatch edge IS the
 * `message_start(queueNonce)` event, which removes the entry from the queue
 * and pushes the committed user bubble in the same reducer pass. The lift
 * animation lives in ChatView.)
 *
 * `queueNonce` is the correlation id — client-minted for dashboard-origin
 * entries (so the optimistic card reconciles by exact match), bridge-minted
 * for TUI-origin entries.
 */
export interface QueuedMessage {
  queueNonce: string;
  text: string;
  images?: ChatImage[];
  state: "optimistic" | "confirmed" | "failed";
  /** Origin — "dashboard" (this client or another) vs "tui" (pi's own terminal). */
  source?: "dashboard" | "tui";
  /**
   * SERVER-STAMPED author of this queued turn (multi-operator, Surface A).
   * Threaded from `message_enqueued`/`queue_state`; carried PARALLEL to `text`.
   * A just THREADS it (so a committed turn can render attribution); the
   * `(author,text)` reconciliation is a later slice. Absent single-operator.
   */
  author?: MessageAuthor;
  /** Epoch ms when this entry was created client-side (for stuck-timeout). */
  createdAt: number;
}

export interface InteractiveUiRequest {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
  status: "pending" | "resolved" | "cancelled" | "dismissed";
  result?: unknown;
}

export interface SubagentState {
  id: string;
  type: string;
  description: string;
  status: "created" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
  toolUses?: number;
}

export interface SessionState {
  messages: ChatMessage[];
  /**
   * Lookup-table maintained alongside `messages[]`: maps `ChatMessage.id`
   * → index into `messages`. Enables O(1) in-place updates by id
   * (e.g. `resolveInteractiveRequest`, `dismissInteractiveRequest`)
   * without an O(n) full-array `map(...)` allocation per call.
   *
   * Maintenance discipline: rebuilt at the end of `reduceEvent` whenever
   * the `messages` array reference changes. Cost is O(n) per event
   * — same complexity as the existing per-event walks — but enables
   * O(1) consumer-side lookups by id at any subsequent reducer site.
   *
   * Honest disclosure (W4b): the existing hot-path lookups in this
   * reducer are keyed by `toolCallId` / `nonce` / `role`, NOT by
   * `msg.id`. A msg.id-keyed Map therefore does NOT eliminate those
   * walks; replacing them would require additional indices keyed by
   * the relevant predicate AND a behavior-equivalence audit (some
   * predicates currently match multiple roles by accident — e.g.
   * `findLastIndex(m => m.toolCallId === X)` could match an
   * `interactiveUi` row pushed inside a tool's runtime). Out of W4b
   * scope; banked for a follow-up cycle. See change: bug-3-messages-
   * index-lookup-table.
   */
  messagesIndex: Map<string, number>;
  toolCalls: Map<string, ToolCallState>;
  streamingText: string;
  streamingThinking: string;
  /** Epoch ms when current thinking block started (for live counter) */
  thinkingStartedAt?: number;
  isStreaming: boolean;
  model?: string;
  thinkingLevel?: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  currentTool?: string;
  status: "idle" | "streaming" | "ended";
  turnStats: TurnStat[];
  contextUsage?: { tokens: number | null; contextWindow: number };
  pendingPrompt?: PendingPrompt;
  /**
   * Visible follow-up queue (dashboard-message-queue/v1). Empty in the
   * degenerate 0-queue case (the single-slot `pendingPrompt` path handles the
   * immediate non-streaming send). Populated when ≥1 message is queued while
   * the agent is streaming. Reconciled by the bridge's authoritative
   * `queue_state` snapshot. See change: dashboard-message-queue.
   */
  queue: QueuedMessage[];
  /**
   * Nonces superseded by a retry (dashboard-message-queue/v1 AMEND #5 (f)).
   * When `handleRetryQueued` re-keys a failed card OLD→NEW and re-sends, it
   * records the OLD nonce here. The reducer makes any LATE confirmation for a
   * superseded nonce INERT (no adopt/re-key/append/dispatch) across
   * `message_enqueued` / `queue_state` / `message_start` — so a connected-slow
   * OLD send that confirms after the retry-re-key cannot flip-flop the NEW card
   * or spawn a duplicate. The OLD send itself is already in pi's follow-up queue
   * and cannot be aborted client-side (deferred control-tail) — this guards
   * CLIENT STATE only. See change: dashboard-message-queue (AMEND #5 (f)).
   */
  supersededNonces: Set<string>;
  interactiveRequests: InteractiveUiRequest[];
  flowState: FlowState | null;
  /** All flow states seen during execution (main + subflows), keyed by flowName */
  flowStates: Map<string, FlowState>;
  architectState: ArchitectState | null;
  /** Whether any Write/Edit tool calls have been seen (for Changed Files button) */
  hasFileChanges: boolean;
  /** Active subagents from @tintinweb/pi-subagents */
  subagents: Map<string, SubagentState>;
  /** Total turn count (for turnIndex assignment and sliding window offset) */
  turnCount: number;
  /** Last LLM provider error (set from agent_end, cleared on agent_start or dismiss) */
  lastError?: { message: string; timestamp: number };
  /**
   * In-flight LLM-provider auto-retry state. Set on `auto_retry_start`,
   * cleared on `auto_retry_end` / `agent_start` / `agent_end`. Drives the
   * RetryBanner UI and the session-card amber dot.
   * See change: fix-provider-retry-infinite-loop.
   */
  retryState?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    startedAt: number;
  };
  /**
   * True iff the current assistant message has already had its streaming
   * text flushed into messages[] via flushStreamingTextAsAssistantRow.
   * Reset to false on every assistant message_start AND on every assistant
   * message_end (R7 defense-in-depth: keeps the flag's lifecycle equal to
   * "between message_start and message_end" so a stray tool_execution_start
   * arriving outside that window cannot silently no-op the flush).
   * See change: fix-streaming-text-vs-interactive-ui-order.
   */
  streamingTextFlushed?: boolean;
  /**
   * Loading ≠ empty (build-2 fix-cycle MAJOR 2). `true` once a terminal
   * `event_replay { isLast: true }` has arrived for this session (replay is
   * DONE). `false`/undefined means replay is still in flight (or hasn't
   * started). ChatView shows "No messages yet" ONLY when this is true — before
   * that a zero-message state is LOADING, not empty. Reset to false on
   * subscribe / `session_state_reset` so a re-subscribe re-enters loading.
   * Managed by `useMessageHandler` (not `reduceEvent`), so it is set OUTSIDE
   * the per-event reducer on the `isLast` frame.
   */
  replayComplete?: boolean;
}

/**
 * Rebuild the `messagesIndex` lookup-table from a `messages[]` array.
 *
 * Used at the end of `reduceEvent` whenever the `messages` array
 * reference has changed (push / splice / reorder), and from
 * `createInitialState` to seed an empty index.
 *
 * If multiple messages share the same id (which should never happen
 * given id-generation discipline at every push site), the LAST
 * occurrence wins — matching the semantics of `findLastIndex`-style
 * lookups elsewhere in this reducer.
 *
 * See change: bug-3-messages-index-lookup-table.
 */
export function rebuildMessagesIndex(messages: readonly ChatMessage[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    idx.set(messages[i].id, i);
  }
  return idx;
}

export function createInitialState(): SessionState {
  return {
    messages: [],
    messagesIndex: new Map(),
    toolCalls: new Map(),
    streamingText: "",
    streamingThinking: "",
    isStreaming: false,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    status: "idle",
    turnStats: [],
    queue: [],
    supersededNonces: new Set(),
    interactiveRequests: [],
    flowState: null,
    flowStates: new Map(),
    architectState: null,
    hasFileChanges: false,
    subagents: new Map(),
    turnCount: 0,
  };
}



/**
 * Hard turn boundaries in `messages[]`. Any row with one of these roles
 * terminates the backwards walk that builds the reorder window. Roles
 * not in this set (`assistant`, `toolResult`, `thinking`, `interactiveUi`,
 * `bashOutput`) belong to the current assistant turn and are reorderable.
 *
 * If a future row role is added, it MUST be classified — add it here if
 * it terminates a turn, otherwise leave it out and it will be reorderable.
 *
 * See change: fix-interactive-ui-reorder.
 */
const TURN_BOUNDARY_ROLES: ReadonlySet<ChatMessage["role"]> = new Set([
  "user",
  "turnSeparator",
  "commandFeedback",
  "rawEvent",
]);

/**
 * Flush the current `streamingText` into a permanent assistant ChatMessage
 * row. Called from `tool_execution_start` when streamingText is non-empty so
 * that any subsequent toolResult / interactiveUi rows pushed during the same
 * message land BELOW the assistant text in messages[], not above it.
 *
 * The pushed row's `id` is `flush-${toolCallId}` — content-stable across
 * replay so re-running the same `tool_execution_start` event does NOT push
 * a duplicate row. The third parameter `toolCallId` is the id of the tool
 * whose start triggered the flush (already in scope at the single caller
 * inside the `tool_execution_start` reducer arm).
 *
 * Idempotent guards:
 *   - `state.streamingTextFlushed === true`           → return state unchanged
 *   - `state.streamingText` empty                      → return state unchanged
 *   - a row with id `flush-${toolCallId}` already exists → return state unchanged
 *
 * Returns a new state with:
 *   - messages: [...state.messages, new assistant row (id = flush-${toolCallId},
 *     entryId/nonce both undefined; will be stamped at message_end via
 *     findFlushedAssistantRowIndex)]
 *   - streamingText: ""
 *   - streamingTextFlushed: true
 *
 * Pure: input is not mutated.
 *
 * See changes: fix-streaming-text-vs-interactive-ui-order,
 * fix-replay-duplicates-tool-and-flushed-rows.
 *
 * @param state Current session state
 * @param timestamp Event timestamp (used as the row's `timestamp`)
 * @param toolCallId Id of the upcoming tool — used as the row's stable id anchor
 */
export function flushStreamingTextAsAssistantRow(
  state: SessionState,
  timestamp: number,
  toolCallId: string,
): SessionState {
  if (state.streamingTextFlushed) return state;
  if (!state.streamingText) return state;
  // Replay safety: if a flush row already exists for this toolCallId, do not
  // push again. The reducer arm calling us is unconditional on every
  // tool_execution_start; this guard makes it idempotent.
  // See change: fix-replay-duplicates-tool-and-flushed-rows.
  const flushId = `flush-${toolCallId}`;
  const existingIdx = state.messages.findLastIndex(
    (m) => m.role === "assistant" && m.id === flushId,
  );
  if (existingIdx !== -1) {
    // Mark the flag so message_update stops re-populating streamingText
    // for this message; the row already exists.
    return { ...state, streamingText: "", streamingTextFlushed: true };
  }
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: flushId,
        role: "assistant",
        content: state.streamingText,
        timestamp,
        // entryId/nonce intentionally undefined — message_end stamps both
        // via findFlushedAssistantRowIndex below.
      },
    ],
    streamingText: "",
    streamingTextFlushed: true,
  };
}

/**
 * Find the most recent assistant row in `messages[]` whose `entryId` AND
 * `nonce` are both undefined — i.e. a row pushed by
 * `flushStreamingTextAsAssistantRow` that has not yet been stamped by its
 * `message_end`.
 *
 * Hard upper bound on the scan: stop at the first row whose role is in
 * `TURN_BOUNDARY_ROLES`. This clamp prevents R3 cross-message pollution
 * — a prior message's orphan flushed row (e.g. R2 disconnect dropped its
 * `message_end`) cannot be matched by a later message's stamp because the
 * `turnSeparator` / `user` row between them terminates the scan.
 *
 * Returns -1 if no unstamped flushed row is found in the current message's
 * window.
 *
 * See change: fix-streaming-text-vs-interactive-ui-order.
 */
export function findFlushedAssistantRowIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (TURN_BOUNDARY_ROLES.has(m.role)) return -1;
    if (m.role !== "assistant") continue;
    if (m.entryId === undefined && m.nonce === undefined) return i;
  }
  return -1;
}

/**
 * Reorder the suffix of `messages` so that rows belonging to a single
 * assistant message_end land in the same order as the model's content
 * array. Without this, an assistant message of shape `[text, toolCall]`
 * renders the running tool card BEFORE its own text bubble — because
 * `tool_execution_start` pushes immediately while the assistant text
 * only lands at `message_end`.
 *
 * The reorder operates on a **turn-boundary anchored window**: walk
 * `messages[]` backwards from the tail collecting every row whose role
 * is not in `TURN_BOUNDARY_ROLES`, stopping at the first hard-boundary
 * row. The window is exactly "every row pushed during this assistant
 * turn" — prior turns cannot leak in.
 *
 * Matching rules (per content-array order):
 * - `text` block        → unclaimed `role:"assistant"` row in the window
 * - `toolCall` block    → `role:"toolResult"` row whose `toolCallId` matches,
 *                          PLUS any `role:"interactiveUi"` row whose `toolCallId`
 *                          matches (paired together as `[toolResult, interactiveUi]`)
 * - `thinking` block    → unclaimed `role:"thinking"` row in the window
 *
 * Window rows not matched by any content block ("unclaimed") are emitted
 * AFTER all claimed rows in their original relative order. This is safe
 * because the window is bounded by a hard turn boundary — prior-turn rows
 * cannot leak in. Free-floating `interactiveUi` rows (no `toolCallId`),
 * `bashOutput`, etc. follow this trailing path.
 *
 * Pure: returns a new array; the input is not mutated.
 * Preserves React keyed reconciliation: row `id` fields are unchanged
 * (`tool-${toolCallId}`, `ui-${requestId}`).
 *
 * See changes: fix-text-tool-render-order, fix-interactive-ui-reorder.
 */
function reorderToolCardsForAssistantMessage(
  messages: ChatMessage[],
  assistantContent: unknown[],
): ChatMessage[] {
  if (!Array.isArray(assistantContent)) return messages;
  // Fast path: nothing to reorder if there are no tool calls in this message.
  const hasToolCall = assistantContent.some(
    (b: any) => b && typeof b === "object" && b.type === "toolCall",
  );
  if (!hasToolCall) return messages;

  const relevant = assistantContent.filter(
    (b: any) =>
      b &&
      typeof b === "object" &&
      (b.type === "text" || b.type === "toolCall" || b.type === "thinking"),
  ) as Array<{ type: string; id?: string }>;
  if (relevant.length === 0) return messages;

  // Build the turn-boundary anchored window: walk backwards from the tail
  // including every row whose role is NOT a hard boundary; stop at the
  // first hard boundary row. Hard boundaries are `user`, `turnSeparator`,
  // `commandFeedback`, `rawEvent`. Roles included in the window are
  // `assistant`, `toolResult`, `thinking`, `interactiveUi`, `bashOutput`.
  //
  // The window is exactly "every row pushed during the current assistant
  // turn (and any preceding consecutive assistant turns without a user
  // response in between)". Unclaimed rows from prior consecutive
  // assistant turns are protected by the `original-index` guard below —
  // they stay in place and never migrate past the just-ended message.
  //
  // See change: fix-interactive-ui-reorder.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (TURN_BOUNDARY_ROLES.has(messages[i].role)) {
      start = i + 1;
      break;
    }
  }
  const suffix = messages.slice(start);
  if (suffix.length === 0) return messages;

  // Helper: scan the suffix from the tail backwards for the most-recent
  // unclaimed row matching `pred`. We prefer the most-recent match
  // because back-to-back assistant messages without a user response in
  // between produce a window that includes both messages' rows; the
  // current-message row is always the more recent one of any matching pair.
  const claimedSuffixIdxs = new Set<number>();
  const findLastUnclaimed = (
    pred: (m: ChatMessage) => boolean,
  ): number => {
    for (let i = suffix.length - 1; i >= 0; i--) {
      if (!claimedSuffixIdxs.has(i) && pred(suffix[i])) return i;
    }
    return -1;
  };

  // Pass 1: walk content blocks in order, claim suffix indices.
  // For toolCall blocks, claim BOTH the toolResult and (if present) the
  // matching interactiveUi row, emitting them as `[toolResult, ui]`.
  const claimedInContentOrder: ChatMessage[] = [];
  for (const block of relevant) {
    if (block.type === "text") {
      const si = findLastUnclaimed((m) => m.role === "assistant");
      if (si >= 0) {
        claimedSuffixIdxs.add(si);
        claimedInContentOrder.push(suffix[si]);
      }
    } else if (block.type === "toolCall") {
      const id = block.id;
      const toolIdx = findLastUnclaimed(
        (m) => m.role === "toolResult" && m.toolCallId === id,
      );
      if (toolIdx >= 0) {
        claimedSuffixIdxs.add(toolIdx);
        claimedInContentOrder.push(suffix[toolIdx]);
        // Pair with an interactiveUi row carrying the same toolCallId.
        const uiIdx = findLastUnclaimed(
          (m) => m.role === "interactiveUi" && m.toolCallId === id,
        );
        if (uiIdx >= 0) {
          claimedSuffixIdxs.add(uiIdx);
          claimedInContentOrder.push(suffix[uiIdx]);
        }
      }
    } else if (block.type === "thinking") {
      const si = findLastUnclaimed((m) => m.role === "thinking");
      if (si >= 0) {
        claimedSuffixIdxs.add(si);
        claimedInContentOrder.push(suffix[si]);
      }
    }
    // else: block has no corresponding row in the window — skip silently.
  }

  // Pass 2: build the new suffix.
  //
  // Two kinds of unclaimed rows need different handling:
  //   (A) "Reorderable" roles (`assistant`, `toolResult`, `thinking`) that
  //       could in principle map to a content block. If they didn't get
  //       claimed, they likely belong to a PRIOR message that bled into
  //       the boundary-walked window (no `user` row between two assistant
  //       turns). Keep them at their **original suffix index** so they
  //       don't migrate past the just-ended message.
  //   (B) "Trailing" roles (`interactiveUi`, `bashOutput`) that NEVER map
  //       to a content block. The design says these trail AFTER claimed
  //       rows in their original relative order. This puts a free-floating
  //       `interactiveUi` (no `toolCallId`) after the just-rendered tool
  //       card instead of stranding it ahead of the assistant text.
  //
  // Construction strategy: walk the original suffix; emit each row in
  // place, replacing claimed rows with the next claimedInContentOrder
  // entry, dropping trailing-role unclaimed rows here so we can append
  // them after the loop. This keeps slot positions stable for unclaimed
  // "reorderable" rows.
  //
  // See change: fix-interactive-ui-reorder.
  const TRAILING_ROLES: ReadonlySet<ChatMessage["role"]> = new Set([
    "interactiveUi",
    "bashOutput",
  ]);
  const newSuffix: ChatMessage[] = [];
  const trailingUnclaimed: ChatMessage[] = [];
  let claimedCursor = 0;
  for (let i = 0; i < suffix.length; i++) {
    if (claimedSuffixIdxs.has(i)) {
      // This index belongs to a claimed row — fill from the
      // content-ordered queue (in order).
      if (claimedCursor < claimedInContentOrder.length) {
        newSuffix.push(claimedInContentOrder[claimedCursor++]);
      }
    } else if (TRAILING_ROLES.has(suffix[i].role)) {
      // Trailing-role unclaimed: drop here, append later.
      trailingUnclaimed.push(suffix[i]);
    } else {
      // Reorderable-role unclaimed: keep in place.
      newSuffix.push(suffix[i]);
    }
  }
  // Any leftover claimed rows (e.g. when toolCall + interactiveUi pair
  // has no matching ui slot in the original suffix because the ui row
  // came in after — shouldn't happen with current arrival order, but
  // defensively): append before trailing.
  while (claimedCursor < claimedInContentOrder.length) {
    newSuffix.push(claimedInContentOrder[claimedCursor++]);
  }
  // Trailing-role unclaimed go AFTER all claimed rows (rule B).
  for (const m of trailingUnclaimed) {
    newSuffix.push(m);
  }

  // Optimisation: if the new suffix is identical to the old suffix
  // (already in correct order) skip the array rebuild.
  if (newSuffix.length === suffix.length) {
    let changed = false;
    for (let i = 0; i < suffix.length; i++) {
      if (suffix[i] !== newSuffix[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return messages;
  }

  return [...messages.slice(0, start), ...(newSuffix as ChatMessage[])];
}

/** Extract text from content blocks: [{ type: "text", text: "..." }, ...] */
function extractContentBlockText(blocks: unknown[]): string | null {
  const texts = blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text);
  return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * Extract image attachments from tool_execution_end event data.
 * Handles two sources:
 * - Live events: data.result is {content: [{type:"image", data, mimeType}, ...]}
 * - Replayed events: data.images is already extracted by state-replay
 */
function extractToolResultImages(data: Record<string, unknown>): ChatImage[] | undefined {
  // Check pre-extracted images (from state-replay)
  if (Array.isArray(data.images) && data.images.length > 0) {
    return data.images
      .filter((img: any) => img?.data && img?.mimeType)
      .map((img: any) => ({ data: img.data as string, mimeType: img.mimeType as string }));
  }
  // Check live event: result.content array with image blocks
  const result = data.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const imageBlocks = content.filter(
        (c: any) => c?.type === "image" && c?.data && c?.mimeType,
      );
      if (imageBlocks.length > 0) {
        return imageBlocks.map((c: any) => ({ data: c.data as string, mimeType: c.mimeType as string }));
      }
    }
  }
  return undefined;
}

/** Convert an unknown value to a display string (handles objects/arrays). */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    // Handle content-block arrays: [{ type: "text", text: "..." }, ...]
    if (Array.isArray(value)) {
      return extractContentBlockText(value) ?? JSON.stringify(value, null, 2);
    }
    // Handle wrapper object: { content: [{ type: "text", text: "..." }] }
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      return extractContentBlockText(obj.content) ?? JSON.stringify(value, null, 2);
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export function truncateLines(text: string | unknown, maxLines: number): string {
  const str = toDisplayString(text);
  const lines = str.split("\n");
  if (lines.length <= maxLines) return str;
  return lines.slice(0, maxLines).join("\n");
}

/**
 * Add a new interactive UI request to session state.
 *
 * `toolCallId` (optional): when this prompt was emitted from inside a tool
 * execution (e.g. `ask_user`), the originating tool call's id flows through
 * `prompt_request.metadata.toolCallId` and is stamped onto the pushed
 * `role:"interactiveUi"` ChatMessage so the assistant `message_end` reorder
 * helper can pair it with its parent `toolResult` row. Free-floating prompts
 * (architect mode, slash commands) leave it undefined.
 *
 * See change: fix-interactive-ui-reorder.
 */
export function addInteractiveRequest(
  state: SessionState,
  requestId: string,
  method: string,
  params: Record<string, unknown>,
  toolCallId?: string,
): SessionState {
  // Architect suppression logic REMOVED — the PromptBus now ensures each prompt
  // is sent to the dashboard exactly once, with the correct component.
  // No more client-side guessing about which prompts to suppress.

  // Deduplicate by requestId (re-sent on reconnect) or by content
  // (recursive proxy generates multiple requestIds for the same dialog)
  if (state.interactiveRequests.some((r) =>
    r.requestId === requestId ||
    (r.status === "pending" && r.method === method && r.params.title === params.title),
  )) {
    return state;
  }
  const request: InteractiveUiRequest = { requestId, method, params, status: "pending" };
  // Bug #3 fix: maintain messagesIndex incrementally on push so the
  // sister functions resolveInteractiveRequest / dismissInteractiveRequest
  // can find this row by id without an O(n) walk. See change:
  // bug-3-messages-index-lookup-table.
  const newMsgId = `ui-${requestId}`;
  const newMessages = [
    ...state.messages,
    {
      id: newMsgId,
      role: "interactiveUi" as const,
      content: method,
      timestamp: Date.now(),
      toolCallId,
      args: { requestId, method, params, status: "pending" } as any,
    },
  ];
  const newMessagesIndex = new Map(state.messagesIndex);
  newMessagesIndex.set(newMsgId, newMessages.length - 1);
  return {
    ...state,
    interactiveRequests: [...state.interactiveRequests, request],
    messages: newMessages,
    messagesIndex: newMessagesIndex,
  };
}

/** Resolve an interactive UI request in session state */
export function resolveInteractiveRequest(
  state: SessionState,
  requestId: string,
  result?: unknown,
  cancelled?: boolean,
): SessionState {
  const newStatus = cancelled ? "cancelled" as const : "resolved" as const;
  // Bug #3 fix: O(1) index lookup + targeted splice in place of
  // O(n) full-array map(). When the target row is absent (stale
  // event / replay edge), preserve the existing messages reference
  // so React reconciliation skips a no-op re-render. See change:
  // bug-3-messages-index-lookup-table.
  const targetId = `ui-${requestId}`;
  const idx = state.messagesIndex.get(targetId);
  let nextMessages = state.messages;
  let nextMessagesIndex = state.messagesIndex;
  if (idx !== undefined && state.messages[idx]?.id === targetId) {
    const updated: ChatMessage = {
      ...state.messages[idx],
      args: { ...state.messages[idx].args as any, status: newStatus, result },
    };
    nextMessages = state.messages.slice();
    nextMessages[idx] = updated;
    // messagesIndex unchanged: in-place update preserves indices.
    nextMessagesIndex = state.messagesIndex;
  }
  return {
    ...state,
    interactiveRequests: state.interactiveRequests.map((req) =>
      req.requestId === requestId
        ? { ...req, status: newStatus, result }
        : req,
    ),
    messages: nextMessages,
    messagesIndex: nextMessagesIndex,
  };
}

/** Dismiss an interactive UI request (answered in TUI, not via dashboard) */
export function dismissInteractiveRequest(
  state: SessionState,
  requestId: string,
): SessionState {
  // Only dismiss pending requests
  const existing = state.interactiveRequests.find((r) => r.requestId === requestId);
  if (!existing || existing.status !== "pending") return state;

  // Bug #3 fix: O(1) index lookup + targeted splice in place of
  // O(n) full-array map(). See sister-comment in
  // resolveInteractiveRequest above. Change:
  // bug-3-messages-index-lookup-table.
  const targetId = `ui-${requestId}`;
  const idx = state.messagesIndex.get(targetId);
  let nextMessages = state.messages;
  let nextMessagesIndex = state.messagesIndex;
  if (idx !== undefined && state.messages[idx]?.id === targetId) {
    const updated: ChatMessage = {
      ...state.messages[idx],
      args: { ...state.messages[idx].args as any, status: "dismissed" },
    };
    nextMessages = state.messages.slice();
    nextMessages[idx] = updated;
    nextMessagesIndex = state.messagesIndex;
  }
  return {
    ...state,
    interactiveRequests: state.interactiveRequests.map((req) =>
      req.requestId === requestId
        ? { ...req, status: "dismissed" as const }
        : req,
    ),
    messages: nextMessages,
    messagesIndex: nextMessagesIndex,
  };
}

/**
 * Find the most recent `user`-role ChatMessage and return its content + images
 * mapped to the wire-format `ImageContent[]` shape (adds `type: "image"`).
 *
 * Used by the Retry-after-error button to re-send the failed turn via
 * `send_prompt` (which routes to `pi.sendUserMessage` in the bridge). Skips
 * non-user roles like `interactiveUi`, so an `ask_user` response cannot be
 * mistaken for a prompt.
 *
 * Returns `null` when no user message exists in history.
 *
 * See change: fix-retry-resends-last-user-message.
 */
export function findLastUserPrompt(
  messages: readonly ChatMessage[],
): { text: string; images?: { type: "image"; data: string; mimeType: string }[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const images = m.images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    return { text: m.content, ...(images && images.length > 0 ? { images } : {}) };
  }
  return null;
}

/** Extract error info from agent_end event's messages array. */
export function extractAgentEndError(data: Record<string, unknown>): string | undefined {
  const messages = data.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  if (!last || last.stopReason !== "error") return undefined;
  return (last.errorMessage as string) || "An unknown error occurred";
}

// ── Message-queue helpers (dashboard-message-queue/v1) ──

/** Map wire-format images (`{data,mimeType}` / `ImageContent`) to ChatImage[]. */
function mapWireImagesToChat(images: unknown): ChatImage[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const mapped = images
    .filter((img: any) => img?.data && img?.mimeType)
    .map((img: any) => ({ data: img.data as string, mimeType: img.mimeType as string }));
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Validate a wire-shape `author` into a `MessageAuthor` (multi-operator,
 * Surface A). Defensive: both `sub` and `display` must be non-empty strings;
 * anything else (undefined, partial, wrong type) → undefined (no chrome). A
 * only THREADS the server-stamped author — it never mints or trusts a
 * client-supplied one (the server already enforces derivation).
 */
function extractMessageAuthor(author: unknown): MessageAuthor | undefined {
  if (!author || typeof author !== "object") return undefined;
  const a = author as Record<string, unknown>;
  if (typeof a.sub !== "string" || a.sub.length === 0) return undefined;
  if (typeof a.display !== "string" || a.display.length === 0) return undefined;
  return { sub: a.sub, display: a.display };
}

/**
 * Flip the matching `optimistic` queue entry to `failed` (stuck-timeout fired
 * before the bridge confirmed it — disconnect failure mode). No-op if the
 * entry is absent or already confirmed/failed. Pure: returns a new state only
 * when something changed.
 */
export function markQueueEntryFailed(
  state: SessionState,
  queueNonce: string,
): SessionState {
  const idx = state.queue.findIndex((q) => q.queueNonce === queueNonce);
  if (idx === -1 || state.queue[idx].state !== "optimistic") return state;
  const nextQueue = state.queue.slice();
  nextQueue[idx] = { ...nextQueue[idx], state: "failed" };
  return { ...state, queue: nextQueue };
}

/**
 * Remove a queue entry by nonce. Honest-removal contract (resolution-1): only
 * `optimistic` and `failed` (unconfirmed) entries can be dismissed client-side
 * — a `confirmed` entry sits in pi's real queue and the extension API exposes
 * no removal, so we refuse to drop it (would desync from pi). No-op if absent
 * or confirmed. Pure.
 */
export function removeQueueEntry(
  state: SessionState,
  queueNonce: string,
): SessionState {
  const entry = state.queue.find((q) => q.queueNonce === queueNonce);
  if (!entry || entry.state === "confirmed") return state;
  return { ...state, queue: state.queue.filter((q) => q.queueNonce !== queueNonce) };
}

/**
 * Conservative same-text reconciliation lookup (dashboard-message-queue/v1
 * AMEND #3; Surface B per-author refinement). Returns the index of the
 * OPTIMISTIC queue entry matching `text`, but ONLY when EXACTLY ONE such entry
 * exists — and that entry is the FIFO-oldest by construction (it's the only one).
 *
 * Why this shape (architect-mandated, closes the AMEND #2 nonce-swap seam):
 * the queueNonce IS the reply-linkage + dispatch identity. With TWO genuine
 * same-text optimistic entries (the operator intentionally sends the same text
 * twice while streaming — the double-submit guard only stops accidental
 * double-FIRES, not intentional re-sends), a newest-first text fallback would
 * adopt confirmation C1 onto entry O2 and C2 onto O1 — SWAPPING the nonces, so
 * each agent reply later threads to the WRONG card. Refusing to guess when
 * count > 1 (returning -1) leaves those entries for the exact-`queueNonce`
 * match or the authoritative `queue_state` snapshot to reconcile in send-order
 * — preserving reply-linkage. Mis-adopting is worse than waiting.
 *
 * SURFACE B — per-author adoption (free-for-all co-drive). When the confirming
 * message carries a server-stamped `author` (multi-operator), the match is
 * scoped to that author: an optimistic entry is a candidate ONLY when its
 * `author.sub === author.sub` AND `text` matches. This REFUSES cross-author
 * adoption — op-2's confirmation can never re-key op-1's same-text card onto
 * op-2's nonce (transient mis-attribution + wrong reply-linkage). The
 * count-of-1 conservatism is preserved PER-AUTHOR: >1 same-(author,text)
 * optimistic → -1 (do not guess).
 *
 * FLAG-OFF byte-unchanged (load-bearing): when `author` is undefined
 * (single-operator — A derives no author), the match DEGRADES to TEXT-ONLY —
 * today's exact behavior. The per-author refusal engages ONLY when the
 * confirming author is present. An optimistic entry with no `author` is matched
 * by text alone in that degraded path.
 *
 * Returns -1 when there are zero OR multiple matches (per the active scope).
 */
export function findSoleOptimisticByText(
  queue: readonly QueuedMessage[],
  text: string,
  author?: MessageAuthor,
): number {
  if (!text) return -1;
  let foundIdx = -1;
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    if (q.state !== "optimistic" || q.text !== text) continue;
    // SURFACE B per-author refusal. When the confirming message carries an
    // `author` (multi-operator), adopt ONLY a card of the SAME author. Client
    // optimistic cards are AUTHOR-LESS at creation (the client cannot know its
    // own server-derived author — anti-spoof), so a same-author confirmation
    // reconciles via the EXACT-NONCE path (the client-minted queueNonce rides
    // send_prompt → bridge → confirmation), NEVER this text-fallback. Therefore
    // an authored confirmation reaching THIS text-fallback against an
    // author-less (or differently-authored) card is the CROSS-AUTHOR hazard —
    // refuse it (op-2's confirm must not re-key op-1's same-text card). When
    // the confirming `author` is absent (flag-off single-op), the guard is
    // inert and the match DEGRADES to text-only — today's byte-unchanged path.
    if (author && q.author?.sub !== author.sub) continue;
    if (foundIdx !== -1) return -1; // more than one candidate → do NOT guess
    foundIdx = i;
  }
  return foundIdx;
}

export function reduceEvent(state: SessionState, event: DashboardEvent): SessionState {
  const next = { ...state, toolCalls: new Map(state.toolCalls) };
  const data = event.data;

  switch (event.eventType) {
    case "agent_start":
      next.isStreaming = true;
      next.status = "streaming";
      next.streamingText = "";
      next.pendingPrompt = undefined;
      next.lastError = undefined;
      next.retryState = undefined;
      break;

    case "agent_end": {
      next.isStreaming = false;
      next.status = "idle";
      next.streamingText = "";
      next.currentTool = undefined;
      next.pendingPrompt = undefined;
      const errorMsg = extractAgentEndError(data);
      if (errorMsg) {
        next.lastError = { message: errorMsg, timestamp: event.timestamp };
      }
      next.retryState = undefined;
      break;
    }

    case "auto_retry_start": {
      const attempt = typeof data.attempt === "number" ? data.attempt : 1;
      const maxAttempts = typeof data.maxAttempts === "number" ? data.maxAttempts : 1;
      const delayMs = typeof data.delayMs === "number" ? data.delayMs : 0;
      const reason = typeof data.errorMessage === "string" ? data.errorMessage : "Provider error";
      next.retryState = { attempt, maxAttempts, delayMs, reason, startedAt: event.timestamp };
      break;
    }

    case "auto_retry_end": {
      // No-op if no retry was tracked (covers stale events / multi-call turns).
      if (!state.retryState) {
        break;
      }
      next.retryState = undefined;
      // Surface terminal error early when no other lastError has fired yet.
      if (data.success === false && typeof data.finalError === "string" && !state.lastError) {
        next.lastError = { message: data.finalError, timestamp: event.timestamp };
      }
      break;
    }

    case "message_start": {
      const msg = data.message as any;
      if (msg?.role === "assistant") {
        // Reset the per-message flush flag at the start of every assistant
        // message. See change: fix-streaming-text-vs-interactive-ui-order.
        next.streamingTextFlushed = false;
      }
      if (msg?.role === "user") {
        next.pendingPrompt = undefined;
        // Message-queue dispatch→work edge (dashboard-message-queue/v1): when
        // this user message_start carries a `queueNonce`, the queued follow-up
        // it identifies was just pulled into work. Remove exactly that entry
        // from the visible queue — it becomes the committed user bubble pushed
        // below. ChatView animates the lift. See change: dashboard-message-queue.
        const dispatchedNonce = data.queueNonce as string | undefined;
        let removedByNonce = false;
        // AMEND #5 (f) idempotency-guard: a dispatch carrying a retry-superseded
        // OLD nonce must NOT remove/dispatch a card. The committed user bubble
        // still renders below (pi genuinely committed the OLD send — see the
        // honest-disclosed pi-side double), but the visible queue card is the
        // NEW (retry) entry and must stay untouched. We also set
        // `removedByNonce = true` so the text-fallback below does NOT let the
        // OLD send's text grab the NEW card (no flip-flop). See
        // SessionState.supersededNonces.
        const dispatchSuperseded = dispatchedNonce !== undefined && next.supersededNonces.has(dispatchedNonce);
        // Server-stamped author of the dispatched queue entry (Surface A).
        // Captured BEFORE the entry is filtered out so the committed user
        // bubble below can render op-1/op-2 attribution. A just THREADS.
        let dispatchedAuthor: MessageAuthor | undefined;
        // SURFACE B: server-stamped author carried on the committing user
        // `message_start` itself (the bridge stamps the immediate-0-queue turn's
        // author here — see bridge stampImmediateAuthor). Used for (a) per-author
        // text-fallback refusal and (b) rendering the immediate turn's author
        // when there is no queue entry to inherit it from.
        const startAuthor = extractMessageAuthor(data.author);
        if (dispatchSuperseded) {
          removedByNonce = true; // suppress text-fallback for this ghost dispatch
        } else if (dispatchedNonce && next.queue.some((q) => q.queueNonce === dispatchedNonce)) {
          dispatchedAuthor = next.queue.find((q) => q.queueNonce === dispatchedNonce)?.author;
          next.queue = next.queue.filter((q) => q.queueNonce !== dispatchedNonce);
          removedByNonce = true;
        }
        let text = "";
        let images: ChatImage[] | undefined;
        if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          const imgBlocks = msg.content.filter(
            (c: any) => c.type === "image" && c.data && c.mimeType,
          );
          if (imgBlocks.length > 0) {
            images = imgBlocks.map((c: any) => ({
              data: c.data,
              mimeType: c.mimeType,
            }));
          }
        } else {
          text = String(msg.content ?? "");
        }
        // FALSE-FAILED reconcile (AMEND #2, hardened AMEND #3): if this
        // committing user message was NOT removed by an exact queueNonce match,
        // fall back to TEXT-match. This covers the streaming-view-mismatch race:
        // the client queued an optimistic card (it saw `isStreaming`) but the
        // bridge committed the send straight to work (it saw the agent already
        // idle) and never emitted `message_enqueued` — so the card would
        // otherwise rot into the 30s stuck-timeout "failed" state even though
        // the message was sent fine. The committing message IS that card; remove
        // it (it becomes the bubble below).
        //
        // AMEND #3: drop the FIFO-oldest match, and ONLY when EXACTLY ONE
        // optimistic same-text entry exists (findSoleOptimisticByText). With two
        // genuine same-text sends a newest-first guess would swap reply-linkage;
        // when ambiguous we wait for the exact nonce / queue_state snapshot.
        // See change: dashboard-message-queue (AMEND #2, AMEND #3).
        if (!removedByNonce && text && next.queue.length > 0) {
          // SURFACE B: pass the committing message's server-stamped author so
          // the sole-match REFUSES cross-author adoption (op-2's confirm never
          // re-keys op-1's same-text card). Flag-off (no author) → text-only.
          const soleIdx = findSoleOptimisticByText(next.queue, text, startAuthor);
          if (soleIdx !== -1) {
            if (!dispatchedAuthor) dispatchedAuthor = next.queue[soleIdx].author;
            next.queue = next.queue.filter((_, i) => i !== soleIdx);
          }
        }
        // Detect a wrapped <skill>...</skill> envelope so the renderer can show
        // a collapsible card and ArrowUp recall can return the slash form.
        // See change: render-skill-invocations-collapsibly.
        const skill = parseSkillBlock(text) ?? undefined;
        // SURFACE B: the committed turn's author — prefer the dispatched queue
        // entry's author (queued path, Surface A), else the author stamped on
        // this very `message_start` (immediate-0-queue turn-initiating path).
        const committedAuthor = dispatchedAuthor ?? startAuthor;
        next.messages = [
          ...next.messages,
          {
            id: `msg-${next.messages.length}`,
            role: "user",
            content: text,
            ...(skill ? { skill } : {}),
            ...(committedAuthor ? { author: committedAuthor } : {}),
            images,
            timestamp: event.timestamp,
            // entryId from data.entryId is correct ONLY for replayed events
            // (state-replay attaches the persisted id). For LIVE user
            // message_start the bridge no longer stamps entryId because
            // the user entry has not been persisted yet — it will arrive
            // via a later entry_persisted event keyed on `nonce`.
            // See change: fix-per-message-fork.
            entryId: data.entryId as string | undefined,
            nonce: data.nonce as string | undefined,
            // Audience is NOT known at message_start (the extension stamps at
            // message_end, whose result-envelope carries it). The stamped user
            // message_end back-fills `audience` by nonce below (Sol fix-cycle-3
            // F1: user rows ARE stamped now — the "absent for half the
            // conversation" gap is closed). Until then the classifier's
            // retrospective tier path applies (correct = the session's audience).
          },
        ];
      }
      break;
    }

    case "message_update": {
      const assistantEvent = data.assistantMessageEvent as any;

      // Handle thinking events from assistantMessageEvent
      if (assistantEvent) {
        if (assistantEvent.type === "thinking_start") {
          next.streamingThinking = "";
          next.thinkingStartedAt = event.timestamp;
          break;
        }
        if (assistantEvent.type === "thinking_delta") {
          next.streamingThinking = next.streamingThinking + (assistantEvent.delta ?? "");
          break;
        }
        if (assistantEvent.type === "thinking_end") {
          if (next.streamingThinking) {
            const startedAt = next.thinkingStartedAt;
            next.messages = [
              ...next.messages,
              {
                id: `thinking-${next.messages.length}`,
                role: "thinking",
                content: next.streamingThinking,
                timestamp: event.timestamp,
                startedAt,
                duration: startedAt ? event.timestamp - startedAt : undefined,
              },
            ];
          }
          next.streamingThinking = "";
          next.thinkingStartedAt = undefined;
          break;
        }
      }

      // Handle text streaming
      const msg = data.message as any;
      if (msg?.role === "assistant") {
        // If streamingText was already flushed for this message,
        // re-populating it here would re-show the flushed prefix below the
        // messages list (or, for [text, toolCall, text]-shaped messages,
        // would resurrect text1 alongside text2). Skip the assignment;
        // any post-flush text content is committed at message_end via the
        // existing reorder pass. See change:
        // fix-streaming-text-vs-interactive-ui-order.
        if (!next.streamingTextFlushed) {
          const text = Array.isArray(msg.content)
            ? msg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("")
            : String(msg.content ?? "");
          next.streamingText = text;
        }
      }
      break;
    }

    case "message_end": {
      const msg = data.message as any;
      if (msg?.role === "assistant") {
        if (next.streamingTextFlushed) {
          // Streaming text was already flushed at tool_execution_start.
          // Locate the unstamped flushed row and stamp entryId / nonce in
          // place — do NOT push a duplicate. The reorder pass below still
          // runs against the existing row. See change:
          // fix-streaming-text-vs-interactive-ui-order.
          const flushedIdx = findFlushedAssistantRowIndex(next.messages);
          if (flushedIdx >= 0) {
            const stamped: ChatMessage = {
              ...next.messages[flushedIdx],
              entryId: data.entryId as string | undefined,
              nonce: data.nonce as string | undefined,
              audience: readMessageAudience(msg),
            };
            next.messages = [
              ...next.messages.slice(0, flushedIdx),
              stamped,
              ...next.messages.slice(flushedIdx + 1),
            ];
          }
          // Note: streamingText is already "" because the flush cleared it.
          // We deliberately leave next.streamingText untouched here.
        } else if (next.streamingText) {
          next.messages = [
            ...next.messages,
            {
              id: `msg-${next.messages.length}`,
              role: "assistant",
              content: next.streamingText,
              timestamp: event.timestamp,
              entryId: data.entryId as string | undefined,
              nonce: data.nonce as string | undefined,
              audience: readMessageAudience(msg),
            },
          ];
          next.streamingText = "";
        } else {
          // Replay/fork scenario: streamingText is empty but message may have content
          const replayText = msg.content
            ? (Array.isArray(msg.content)
                ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
                : String(msg.content))
            : "";
          if (replayText) {
            next.messages = [
              ...next.messages,
              {
                id: `msg-${next.messages.length}`,
                role: "assistant",
                content: replayText,
                timestamp: event.timestamp,
                entryId: data.entryId as string | undefined,
                nonce: data.nonce as string | undefined,
                audience: readMessageAudience(msg),
              },
            ];
          } else {
            // Tool-only assistant turn (no prose) — add a thin separator
            // so consecutive tool call groups don't blend together
            const lastMsg = next.messages[next.messages.length - 1];
            if (lastMsg?.role === "toolResult") {
              next.messages = [
                ...next.messages,
                {
                  id: `sep-${next.messages.length}`,
                  role: "turnSeparator",
                  content: "",
                  timestamp: event.timestamp,
                },
              ];
            }
          }
        }

        // Reorder suffix so the assistant text bubble and its child tool
        // cards land in the order dictated by the model's content array.
        // Fast-path skipped inside the helper when no toolCall blocks.
        // See change: fix-text-tool-render-order.
        if (Array.isArray(msg?.content)) {
          next.messages = reorderToolCardsForAssistantMessage(next.messages, msg.content);
        }

        // R7 defense-in-depth: reset the flag at message_end so the flag's
        // lifecycle equals "between message_start and message_end". A stray
        // tool_execution_start arriving before the next message_start would
        // otherwise silently no-op the flush. See change:
        // fix-streaming-text-vs-interactive-ui-order.
        next.streamingTextFlushed = false;
      } else if (msg?.role === "user") {
        // F1 user-row back-fill (Sol fix-cycle-3): the user row is created at
        // message_start WITHOUT an audience (the extension stamps at message_end,
        // whose result-envelope carries it). The stamped user message_end arrives
        // here carrying `audience` + the same `nonce` the message_start row was
        // created with. Find that row by nonce and stamp its audience in place —
        // closing the "absent for half the conversation" FATAL. Fail-safe: if the
        // envelope carries no audience, leave the row's audience undefined (the
        // classifier's retrospective tier path still applies).
        const audience = readMessageAudience(msg);
        if (audience !== undefined) {
          const targetNonce = data.nonce as string | undefined;
          // Match the most-recent unstamped user row by nonce (the message_start
          // stamped `nonce` on the row); fall back to the last user row without an
          // audience when no nonce correlation is available.
          let idx = -1;
          for (let i = next.messages.length - 1; i >= 0; i--) {
            const m = next.messages[i];
            if (m.role !== "user") continue;
            if (m.audience !== undefined) continue;
            if (targetNonce ? m.nonce === targetNonce : true) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            const stamped: ChatMessage = { ...next.messages[idx], audience };
            next.messages = [
              ...next.messages.slice(0, idx),
              stamped,
              ...next.messages.slice(idx + 1),
            ];
          }
        }
      }
      break;
    }

    case "tool_execution_start": {
      const toolCallId = data.toolCallId as string;
      const toolName = data.toolName as string;

      // Flush any pending streamingText into a permanent assistant row
      // BEFORE pushing the new toolResult, so the message's content-array
      // order is preserved in messages[] for the entire tool runtime —
      // not just at message_end. The flush row's id is keyed on toolCallId
      // so replay is idempotent. See changes:
      // fix-streaming-text-vs-interactive-ui-order,
      // fix-replay-duplicates-tool-and-flushed-rows.
      if (next.streamingText && !next.streamingTextFlushed) {
        Object.assign(
          next,
          flushStreamingTextAsAssistantRow(next, event.timestamp, toolCallId),
        );
      }
      const args = data.args as Record<string, unknown> | undefined;
      next.toolCalls.set(toolCallId, {
        toolCallId,
        toolName,
        args,
        status: "running",
      });
      next.currentTool = toolName;

      // Track file-modifying tools
      const toolLower = toolName.toLowerCase();
      if (toolLower === "write" || toolLower === "edit") {
        next.hasFileChanges = true;
      }

      // Idempotency on toolCallId: if any row already exists for this
      // toolCallId (re-replay, reconnect re-replay), update it in place
      // instead of pushing a duplicate React key. The id `tool-${toolCallId}`
      // is the React key, so a fresh push would always collide — there's no
      // safe "fall-through to push" branch. We refresh args/toolName/timestamps
      // only; result/duration/toolDetails/images/toolStatus remain so terminal
      // rows keep their finalised data on re-replay of the start event.
      // See change: fix-replay-duplicates-tool-and-flushed-rows.
      const existingToolIdx = next.messages.findLastIndex(
        (m) => m.role === "toolResult" && m.toolCallId === toolCallId,
      );
      if (existingToolIdx !== -1) {
        next.messages = [...next.messages];
        next.messages[existingToolIdx] = {
          ...next.messages[existingToolIdx],
          toolName,
          args,
          // Keep startedAt/timestamp from the original row — the existing
          // values are already correct for terminal rows, and refreshing them
          // would invalidate `duration` derived from startedAt at end-time.
        };
        break;
      }

      // Add tool message immediately (visible while running)
      next.messages = [
        ...next.messages,
        {
          id: `tool-${toolCallId}`,
          role: "toolResult",
          content: toolName,
          toolName,
          toolCallId,
          args,
          toolStatus: "running",
          timestamp: event.timestamp,
          startedAt: event.timestamp,
        },
      ];
      break;
    }

    case "tool_execution_update": {
      const toolCallId = data.toolCallId as string;
      const partialResult = data.partialResult;
      if (partialResult) {
        const idx = next.messages.findLastIndex((m) => m.toolCallId === toolCallId);
        if (idx !== -1) {
          next.messages = [...next.messages];
          // Structured partialResult (e.g. Agent tool sends { content, details })
          if (typeof partialResult === "object" && partialResult !== null) {
            const structured = partialResult as Record<string, unknown>;
            const details = structured.details as Record<string, unknown> | undefined;
            // Extract text from content array or stringify
            let text: string | undefined;
            const content = structured.content;
            if (Array.isArray(content) && content.length > 0 && content[0]?.text) {
              text = content[0].text as string;
            } else if (content != null) {
              text = String(content);
            }
            next.messages[idx] = {
              ...next.messages[idx],
              ...(text != null ? { result: truncateLines(text, 30) } : {}),
              ...(details ? { toolDetails: details } : {}),
            };
          } else {
            // Plain string partialResult (standard tools)
            next.messages[idx] = {
              ...next.messages[idx],
              result: truncateLines(partialResult as string, 30),
            };
          }
        }
      }
      break;
    }

    case "tool_execution_end": {
      const toolCallId = data.toolCallId as string;
      const existing = next.toolCalls.get(toolCallId);
      if (existing) {
        next.toolCalls.set(toolCallId, {
          ...existing,
          status: (data.isError as boolean) ? "error" : "complete",
        });
      }
      next.currentTool = undefined;

      // Extract images from tool result (live events have result.content, replayed have data.images)
      const images = extractToolResultImages(data);

      // Update existing tool message in-place
      const idx = next.messages.findLastIndex((m) => m.toolCallId === toolCallId);
      if (idx !== -1) {
        const result = data.result as string | undefined;
        const msgStartedAt = next.messages[idx].startedAt;
        next.messages = [...next.messages];
        // Extract tool details (e.g. AgentDetails from replayed sessions)
        const endDetails = data.details as Record<string, unknown> | undefined;
        // For live events (no endDetails), update existing toolDetails.status
        // so renderers (e.g. AgentToolRenderer) see the final status
        const isError = data.isError as boolean;
        let mergedDetails: Record<string, unknown> | undefined;
        if (endDetails) {
          mergedDetails = endDetails;
        } else if (next.messages[idx].toolDetails) {
          mergedDetails = {
            ...next.messages[idx].toolDetails,
            status: isError ? "error" : "completed",
          };
        }
        next.messages[idx] = {
          ...next.messages[idx],
          toolStatus: isError ? "error" : "complete",
          result: result ? truncateLines(result, 30) : next.messages[idx].result,
          duration: msgStartedAt ? event.timestamp - msgStartedAt : undefined,
          ...(images ? { images } : {}),
          ...(mergedDetails ? { toolDetails: mergedDetails } : {}),
        };
      }
      break;
    }

    case "turn_end":
      break;

    case "stats_update": {
      // Accumulate stats from stats_update events
      if (data.tokensIn) next.tokensIn += data.tokensIn as number;
      if (data.tokensOut) next.tokensOut += data.tokensOut as number;
      if (data.cost) next.cost += data.cost as number;

      // Extract per-turn usage and accumulate cache stats
      const turnUsage = data.turnUsage as Record<string, number> | undefined;
      if (turnUsage) {
        // Assign turnIndex to the last user message for scroll-to-turn navigation
        const lastUserIdx = next.messages.findLastIndex((m) => m.role === "user");
        let assignedTurnIndex = -1;
        if (lastUserIdx !== -1 && next.messages[lastUserIdx].turnIndex === undefined) {
          assignedTurnIndex = next.turnCount;
          next.messages = [...next.messages];
          next.messages[lastUserIdx] = { ...next.messages[lastUserIdx], turnIndex: next.turnCount };
          next.turnCount += 1;
        }

        const turnStat: TurnStat = {
          input: turnUsage.input ?? 0,
          output: turnUsage.output ?? 0,
          cacheRead: turnUsage.cacheRead ?? 0,
          cacheWrite: turnUsage.cacheWrite ?? 0,
          turnIndex: assignedTurnIndex,
        };
        next.turnStats = [...next.turnStats, turnStat].slice(-MAX_TURN_STATS);
        next.cacheRead += turnStat.cacheRead;
        next.cacheWrite += turnStat.cacheWrite;
      }

      // Extract context usage
      const ctxUsage = data.contextUsage as { tokens: number | null; contextWindow: number } | undefined;
      if (ctxUsage) {
        next.contextUsage = ctxUsage;
      }
      break;
    }

    case "model_select": {
      const model = data.model as any;
      if (model) {
        next.model = `${model.provider}/${model.id}`;
      }
      const thinkingLevel = data.thinkingLevel as string | undefined;
      if (thinkingLevel !== undefined) {
        next.thinkingLevel = thinkingLevel;
      }
      break;
    }

    case "session_compact": {
      next.messages = [
        ...next.messages,
        {
          id: `compact-${next.messages.length}`,
          role: "assistant",
          content: "── Session compacted ──",
          timestamp: event.timestamp,
        },
      ];
      break;
    }

    case "bash_output": {
      const command = data.command as string;
      const output = data.output as string;
      const exitCode = data.exitCode as number;
      const excludeFromContext = data.excludeFromContext as boolean;
      next.pendingPrompt = undefined;
      next.messages = [
        ...next.messages,
        {
          id: `bash-${next.messages.length}`,
          role: "bashOutput" as any,
          content: output,
          timestamp: event.timestamp,
          args: { command, exitCode, excludeFromContext } as any,
        },
      ];
      break;
    }

    case "command_feedback": {
      const command = data.command as string;
      const status = data.status as string;
      const message = data.message as string | undefined;
      next.pendingPrompt = undefined;
      // Upsert: a terminal status (completed/error) for the same command
      // transitions the most recent matching started row in place, instead of
      // appending a duplicate. Keeps chat clean for started → terminal pairs.
      // See change: fix-extension-slash-commands-in-dashboard.
      if (status === "completed" || status === "error") {
        let replaced = false;
        const updated = next.messages.slice();
        for (let i = updated.length - 1; i >= 0; i--) {
          const m = updated[i] as any;
          if (
            m?.role === "commandFeedback" &&
            m?.args?.command === command &&
            m?.args?.status === "started"
          ) {
            updated[i] = {
              ...m,
              content: message ?? "",
              timestamp: event.timestamp,
              args: { command, status },
            };
            replaced = true;
            break;
          }
        }
        if (replaced) {
          next.messages = updated;
          break;
        }
      }
      next.messages = [
        ...next.messages,
        {
          id: `cmdfb-${next.messages.length}`,
          role: "commandFeedback" as any,
          content: message ?? "",
          timestamp: event.timestamp,
          args: { command, status } as any,
        },
      ];
      break;
    }

    case "subagent_created": {
      const id = data.id as string;
      next.subagents = new Map(next.subagents);
      next.subagents.set(id, {
        id,
        type: data.type as string ?? "unknown",
        description: data.description as string ?? "",
        status: "created",
      });
      break;
    }

    case "subagent_started": {
      const id = data.id as string;
      next.subagents = new Map(next.subagents);
      const existing = next.subagents.get(id);
      next.subagents.set(id, {
        ...(existing ?? { id, type: data.type as string ?? "unknown", description: data.description as string ?? "" }),
        status: "running",
      });
      break;
    }

    case "subagent_completed":
    case "subagent_failed": {
      const id = data.id as string;
      next.subagents = new Map(next.subagents);
      const existing = next.subagents.get(id);
      next.subagents.set(id, {
        ...(existing ?? { id, type: data.type as string ?? "unknown", description: data.description as string ?? "" }),
        status: event.eventType === "subagent_completed" ? "completed" : "failed",
        result: data.result as string | undefined,
        error: data.error as string | undefined,
        durationMs: data.durationMs as number | undefined,
        tokens: data.tokens as SubagentState["tokens"],
        toolUses: data.toolUses as number | undefined,
      });
      break;
    }

    case "message_enqueued": {
      // Message-queue enqueue confirmation (dashboard-message-queue/v1).
      // The bridge acked a follow-up enqueue. Reconcile by queueNonce:
      //   - matches an existing optimistic entry → flip it to "confirmed".
      //   - no exact-nonce match → conservative TEXT fallback (AMEND #2,
      //     hardened AMEND #3): adopt this confirmation onto the FIFO-oldest
      //     still-optimistic entry with the same text, but ONLY when EXACTLY ONE
      //     such entry exists (findSoleOptimisticByText) — re-keying it to the
      //     bridge's nonce so the later message_start(queueNonce) dispatch +
      //     reply-linkage match. With multiple same-text optimistics we do NOT
      //     guess (a newest-first guess would SWAP nonces → reply mis-linkage);
      //     wait for the exact nonce / queue_state snapshot. ONLY append a fresh
      //     card when there is genuinely no optimistic card to confirm (true
      //     TUI-origin). This prevents the DOUBLING bug (append-on-any-no-match).
      //   - Idempotent: a duplicate event for an already-confirmed nonce no-ops.
      const queueNonce = data.queueNonce as string | undefined;
      if (!queueNonce) break;
      // AMEND #5 (f) idempotency-guard: a confirmation for a retry-superseded
      // OLD nonce is INERT — do NOT adopt, re-key (no flip-flop onto the NEW
      // card), nor append (no duplicate). The OLD send is a ghost; the NEW
      // (retry) card is live. See SessionState.supersededNonces.
      if (next.supersededNonces.has(queueNonce)) break;
      const text = typeof data.text === "string" ? data.text : "";
      const source = data.source === "tui" ? "tui" : "dashboard";
      const images = mapWireImagesToChat(data.images);
      // Server-stamped author (Surface A). Thread it onto the queue entry so a
      // committed turn can render attribution; A just THREADS, no reconciliation.
      const author = extractMessageAuthor(data.author);
      let existingIdx = next.queue.findIndex((q) => q.queueNonce === queueNonce);
      // Conservative text fallback: no exact nonce match → the SOLE FIFO-oldest
      // optimistic entry with matching text (or -1 when zero/multiple). Re-key
      // it to the bridge's nonce.
      // SURFACE B: scope the fallback to the confirming author — REFUSE
      // cross-author re-key (op-2's message_enqueued must never adopt op-1's
      // same-text optimistic card onto op-2's nonce). Flag-off (no author) →
      // text-only, byte-unchanged.
      let reKey = false;
      if (existingIdx === -1) {
        const soleIdx = findSoleOptimisticByText(next.queue, text, author);
        if (soleIdx !== -1) {
          existingIdx = soleIdx;
          reKey = true;
        }
      }
      if (existingIdx !== -1) {
        if (next.queue[existingIdx].state === "confirmed" && !reKey) break;
        next.queue = next.queue.slice();
        next.queue[existingIdx] = {
          ...next.queue[existingIdx],
          ...(reKey ? { queueNonce } : {}),
          state: "confirmed",
          source,
          // Prefer the bridge's text/images (authoritative) but keep the
          // optimistic createdAt for stable ordering/age.
          text: text || next.queue[existingIdx].text,
          ...(images ? { images } : {}),
          ...(author ? { author } : {}),
        };
      } else {
        // SOURCE-AWARE append (AMEND #4 F3): the append branch must NOT add a
        // fresh card when this is a DASHBOARD confirmation that still has an
        // ambiguous same-text optimistic awaiting reconciliation. A dashboard
        // confirmation ALWAYS corresponds to a client-created optimistic card;
        // when the sole-match fallback above declined (because MULTIPLE
        // same-text optimistics exist → it returns -1, no guess), appending
        // here would duplicate — re-opening the doubling bug on the append
        // branch. Instead WAIT for the exact queueNonce or the authoritative
        // queue_state snapshot to reconcile in send-order. Only append when:
        //   - source === "tui" (a real separate origin, no client card), OR
        //   - source === "dashboard" but there is genuinely NO same-text
        //     optimistic (e.g. the optimistic already cleared/failed).
        // See change: dashboard-message-queue (AMEND #4).
        const sameTextOptimistic = next.queue.some(
          (q) => q.state === "optimistic" && q.text === text,
        );
        if (source === "dashboard" && sameTextOptimistic) break;
        next.queue = [
          ...next.queue,
          {
            queueNonce,
            text,
            ...(images ? { images } : {}),
            state: "confirmed",
            source,
            ...(author ? { author } : {}),
            createdAt: event.timestamp,
          },
        ];
      }
      break;
    }

    case "queue_state": {
      // Message-queue authoritative snapshot (dashboard-message-queue/v1).
      // The bridge's reconstructed follow-up order. ATOMIC-REPLACE the
      // confirmed portion (sister to sessions_snapshot's replace-not-merge),
      // while reconciling this client's not-yet-confirmed entries:
      //   - "optimistic": still in-flight to the bridge.
      //   - "failed": user-visible loss marker.
      //
      // AMEND #5 (F4) — authoritative-SUPERSEDE, count-based by text. The
      // snapshot is authoritative for its confirmed-portion: it must SUPERSEDE
      // the same-text optimistic/failed entries it covers, not preserve them as
      // duplicates. Nonce-keyed-only reconciliation duplicated under a
      // nonce-MISMATCH (snapshot carries bridge-nonces ≠ the client's optimistic
      // nonces for the same message): [o1,o2 opt "same"] + snapshot
      // [bridge1,bridge2 "same"] → 4 cards. (F3's append-fix WAITS for
      // queue_state to reconcile — so queue_state must not itself duplicate.)
      //
      // Identity rule (consistent with adopt/append): exact-nonce wins; the
      // snapshot supersedes the FIFO-oldest same-text optimistics it covers
      // (count-based, since a snapshot can confirm MULTIPLE same-text at once);
      // optimistics beyond the snapshot's same-text count stay preserved (newer,
      // not yet acked). NEVER render both a snapshot-confirmed entry AND its
      // corresponding optimistic.
      // AMEND #5 (f) idempotency-guard: drop any snapshot entry whose nonce is
      // retry-superseded BEFORE reconciling. A ghost OLD-send still lingering in
      // the bridge's reconstructed snapshot must NOT build a confirmed card, nor
      // create a same-text supersede-slot that could claim the NEW (retry) card.
      // The single filter here flows into snapshotNonces / confirmed /
      // supersedeSlots below. See SessionState.supersededNonces.
      const followUp = (Array.isArray(data.followUp) ? data.followUp : []).filter(
        (f: any) => !(typeof f?.queueNonce === "string" && next.supersededNonces.has(f.queueNonce)),
      );
      const snapshotNonces = new Set(
        followUp.map((f: any) => f?.queueNonce).filter(Boolean),
      );
      const byNonce = new Map(next.queue.map((q) => [q.queueNonce, q]));
      // 1. Build confirmed from the snapshot. A snapshot entry whose nonce
      //    exact-matches a client entry inherits its text/images/createdAt/source.
      const confirmed: QueuedMessage[] = followUp.map((f: any, i: number) => {
        const nonce = (f?.queueNonce as string | undefined) ?? `tui-${event.timestamp}-${i}`;
        const prior = f?.queueNonce ? byNonce.get(f.queueNonce) : undefined;
        return {
          queueNonce: nonce,
          text: typeof f?.text === "string" ? f.text : prior?.text ?? "",
          ...(prior?.images ? { images: prior.images } : {}),
          state: "confirmed" as const,
          // AMEND #6 / F5: an exact-matched entry inherits the client's source;
          // otherwise use the snapshot entry's own stamped source; default "tui".
          source: prior?.source ?? (f?.source === "dashboard" || f?.source === "tui" ? f.source : "tui"),
          createdAt: prior?.createdAt ?? event.timestamp,
        };
      });
      // 2. Supersede-slots by text — ONLY from snapshot entries that are
      //    DASHBOARD-origin AND did NOT exact-match a client nonce. AMEND #6 /
      //    F5 (origin axis): a "tui"-origin (or source-absent) snapshot entry is
      //    a SEPARATE confirmed card and must create NO supersede-slot — it must
      //    never consume a dashboard optimistic by text (that would drop a real
      //    dashboard send and violate "TUI-origin stays separate"). A re-keyed
      //    dashboard snapshot entry (source:"dashboard") still text-supersedes
      //    its dashboard optimistic — F4's duplicate-fix is preserved.
      const supersedeSlots = new Map<string, number>();
      for (const f of followUp) {
        const fNonce = (f as any)?.queueNonce as string | undefined;
        const matchedClientNonce = fNonce !== undefined && byNonce.has(fNonce);
        if (matchedClientNonce) continue; // already adopted by exact nonce
        if ((f as any)?.source !== "dashboard") continue; // origin-gate: TUI/absent → no slot
        const t = typeof (f as any)?.text === "string" ? (f as any).text : "";
        if (!t) continue;
        supersedeSlots.set(t, (supersedeSlots.get(t) ?? 0) + 1);
      }
      // 3. Walk optimistic/failed entries in FIFO order; drop if exact-nonce in
      //    snapshot OR a same-text supersede slot is available (consume one);
      //    else preserve (genuinely newer than the snapshot).
      const preserved: QueuedMessage[] = [];
      for (const q of next.queue) {
        if (q.state !== "optimistic" && q.state !== "failed") continue;
        if (snapshotNonces.has(q.queueNonce)) continue; // exact-superseded
        const slot = supersedeSlots.get(q.text) ?? 0;
        if (slot > 0) {
          supersedeSlots.set(q.text, slot - 1); // text-superseded (FIFO-oldest first)
          continue;
        }
        preserved.push(q);
      }
      // 4. Authoritative confirmed block first, then the genuinely-newer
      //    not-yet-acked entries.
      next.queue = [...confirmed, ...preserved];
      break;
    }

    case "entry_persisted": {
      // Bridge-emitted back-fill: when pi persists a user/assistant entry
      // and assigns its id, the bridge sends entry_persisted { entryId, nonce }.
      // We find the ChatMessage created from the matching message_start /
      // message_end (by nonce) and stamp its entryId. This unlocks the
      // per-message Fork button. See change: fix-per-message-fork.
      const targetNonce = data.nonce as string | undefined;
      const persistedEntryId = data.entryId as string | undefined;
      if (targetNonce && persistedEntryId) {
        let mutated = false;
        const updated = next.messages.map((m) => {
          if (!m.entryId && m.nonce === targetNonce) {
            mutated = true;
            return { ...m, entryId: persistedEntryId };
          }
          return m;
        });
        if (mutated) next.messages = updated;
      }
      break;
    }

    default: {
      // Delegate flow events to flow reducer
      if (isFlowEvent(event.eventType)) {
        next.flowState = reduceFlowEvent(next.flowState, event);
        // Keep flowStates map in sync — store each flow by name
        if (next.flowState) {
          next.flowStates = new Map(next.flowStates);
          next.flowStates.set(next.flowState.flowName, next.flowState);
        } else if (event.eventType === "flow_summary_dismissed") {
          next.flowStates = new Map();
        }
      } else {
        // Unknown event type — render as expandable raw JSON
        next.messages = [...next.messages, {
          id: `raw-${event.eventType}-${event.timestamp}-${next.messages.length}`,
          role: "rawEvent" as const,
          content: JSON.stringify(event.data, null, 2),
          timestamp: event.timestamp,
          toolName: event.eventType,
        }];
      }
      // Delegate architect events to architect reducer
      if (isArchitectEvent(event.eventType)) {
        next.architectState = reduceArchitectEvent(next.architectState, event);
      }
      break;
    }
  }

  // Bug #3 fix: rebuild the messagesIndex lookup-table whenever the
  // messages array reference has changed during this event. O(n) cost
  // — same complexity as the existing per-event walks — but enables
  // O(1) consumer-side lookups by id (see
  // resolveInteractiveRequest / dismissInteractiveRequest above).
  //
  // Preserving the prior `messagesIndex` reference when messages did
  // not change avoids spurious downstream Map-reference comparisons.
  // See change: bug-3-messages-index-lookup-table.
  if (next.messages !== state.messages) {
    next.messagesIndex = rebuildMessagesIndex(next.messages);
  }

  return next;
}
