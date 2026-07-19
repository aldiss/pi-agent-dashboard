/**
 * Pure-function classifier + filter pass for the 6-category message
 * taxonomy per W3 Q2 recommended-default. Discrimination is based on
 * `ChatMessage.role` + `.skill` + `.toolName` + the embedded
 * `interactiveUi.params.method` payload — never on rendered DOM, never on
 * a network round-trip. The filter pass runs against the post-grouping
 * `ChatItem[]` so collapsed tool-call groups + retried-error badges
 * keep their existing semantics.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.2 Feature 2).
 */

import type { ChatMessage } from "./event-reducer.js";
import type { ChatItem, ToolCallGroup } from "./group-tool-calls.js";
import type { MessageFilter } from "./message-filter-storage.js";
import { DEFAULT_MESSAGE_FILTER } from "./message-filter-storage.js";

export type MessageCategory =
  | "tierA"
  | "tierB"
  | "tierC"
  | "meshChatter"
  | "toolCalls"
  | "systemNotifications";

// System notifications — debug-shaped rows the operator can dim away when
// scanning. `thinking` was previously classified here but is operator-visible
// narrative reasoning content (see fix-thinking-block-streaming-state-loss-
// 2026-05-25 + sister commit 22978a8). Reclassified to `tierB` so committed
// thinking rows render under default filter (which has
// systemNotifications: false but tierB: true).
const SYSTEM_ROLES: ReadonlySet<ChatMessage["role"]> = new Set<ChatMessage["role"]>([
  "turnSeparator",
  "rawEvent",
]);

/** Roles that always classify as tool-calls (UI-side ToolCallStep / BashOutput / CommandFeedback). */
const TOOL_CALL_ROLES: ReadonlySet<ChatMessage["role"]> = new Set<ChatMessage["role"]>([
  "toolResult",
  "bashOutput",
  "commandFeedback",
]);

/**
 * POSITIVE-EVIDENCE historical origin (B2 — restore the v3 retrospective floor).
 *
 * The retrospective classifier for a PRE-STAMP `user`/`assistant` row (no live
 * `audience` stamp) must decide operator-vs-agent from metadata PERSISTED AT THE
 * TIME the session ran — NOT today's role registry and NOT the sidebar
 * `classifyTier` (which reads the standing-crew NAME regex + registry-derived
 * name; Sol F4/G3: that lets today's registry leak into the audience path). The
 * evidence fields are exactly the ones a session persisted about ITSELF:
 *
 *   - `sessionFile`: the on-disk session path. A cell-internal WORKER writes to
 *     `…/run-<n>/session.jsonl` — positive evidence of a mesh worker.
 *   - `cwd`: a CELL-EXECUTOR runs under `…/.pi/cells/…` — positive evidence of a
 *     mesh cell.
 *   - `source`: captured at spawn from the environment (`tui`/`tmux`/`zed`/…) and
 *     persisted in the `.meta.json` sidecar. `tui` = the operator's own
 *     interactive pane — positive evidence of operator-addressed.
 *
 * The `name` is DELIBERATELY absent: a name is today's registry/naming
 * convention, not persisted-at-the-time origin. Absent positive evidence →
 * `unknown` (shown + exempt), NEVER hidden.
 */
export interface HistoricalOriginEvidence {
  /** On-disk session path (worker → `…/run-N/session.jsonl`). */
  sessionFile?: string | undefined;
  /** Working directory (cell-executor → contains `/.pi/cells/`). */
  cwd?: string | undefined;
  /** Spawn-env source persisted in `.meta.json` (`tui` = operator pane). */
  source?: string | undefined;
}

/**
 * Session context for the operator-addressed classification (coverage-contract
 * #1). Carries the PERSISTED-AT-THE-TIME positive evidence (B2) so a pre-stamp
 * `user`/`assistant` row is classified operator-vs-mesh WITHOUT consulting
 * today's registry. `role` alone can't decide it (a `user` row in a worker
 * session is a mesh-injected dispatch brief; a worker's `assistant` reply is
 * addressed to its dispatcher, not the operator).
 */
