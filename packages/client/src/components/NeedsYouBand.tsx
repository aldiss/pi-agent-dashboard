/**
 * NeedsYouBand — the operator-facing "Needs you" surface at the TOP of
 * SessionList (Stage 5). Reads `useNeedsYouBand` and renders the THREE zones
 * (Peggy-ratified loudness-tiering, verdict §5a) + honest-empty + the stale
 * banner:
 *
 *   1. MAIN LOUD must-act (non-uncertain): operator-language `label` + exact
 *      `action`. Drilldown (dl-id / thread / raw summary) behind an expand,
 *      NEVER in the label. HALT-tier (`production-held`, `halt_tier=true`)
 *      recommends-as-default + requires an EXPLICIT operator nod (a confirm
 *      affordance) — NEVER auto-fires. Reversible (`parked-decision`) may
 *      drive-with-default.
 *   2. LOWER-TIER collapse (uncertain): ONE quiet, expandable summary row
 *      (Peggy verbatim) — NOT N raw rows in the main flow.
 *   3. `watcher_live=false` → a LOUD stale banner at the band top.
 *   + honest-empty (`watcher_live=true`, no main items): a calm
 *      "nothing needs you" (DISTINCT from the stale banner — empty ≠ uncertain).
 *
 * Styled with the existing dashboard `var(--*)` tokens + the amber/red accent
 * language (like `FleetBriefBanner`) so it reads native. This band is ADDITIVE
 * — a different data source from the per-session `stablePartitionByBand`.
 */
import React, { useState } from "react";
import { Icon } from "@mdi/react";
import {
  mdiAlertOctagon,
  mdiChevronDown,
  mdiChevronRight,
  mdiCheckCircleOutline,
  mdiClipboardAlertOutline,
  mdiClockAlertOutline,
  mdiCurrencyUsd,
  mdiHandBackRight,
  mdiPauseCircleOutline,
  mdiShieldAlertOutline,
} from "@mdi/js";
import type { NeedsYouItem, NeedsYouKind } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import { useNeedsYouBand } from "../hooks/useNeedsYouBand.js";
import { partitionBandZones, lowerTierSummary } from "../lib/needs-you-band.js";

function kindIcon(kind: NeedsYouKind): string {
  switch (kind) {
    case "production-held": return mdiShieldAlertOutline;
    case "parked-decision": return mdiClipboardAlertOutline;
    case "stalled-deliverable": return mdiPauseCircleOutline;
    case "phantom-hold": return mdiClockAlertOutline;
    case "commitment-drop": return mdiHandBackRight;
    case "runaway-cost": return mdiCurrencyUsd;
    default: return mdiClipboardAlertOutline;
  }
}

/**
 * The main-tier kind CHIP (Peggy §5c first-pass wording). Carries the
 * production-held-vs-parked distinction explicitly: irreversible-GO ("YOUR GO")
 * vs reversible-pick ("YOUR CALL"). Peggy owns the final tone-pass.
 */
function kindLabel(kind: NeedsYouKind): string {
  switch (kind) {
    case "production-held": return "YOUR GO";
    case "parked-decision": return "YOUR CALL";
    case "stalled-deliverable": return "BLOCKED";
    case "phantom-hold": return "HOLD NEVER FIRED";
    case "commitment-drop": return "DROPPED";
    case "runaway-cost": return "$ RUNAWAY";
    default: return kind;
  }
}

