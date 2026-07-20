/**
 * ThreadHistoryLanes — the THREE source-separated, read-only history lanes
 * (design v0.3 Tier-1 §"What Tier-1 IS" #3). Each lane is shown in its OWN
 * native committed order, EXPLICITLY labeled incomplete / non-authoritative /
 * no-completeness-guarantee, with a gap badge. The merged, guaranteed-complete
 * single chronology is Tier-3 — NEVER claimed here.
 *
 *   1. message lane  — the durable session-JSONL rows (ordinary content + the
 *                      `thread_delivery` custom rows) rendered via the existing
 *                      `<ChatView>` read-path, READ THROUGH the P1 cloned-DTO
 *                      facade. M11: tool-grouping is DISABLED here (every native
 *                      row survives in order). Filter-param: the lane's "show
 *                      all activity" default (`tierC:true`) flows through the
 *                      parameterized ChatView filter — a thread default is never
 *                      mislabeled non-default.
 *   2. status lane   — diagnostic-only; EMPTY/absent until Tier-3 (no durable
 *                      status source today). Never drives anything.
 *   3. hand-off lane — the P1 v2-ledger `thread-holder-change` range; EMPTY
 *                      until the A4 verb lands. Honest empty label, gap badge.
 *
 * READ-ONLY: nothing here writes, routes a prompt, or confers authority.
 * Theme-safe CSS-var tokens only.
 */
import React from "react";
import { Icon } from "@mdi/react";
import { mdiMessageText, mdiPulse, mdiSwapHorizontal, mdiAlertCircleOutline } from "@mdi/js";
import { ChatView } from "./ChatView.js";
import { DEFAULT_MESSAGE_FILTER, type MessageFilter } from "../lib/message-filter-storage.js";
import type { ToolContext } from "./tool-renderers/index.js";
import type { SessionState } from "../lib/event-reducer.js";
import type { LedgerEvent } from "../lib/thread-handoff-lane-api.js";

/**
 * The message-lane "show all activity" default (Tier-1 filter-param M-fix).
 * Computed INLINE from the canonical default (NOT a new drifting constant — the
 * brief forbids adding one): the thread lane reveals ledger-tier rows by default
 * (`tierC:true`). Passed to `<ChatView defaultFilter>` so this baseline flows
 * through init / session-reset / "is default" / Reset / the banner — a thread
 * default is never mislabeled non-default (which would show Reset + turn tierC
 * off).
 */
const THREAD_LANE_DEFAULT_FILTER: MessageFilter = { ...DEFAULT_MESSAGE_FILTER, tierC: true };

const LANE_TOOL_CONTEXT: ToolContext = { editors: [] };

/**
 * Shared lane frame: an icon + title, the mandatory non-authoritative label, an
 * optional gap badge, and the lane body. Every lane wears the SAME honesty
 * furniture so no lane can read as "complete".
 */
function LaneShell({
  testid,
  icon,
  title,
  source,
  gapBadge,
  children,
}: {
  testid: string;
  icon: string;
  title: string;
  /** One-line provenance ("durable session JSONL", "v2 decision-ledger", …). */
  source: string;
  /** Gap-badge text (e.g. "empty until A4 verb", "no durable source yet"). */
  gapBadge?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-lg border overflow-hidden flex flex-col min-h-0"
      style={{ borderColor: "var(--border-secondary)", background: "var(--bg-surface)" }}
      data-testid={testid}
    >
      <header
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
      >
        <Icon path={icon} size={0.7} style={{ color: "var(--text-secondary)" }} />
        <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
        {gapBadge && (
          <span
            className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ color: "var(--accent-orange)", backgroundColor: "color-mix(in srgb, var(--accent-orange) 14%, transparent)" }}
            data-testid={`${testid}-gap-badge`}
          >
            <Icon path={mdiAlertCircleOutline} size={0.45} />
            {gapBadge}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {source}
        </span>
      </header>
      {/* The mandatory non-authoritative label — on EVERY lane, always. */}
      <p
        className="px-3 py-1 text-[10px] leading-snug border-b"
        style={{ color: "var(--text-muted)", borderColor: "var(--border-subtle)", background: "color-mix(in srgb, var(--bg-tertiary) 40%, transparent)" }}
        data-testid={`${testid}-nonauthoritative`}
      >
        Partial · non-authoritative · no completeness guarantee. Native order, this source only — not a merged chronology (that is Tier-3).
      </p>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
    </section>
  );
}