export interface AudienceSessionCtx {
  /** Persisted-at-the-time origin evidence for the owning session (B2). */
  evidence?: HistoricalOriginEvidence;
}

/** A cell-internal worker writes its session to `…/run-<n>/session.jsonl`. */
const WORKER_SESSION_FILE_RE = /\/run-\d+\/session\.jsonl$/;

/**
 * Project a session's persisted fields into the historical-origin evidence the
 * retrospective classifier reads (B2). Pure; structurally typed so it does not
 * depend on the full `DashboardSession`. App.tsx calls this per selected
 * session; the classifier consumes ONLY the projected evidence (no registry, no
 * `classifyTier`).
 */
export function deriveHistoricalEvidence(session: {
  sessionFile?: string | undefined;
  cwd?: string | undefined;
  source?: string | undefined;
}): HistoricalOriginEvidence {
  return { sessionFile: session.sessionFile, cwd: session.cwd, source: session.source };
}

/**
 * The audience stamp is a versioned, runtime-VALIDATED field (F1/F2). The wire
 * value is untrusted external data; the TypeScript union is NOT validation.
 * `readAudienceStamp` distinguishes states so the caller treats a corrupt/unknown
 * PRESENT stamp differently from a truly-ABSENT one (Sol fix-cycle-3 F2):
 *   - "valid":   a recognized "operator"/"agent" value → use it (source of truth).
 *   - "unknown": the ratified 3rd state (a live producer that could NOT prove
 *                operator) → SHOWN, but EXEMPT from lint. Distinct from agent.
 *   - "corrupt": a present-but-unrecognized value INCLUDING `null` (Sol F2: the
 *                wire reader used to map `null`→absent→retrospective→hidden in a
 *                worker ctx) → FAIL-OPEN to shown, NEVER fall through to the
 *                retrospective. "unclassifiable-but-present → shown", never hidden.
 *   - "absent":  ONLY `undefined` (no stamp) → the retrospective heuristic decides.
 * Bump `AUDIENCE_SCHEMA_VERSION` + this validator together if the variant set
 * ever changes.
 */
export const AUDIENCE_SCHEMA_VERSION = 2;
const AUDIENCE_VALUES = new Set<string>(["operator", "agent"]);

export type AudienceStampRead =
  | { state: "valid"; value: "operator" | "agent" }
  | { state: "unknown" }
  | { state: "corrupt" }
  | { state: "absent" };

export function readAudienceStamp(value: unknown): AudienceStampRead {
  // ONLY `undefined` is truly-absent (→ retrospective). `null` is a present wire
  // value → corrupt → fail-open shown (Sol F2: null must NOT hide in a worker ctx).
  if (value === undefined) return { state: "absent" };
  if (value === "unknown") return { state: "unknown" }; // ratified 3rd state
  if (typeof value === "string" && AUDIENCE_VALUES.has(value)) {
    return { state: "valid", value: value as "operator" | "agent" };
  }
  return { state: "corrupt" }; // present-but-invalid (incl null) → fail-open at the caller
}

/**
 * Retrospective audience for a pre-stamp `user`/`assistant` row, from POSITIVE
 * persisted-at-the-time evidence (B2 — the restored v3 floor). Returns the
 * 3-state audience:
 *   - worker session path (`…/run-N/session.jsonl`) → "agent" (mesh worker).
 *   - cell-executor cwd (`…/.pi/cells/…`)          → "agent" (mesh cell).
 *   - source === "tui" (the operator's own pane)    → "operator".
 *   - ABSENT positive evidence                      → "unknown" (SHOWN + exempt).
 *
 * Absent-evidence projects `unknown`, NOT a fail-open `operator` guess and NOT a
 * name-registry lookup — the §1.9 classifier-SPOF mitigation with the correct
 * safety asymmetry (a truly-unclassifiable pre-stamp row is SHOWN, never hidden,
 * and never retro-linted on a registry guess). Going forward the FORWARD stamp
 * (B3) supersedes this for every live row.
 */