/** One main-tier row. HALT-tier gets a red accent + explicit-nod confirm gate. */
function MainRow({ item }: { item: NeedsYouItem }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [nodded, setNodded] = useState(false);
  const halt = item.halt_tier;
  const accent = halt ? "text-red-400" : "text-amber-400";
  const rail = halt ? "before:bg-red-500/70" : "before:bg-amber-500/60";

  const hasDrill = !!(item.drilldown.event_id || item.drilldown.thread_id || item.drilldown.raw_summary);

  return (
    <li
      className={`relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 ${rail} border-b border-[var(--border-color)] last:border-b-0`}
      data-testid="needs-you-item"
      data-kind={item.kind}
      data-halt={halt ? "true" : "false"}
    >
      <div className="flex items-start gap-2 px-2.5 py-2 pl-3">
        <Icon path={halt ? mdiAlertOctagon : kindIcon(item.kind)} size={0.65} className={`shrink-0 mt-0.5 ${accent}`} />
        <div className="flex-1 min-w-0">
          <span className={`block text-[10px] uppercase tracking-wider font-semibold ${accent}`} data-testid="needs-you-chip">
            {kindLabel(item.kind)}
          </span>
          {/* operator-language label — NEVER the raw jargon */}
          <span className="block text-xs font-medium text-[var(--text-primary)] leading-snug mt-0.5">
            {item.label}
          </span>

          {/* HALT-tier: explicit-nod gate. NEVER auto-fires — the action is
              recommend-as-default, revealed only on the operator's confirm. */}
          {halt ? (
            nodded ? (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--text-secondary)]" data-testid="needs-you-action-revealed">
                <Icon path={mdiCheckCircleOutline} size={0.6} className="shrink-0 mt-0.5 text-red-400" />
                <span className="leading-snug">{item.action}</span>
              </div>
            ) : (
              <button
                onClick={() => setNodded(true)}
                className="mt-1.5 inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-500/20 transition-colors"
                data-testid="needs-you-halt-nod"
              >
                Show the recommended step
              </button>
            )
          ) : (
            // Reversible — the exact action is shown inline (drive-with-default).
            <div className="mt-1 flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
              <Icon path={mdiChevronRight} size={0.55} className="shrink-0 mt-0.5 text-amber-400" />
              <span className="leading-snug">{item.action}</span>
            </div>
          )}

          {/* drilldown behind an expand — the jargon lives HERE, never the label */}
          {hasDrill && (
            <>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 inline-flex items-center gap-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                data-testid="needs-you-drilldown-toggle"
                aria-expanded={expanded}
              >
                <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={0.5} />
                details
              </button>
              {expanded && (
                <div className="mt-1 rounded bg-[var(--bg-surface)] px-2 py-1 text-[10px] font-mono text-[var(--text-tertiary)] break-words" data-testid="needs-you-drilldown">
                  {item.drilldown.event_id && <div>event: {item.drilldown.event_id}</div>}
                  {item.drilldown.thread_id && <div>thread: {item.drilldown.thread_id}</div>}
                  {item.drilldown.raw_summary && <div className="mt-0.5 opacity-80">{item.drilldown.raw_summary}</div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/** Zone 2 — the single quiet, expandable lower-tier summary row. */
function LowerTier({ items }: { items: NeedsYouItem[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="border-t border-[var(--border-color)]" data-testid="needs-you-lower-tier">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-[var(--bg-surface)] transition-colors"
        data-testid="needs-you-lower-tier-toggle"
        aria-expanded={open}
      >
        <Icon path={open ? mdiChevronDown : mdiChevronRight} size={0.55} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="text-[11px] text-[var(--text-secondary)]">{lowerTierSummary(items.length)}</span>
      </button>
      {open && (
        <ul className="list-none p-0 m-0 bg-[var(--bg-primary)]/40">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 px-3 py-1.5 border-t border-[var(--border-color)]" data-testid="needs-you-lower-item" data-kind={it.kind}>
              <Icon path={kindIcon(it.kind)} size={0.55} className="shrink-0 mt-0.5 text-[var(--text-tertiary)]" />
              <div className="flex-1 min-w-0">
                <span className="block text-[11px] text-[var(--text-secondary)] leading-snug">{it.label}</span>
                <span className="block text-[10px] text-[var(--text-tertiary)] mt-0.5">{it.action}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NeedsYouBand(): React.ReactElement | null {
  const { items, watcherLive, staleReason, outcome } = useNeedsYouBand();
  const zones = partitionBandZones(items);

  // Before the first successful fetch, render nothing (no false calm-zero).
  if (outcome === "pending") return null;

  const hasMain = zones.main.length > 0;
  const hasLower = zones.lowerTier.length > 0;

  // Nothing to show AND the watcher is live AND nothing failed → honest-empty.
  // (A stale watcher still shows its banner even with no items.)
  const showStaleBanner = !watcherLive;
  const honestEmpty = watcherLive && !hasMain && !hasLower && outcome === "success";

  // If the fetch failed entirely and the watcher isn't confirmed live, fall
  // back to the stale banner (never silently hide a possibly-incomplete list).
  return (
    <section
      className="mb-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden"
      data-testid="needs-you-band"
      aria-label="Needs you"
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border-color)]">
        <span className="text-xs font-semibold text-[var(--text-primary)] flex-1">
          Needs you
          {hasMain && (
            <span className="text-[var(--text-secondary)] ml-1" data-testid="needs-you-count">({zones.main.length})</span>
          )}
        </span>
      </div>

      {/* Zone 3 — LOUD stale banner (watcher_live=false) */}
      {showStaleBanner && (
        <div
          className="flex items-start gap-2 px-2.5 py-2 bg-amber-500/10 border-b border-amber-500/30"
          data-testid="needs-you-stale-banner"
        >
          <Icon path={mdiAlertOctagon} size={0.7} className="shrink-0 mt-0.5 text-amber-400" />
          <div className="min-w-0">
            <span className="block text-xs font-semibold text-amber-300">attention-watcher may be stale</span>
            <span className="block text-[11px] text-[var(--text-secondary)] leading-snug">
              the list below may be incomplete{staleReason ? ` — ${staleReason}` : ""}
            </span>
          </div>
        </div>
      )}

      {/* Zone 1 — LOUD main must-act */}
      {hasMain && (
        <ul className="list-none p-0 m-0">
          {zones.main.map((item) => <MainRow key={item.id} item={item} />)}
        </ul>
      )}

      {/* Honest-empty calm state (live watcher, nothing needs the operator) */}
      {honestEmpty && (
        <div className="flex items-center gap-2 px-2.5 py-2.5 text-[var(--text-tertiary)]" data-testid="needs-you-empty">
          <Icon path={mdiCheckCircleOutline} size={0.65} className="shrink-0 text-emerald-500/70" />
          <span className="text-xs">Nothing needs you right now.</span>
        </div>
      )}

      {/* Zone 2 — lower-tier collapse (uncertain items) */}
      <LowerTier items={zones.lowerTier} />
    </section>
  );
}