/** A calm empty/absent lane body (honest, never an error). */
function LaneEmpty({ testid, title, body }: { testid: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-6" data-testid={testid}>
      <p className="text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>{title}</p>
      <p className="text-[11px] leading-snug max-w-sm" style={{ color: "var(--text-muted)" }}>{body}</p>
    </div>
  );
}

interface Props {
  /**
   * The message-lane state, pre-built THROUGH the P1 facade
   * (`buildMessageLaneStateFromManager` / `…FromEntries`). Null = the message
   * lane has no durable rows yet (empty / building) → the lane shows its calm
   * empty body.
   */
  messageLaneState: SessionState | null;
  /** Hand-off lane events (P1 v2-ledger range). Empty until the A4 verb lands. */
  handoffEvents: LedgerEvent[];
  /** False when the hand-off endpoint is unregistered (held) vs. genuinely empty. */
  handoffEndpointAvailable: boolean;
}

/** The three lanes, stacked. Each independently labeled + gap-badged. */
export function ThreadHistoryLanes({ messageLaneState, handoffEvents, handoffEndpointAvailable }: Props) {
  const messageRowCount = messageLaneState?.messages.length ?? 0;

  return (
    <div className="flex flex-col gap-3" data-testid="thread-history-lanes">
      {/* 1 — MESSAGE LANE (ChatView read-path, through the P1 facade, M11 off) */}
      <LaneShell
        testid="lane-message"
        icon={mdiMessageText}
        title="Message lane"
        source="durable session JSONL"
        gapBadge={messageRowCount === 0 ? "no rows yet" : undefined}
      >
        {messageLaneState && messageRowCount > 0 ? (
          // A bounded viewport so the embedded ChatView scrolls WITHIN the lane.
          // Honest client-cost: this is the existing PLAIN list (no virtualizer);
          // long threads render every row (see the lane note — Tier-1 defers
          // virtualization). data-testid marks the embedded read-path.
          <div className="h-[380px] flex flex-col min-h-0" data-testid="lane-message-chatview">
            <ChatView
              state={messageLaneState}
              toolContext={LANE_TOOL_CONTEXT}
              defaultFilter={THREAD_LANE_DEFAULT_FILTER}
              disableToolGrouping
            />
          </div>
        ) : (
          <LaneEmpty
            testid="lane-message-empty"
            title="No durable message rows yet"
            body="This thread has no persisted session entries in the durable store yet. When deliveries and their session content land, they appear here in native order — this source only, never merged."
          />
        )}
      </LaneShell>

      {/* 2 — STATUS LANE (diagnostic-only; empty until Tier-3) */}
      <LaneShell
        testid="lane-status"
        icon={mdiPulse}
        title="Status lane"
        source="diagnostic (Tier-3)"
        gapBadge="empty until Tier-3"
      >
        <LaneEmpty
          testid="lane-status-empty"
          title="No durable status source yet"
          body="The status lane is diagnostic-only. No durable status source exists today — the committed-chain source lands in Tier-3. This lane never drives anything; it stays empty and honest until then."
        />
      </LaneShell>

      {/* 3 — HAND-OFF LANE (P1 v2-ledger range; empty until the A4 verb) */}
      <LaneShell
        testid="lane-handoff"
        icon={mdiSwapHorizontal}
        title="Hand-off lane"
        source="v2 decision-ledger"
        gapBadge={handoffEndpointAvailable ? "empty until A4 verb" : "not yet wired"}
      >
        {handoffEvents.length > 0 ? (
          <ol className="divide-y" style={{ borderColor: "var(--border-subtle)" }} data-testid="lane-handoff-events">
            {handoffEvents.map((e) => (
              <li key={e.event_id} className="px-3 py-2 flex items-start gap-2" data-testid="handoff-event">
                <span className="text-[10px] tabular-nums" style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                  {e.event_id}
                </span>
                <span className="text-[11px] flex-1" style={{ color: "var(--text-secondary)" }}>{e.summary}</span>
              </li>
            ))}
          </ol>
        ) : (
          <LaneEmpty
            testid="lane-handoff-empty"
            title={handoffEndpointAvailable ? "No hand-off events yet" : "Hand-off read not yet wired"}
            body={
              handoffEndpointAvailable
                ? "Holder-change events appear here once the A4 thread-holder-change verb lands (there are none in the ledger yet). Ordered by the monotonic dl-N sequence, never by wall-clock."
                : "The v2-ledger hand-off read is held until activation. When wired, holder-change events appear here in monotonic dl-N order."
            }
          />
        )}
      </LaneShell>
    </div>
  );
}