export function historicalAudience(evidence?: HistoricalOriginEvidence): "operator" | "agent" | "unknown" {
  if (!evidence) return "unknown"; // no evidence → shown + exempt (not a guess)
  if (evidence.sessionFile && WORKER_SESSION_FILE_RE.test(evidence.sessionFile)) return "agent";
  if ((evidence.cwd ?? "").includes("/.pi/cells/")) return "agent";
  if (evidence.source === "tui") return "operator";
  return "unknown"; // no positive evidence → shown + exempt
}

/**
 * Classify a single ChatMessage or a grouped ToolCallGroup into one of the
 * six categories. Grouped tool-calls always classify as `toolCalls` since
 * groupConsecutiveToolCalls only forms groups from same-tool toolResult
 * rows (see group-tool-calls.ts).
 *
 * `sessionCtx` (optional) supplies the owning session's tier for the
 * operator-addressed vs mesh-chatter decision on plain user/assistant rows.
 * Omitted → the retrospective heuristic fails open to operator-addressed.
 */
export function classifyMessage(
  msg: ChatMessage | ToolCallGroup,
  sessionCtx?: AudienceSessionCtx,
): MessageCategory {
  // Grouped tool calls: always tool-calls category.
  if ((msg as ToolCallGroup).type === "group") return "toolCalls";

  const m = msg as ChatMessage;

  // Tier-A — operator-direct interactive cards (PromptBus / pi-tui asks).
  // Covers ask_user / select / batch / input / confirm / multiselect.
  if (m.role === "interactiveUi") return "tierA";

  // Thinking — model reasoning content; narrative not system-notification.
  // Explicit clause for readability + future-resilience against the
  // defensive default at function-end being changed. See fix-thinking-block-
  // streaming-state-loss-2026-05-25.
  if (m.role === "thinking") return "tierB";

  // System notifications — turnSeparator / raw debug events.
  if (SYSTEM_ROLES.has(m.role)) return "systemNotifications";

  // Tool calls — toolResult / bashOutput / commandFeedback rows.
  // commandFeedback is borderline (it can announce a /-command status,
  // which feels narrative); the W4.2 brief routes it under tool-calls
  // because its render component is the same BashOutput-adjacent surface.
  if (TOOL_CALL_ROLES.has(m.role)) return "toolCalls";

  // Skill invocation on a user message renders as a SkillInvocationCard
  // (substantive content, not chatter). Per W4.2 brief: classify as Tier-B
  // narrative content.
  if (m.role === "user" && m.skill) return "tierB";

  // Plain user / assistant text rows: operator-addressed vs mesh-chatter.
  // THE :83 FIX (coverage-contract #1). Previously this returned `meshChatter`
  // for EVERY plain user/assistant row — mislabeling an agent's reply *to the
  // operator* AND the operator's own typed prompts as chatter, so the "Mesh
  // chatter" toggle hid both. Now:
  //   - stamp-at-emit wins (source of truth): `m.audience` when present;
  //   - else the retrospective heuristic derives audience from persisted-at-the-
  //     time positive evidence (B2 — worker path / cell cwd / tui source), NOT
  //     today's registry;
  //   - operator-addressed → `tierB` (visible-by-default + the operator-voice
  //     lint sees it); agent-addressed → `meshChatter` (internal mesh, §16
  //     left alone). One definition, two projections: the lint consumes the
  //     DIRECTION; the toggle keeps the operator CONVERSATION.
  if (m.role === "user" || m.role === "assistant") {
    // Runtime-validate the wire stamp (F1/F2). The classifier owns the VISIBILITY
    // axis (operator + unknown + corrupt → shown; agent → hide-eligible); the
    // extension Door-3 owns the LINT axis independently. Four states:
    //   - valid   → use the stamp (the authoritative source of truth).
    //   - unknown → the ratified 3rd state → SHOWN (tierB), not hidden.
    //   - corrupt → present-but-invalid (incl null) → FAIL-OPEN to shown (NEVER
    //               fall through to the retrospective, which could hide it as
    //               meshChatter in a worker ctx — the Sol F2 fail-closed bug).
    //   - absent  → no live stamp → the B2 positive-evidence retrospective decides
    //               (worker/cell → agent; tui → operator; absent evidence →
    //               unknown → SHOWN, never a registry guess).
    const read = readAudienceStamp(m.audience);
    let audience: "operator" | "agent" | "unknown";
    if (read.state === "valid") audience = read.value;
    else if (read.state === "unknown") audience = "unknown"; // shown (visibility axis)
    else if (read.state === "corrupt") audience = "unknown"; // fail-open: shown
    else audience = historicalAudience(sessionCtx?.evidence);
    // VISIBILITY projection: operator + unknown → SHOWN (tierB); agent → hide-eligible.
    return audience === "agent" ? "meshChatter" : "tierB";
  }

  // Defensive default: anything not enumerated above falls into Tier-B
  // (visible by default) rather than disappearing. New role values added
  // upstream will surface until classifier is updated.
  return "tierB";
}

