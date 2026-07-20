/**
 * ThreadView — the operator-facing thread delivery-state ledger (design v3.6 B5).
 *
 * Renders, per `thread_id`, the durable outbox deliveries and their full
 * proof-tracking lifecycle. The feature's whole point is durability +
 * exactly-once: a delivery advances MONOTONICALLY through proof states and is
 * never lost — so each delivery is a ledger row with a six-segment LIFECYCLE
 * RAIL (injecting → queued_executing → observed → accepted → executed →
 * delivered). Filled segments = proven progress; the current state is the
 * marked head; off-rail terminals (`failed`, `indeterminate`) render as
 * distinct markers. `delivery_id` / revision / timestamp use the mono ledger
 * face (`--font-mono`).
 *
 * Aesthetic (frontend-design SKILL, executed within the repo's existing token
 * system): a proof-tracking ledger rail — intentional, cohesive, theme-safe.
 * Only CSS-var tokens (no hardcoded hex, no new font/CSS system), so every
 * theme (dark / light / warm-stone) renders correctly.
 *
 * READ-ONLY: the durable outbox is the source of truth; this view mutates
 * nothing and routes no prompts. The outbox is EMPTY until the held drain loop
 * activates — the empty-state + the unregistered-endpoint degrade cover that.
 */
import React from "react";
import { Icon } from "@mdi/react";
import {
  mdiCheckDecagram,
  mdiAlertOctagon,
  mdiTimerSandComplete,
  mdiTrayFull,
  mdiSourceBranch,
} from "@mdi/js";
import {
  useThreadDeliveries,
  type ThreadDeliveriesFetcher,
} from "../hooks/useThreadDeliveries.js";
import {
  RAIL_ORDER,
  DISPLAY_LABEL,
  DISPLAY_MEANING,
  deriveDisplayState,
  isOffRail,
  type DisplayState,
  type ThreadViewDelivery,
} from "../lib/thread-view-api.js";

interface Props {
  threadId: string;
  /** Injectable fetcher (stories/tests feed fixtures; default = live REST). */
  fetcher?: ThreadDeliveriesFetcher;
  onBack?: () => void;
}

/**
 * State → CSS-var accent (theme-safe). The rail warms as proof accrues:
 * dispatch/runtime signals read blue, the durable barrier reads amber, proven
 * execution reads green; off-rail failure reads red, the surfaced lease amber.
 */
const STATE_ACCENT: Record<DisplayState, string> = {
  injecting: "var(--text-muted)",
  queued_executing: "var(--accent-blue)",
  observed: "var(--accent-blue)",
  accepted: "var(--accent-yellow)",
  executed: "var(--accent-green)",
  delivered: "var(--accent-green)",
  failed: "var(--accent-red)",
  indeterminate: "var(--accent-orange)",
};

/** Rail index a delivery has PROVEN up to (how many segments are filled). */
function railProgress(d: ThreadViewDelivery, display: DisplayState): number {
  // On-rail: fill up to and including the current segment.
  const onRail = RAIL_ORDER.indexOf(display);
  if (onRail >= 0) return onRail;
  // Off-rail: fill up to the last durable rail position the row actually held
  // (the underlying outbox `state`), so the rail stays honest about how far the
  // delivery got before diverging.
  const underlying = RAIL_ORDER.indexOf(d.state as DisplayState);
  return underlying >= 0 ? underlying : 0;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/** The six-segment monotonic proof rail. */
function LifecycleRail({ delivery, display }: { delivery: ThreadViewDelivery; display: DisplayState }) {
  const progress = railProgress(delivery, display);
  const offRail = isOffRail(display);
  const headAccent = STATE_ACCENT[display];

  return (
    <div className="flex items-center gap-[3px]" data-testid="lifecycle-rail" role="list" aria-label="delivery lifecycle">
      {RAIL_ORDER.map((seg, i) => {
        const filled = i <= progress;
        const isHead = i === progress && !offRail;
        // On-rail head = state accent; filled body = green proof; pending = subtle.
        // Off-rail: the proven body stays green, but the HEAD segment is tinted
        // by the divergence accent (red/amber) to mark where it left the rail.
        const isDivergeHead = i === progress && offRail;
        const bg = isHead
          ? headAccent
          : isDivergeHead
            ? STATE_ACCENT[display]
            : filled
              ? "var(--accent-green)"
              : "var(--border-subtle)";
        return (
          <span
            key={seg}
            role="listitem"
            data-testid={`rail-seg-${seg}`}
            data-filled={filled ? "1" : "0"}
            data-head={isHead || isDivergeHead ? "1" : "0"}
            title={DISPLAY_LABEL[seg]}
            className="h-[6px] rounded-full transition-colors"
            style={{
              width: isHead || isDivergeHead ? 22 : 14,
              backgroundColor: bg,
              opacity: filled ? 1 : 0.5,
            }}
          />
        );
      })}
    </div>
  );
}

/** The off-rail terminal badge (failed / indeterminate). */
function OffRailBadge({ display }: { display: DisplayState }) {
  if (display === "failed") {
    return (
      <span
        data-testid="offrail-badge-failed"
        className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
        style={{ color: "var(--accent-red)", backgroundColor: "color-mix(in srgb, var(--accent-red) 14%, transparent)" }}
      >
        <Icon path={mdiAlertOctagon} size={0.5} />
        failed
      </span>
    );
  }
  return (
    <span
      data-testid="offrail-badge-indeterminate"
      className="ledger-indeterminate-pulse inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
      style={{ color: "var(--accent-orange)", backgroundColor: "color-mix(in srgb, var(--accent-orange) 14%, transparent)" }}
    >
      <Icon path={mdiTimerSandComplete} size={0.5} />
      indeterminate
    </span>
  );
}

/** One ledger row for a delivery. */
function DeliveryRow({ delivery, index }: { delivery: ThreadViewDelivery; index: number }) {
  const display = deriveDisplayState(delivery);
  const accent = STATE_ACCENT[display];
  const offRail = isOffRail(display);
  const isDelivered = display === "delivered";

  return (
    <div
      className="ledger-row-rise rounded-md border px-3 py-2.5"
      data-testid="delivery-row"
      data-delivery-id={delivery.delivery_id}
      data-display-state={display}
      style={{
        animationDelay: `${Math.min(index, 12) * 45}ms`,
        borderColor: "var(--border-secondary)",
        background: "var(--bg-surface)",
        boxShadow: "0 1px 0 var(--shadow-card)",
      }}
    >
      {/* Top line: state label + delivered seal / off-rail badge, then rev. */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: accent }}
          data-testid="state-label"
        >
          {isDelivered && <Icon path={mdiCheckDecagram} size={0.55} />}
          {DISPLAY_LABEL[display]}
        </span>
        {offRail && <OffRailBadge display={display} />}
        <span className="flex-1" />
        <span
          className="text-[10px] tabular-nums"
          style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}
          data-testid="delivery-revision"
        >
          rev {delivery.revision}
        </span>
      </div>

      {/* The proof rail. */}
      <div className="mt-2">
        <LifecycleRail delivery={delivery} display={display} />
      </div>

      {/* Meaning caption. */}
      <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--text-secondary)" }}>
        {DISPLAY_MEANING[display]}
      </p>

      {/* Ledger foot: id · attempt · entry · timestamp (mono). */}
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]"
        style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
      >
        <span data-testid="delivery-id" style={{ color: "var(--text-tertiary)" }}>{delivery.delivery_id}</span>
        <span>attempt {delivery.attempt}</span>
        {delivery.entry_id && <span>entry {delivery.entry_id}</span>}
        <span className="tabular-nums" data-testid="delivery-ts">{formatTs(delivery.updated_at)}</span>
      </div>
    </div>
  );
}

/** A small terminal-count summary strip (delivered / in-flight / failed). */
function SummaryStrip({ deliveries }: { deliveries: ThreadViewDelivery[] }) {
  let delivered = 0;
  let failed = 0;
  let inFlight = 0;
  for (const d of deliveries) {
    const s = deriveDisplayState(d);
    if (s === "delivered") delivered++;
    else if (s === "failed") failed++;
    else inFlight++;
  }
  const chip = (label: string, n: number, color: string, testid: string) => (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium" style={{ color }} data-testid={testid}>
      <span className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>{n}</span>
      <span className="uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</span>
    </span>
  );
  return (
    <div className="flex items-center gap-3">
      {chip("delivered", delivered, "var(--accent-green)", "summary-delivered")}
      {chip("in flight", inFlight, "var(--accent-blue)", "summary-inflight")}
      {chip("failed", failed, "var(--accent-red)", "summary-failed")}
    </div>
  );
}

export function ThreadView({ threadId, fetcher, onBack }: Props) {
  const { deliveries, isLoading, error, endpointAvailable } = useThreadDeliveries(threadId, fetcher);

  // Newest ledger entries first (stable: updated_at desc, then id).
  const rows = [...deliveries].sort(
    (a, b) => b.updated_at - a.updated_at || a.delivery_id.localeCompare(b.delivery_id),
  );

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="thread-view">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--border-secondary)" }}>
        {onBack && (
          <button
            onClick={onBack}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            data-testid="thread-view-back"
            aria-label="Back"
          >
            <Icon path={mdiSourceBranch} size={0.8} />
          </button>
        )}
        <div className="flex flex-col min-w-0">
          <h2 className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
            Thread deliveries
          </h2>
          <span className="text-[10px] truncate" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }} data-testid="thread-id">
            {threadId}
          </span>
        </div>
        <span className="flex-1" />
        {!isLoading && !error && deliveries.length > 0 && <SummaryStrip deliveries={deliveries} />}
      </div>

      {/* Content ladder: loading → error → unregistered → empty → rows */}
      <div className="flex-1 overflow-y-auto px-4 py-3" data-testid="thread-view-list">
        {isLoading ? (
          <p className="text-xs py-6 text-center" style={{ color: "var(--text-muted)" }} data-testid="thread-view-loading">
            Loading deliveries…
          </p>
        ) : error ? (
          <p className="text-xs py-6 text-center" style={{ color: "var(--accent-red)" }} data-testid="thread-view-error">
            {error}
          </p>
        ) : !endpointAvailable ? (
          <EmptyState
            testid="thread-view-unregistered"
            title="Thread routing not yet active"
            body="The durable outbox is in place, but thread routing is held until its dependencies land. No deliveries are being routed yet."
          />
        ) : deliveries.length === 0 ? (
          <EmptyState
            testid="thread-view-empty"
            title="No deliveries yet"
            body="This thread has no deliveries in the durable outbox. When a delivery is injected, it appears here and advances through its proof-tracking lifecycle."
          />
        ) : (
          <div className="space-y-2" data-testid="delivery-rows">
            {rows.map((d, i) => (
              <DeliveryRow key={d.delivery_id} delivery={d} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Shared empty / unregistered state — a calm, intentional placeholder. */
function EmptyState({ testid, title, body }: { testid: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6" data-testid={testid}>
      <div
        className="mb-3 flex items-center justify-center rounded-full"
        style={{ width: 44, height: 44, background: "var(--bg-tertiary)", color: "var(--text-muted)" }}
      >
        <Icon path={mdiTrayFull} size={0.9} />
      </div>
      <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>{title}</p>
      <p className="text-[11px] leading-snug max-w-xs" style={{ color: "var(--text-muted)" }}>{body}</p>
    </div>
  );
}