/**
 * Pre-render filter pass. Returns the subset of items the operator wants
 * to see given the current filter. Pinned entries (Feature 3 sister-coupling)
 * are exempt via `alwaysVisibleEntryIds` — pinned messages always render
 * regardless of category.
 *
 * Composes cleanly with CollapsedToolGroup + RetriedErrorBadge logic in
 * ChatView because filtering happens on the post-grouping ChatItem[] and
 * the renderer's existing visibility checks (hiddenToolResultIds /
 * retriedErrorIds) operate on the still-intact ChatMessage references.
 */
export function filterMessages(
  items: ChatItem[],
  filter: MessageFilter,
  options?: { alwaysVisibleEntryIds?: Set<string>; sessionCtx?: AudienceSessionCtx }
): ChatItem[] {
  const alwaysVisible = options?.alwaysVisibleEntryIds;
  const sessionCtx = options?.sessionCtx;
  return items.filter((item) => {
    // Pinned items (by entryId) are always visible, regardless of category.
    if (alwaysVisible && alwaysVisible.size > 0) {
      if ((item as ToolCallGroup).type === "group") {
        const group = item as ToolCallGroup;
        for (const m of group.messages) {
          if (m.entryId && alwaysVisible.has(m.entryId)) return true;
        }
      } else {
        const m = item as ChatMessage;
        if (m.entryId && alwaysVisible.has(m.entryId)) return true;
      }
    }

    const category = classifyMessage(item, sessionCtx);
    return filter[category];
  });
}

/**
 * Diagnostic helper: count messages per-category for the pill counts
 * shown in MessageFilterControls. Counts pre-filter so the operator can
 * see "how many messages would this toggle reveal/hide" before flipping it.
 */
export function countMessagesByCategory(
  items: ChatItem[],
  sessionCtx?: AudienceSessionCtx,
): Record<MessageCategory, number> {
  const counts: Record<MessageCategory, number> = {
    tierA: 0,
    tierB: 0,
    tierC: 0,
    meshChatter: 0,
    toolCalls: 0,
    systemNotifications: 0,
  };
  for (const item of items) {
    counts[classifyMessage(item, sessionCtx)]++;
  }
  return counts;
}

/**
 * Convenience: returns true when every category is enabled (equivalent to
 * no-filter, which the renderer can use to skip the filter pass entirely
 * for the common all-on case).
 */
export function isAllOn(filter: MessageFilter): boolean {
  return (
    filter.tierA &&
    filter.tierB &&
    filter.tierC &&
    filter.meshChatter &&
    filter.toolCalls &&
    filter.systemNotifications
  );
}

/** Re-export so consumers only need one import path. */
export { DEFAULT_MESSAGE_FILTER };
export type { MessageFilter };
