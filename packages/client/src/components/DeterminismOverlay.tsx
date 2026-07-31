/**
 * DeterminismOverlay — the NOS determinism-model overlay for one thread
 * (dl-13423). The `/threads` view shows HOW work is being done; this overlay
 * shows, from the model's `project(thread_id)` fold, WHERE that work can go next
 * and WHAT authorizes each move:
 *
 *   • `stage` (+ an optional `stage_meaning` gloss) — the work-item's current
 *     lifecycle stage.
 *   • `pending[]` as directed EDGES out of that stage:
 *       – deterministic → SOLID / green, labeled with its `gate` (the
 *         enforcement mechanism, from `enforced_by`); the machine takes it
 *         itself when `via_event` fires.
 *       – judgment      → DASHED / amber, labeled with its `who` (the decision
 *         authority, from `escalate_to`); a human/agent decides.
 *
 * Degrade is rendered HONESTLY, never as an error:
 *   • `spine-only` → a "partial fold" badge (only the spine event-types are
 *     mapped; the stage + edges are real but incomplete).
 *   • `unmapped`   → a calm "not mapped / unknown" (the thread isn't in the
 *     machine yet) — NOT an error.
 *   • empty pending → no edges represented in THIS projection. This is NOT a
 *     terminality claim: a partial (`spine-only`) fold with zero represented
 *     edges does not prove the stage is terminal — the unfolded event-types
 *     could carry transitions. No terminal/"nowhere-left" copy is emitted
 *     unless an explicit authoritative terminal carrier exists (none today).
 *
 * READ-ONLY + additive. Theme-safe: CSS-var accent tokens only (the B5 /
 * ThreadStatusBadge discipline) — deterministic uses `--accent-green`, judgment
 * uses `--accent-orange` (the amber token; no theme ships a distinct amber), so
 * every theme (dark / light / warm-stone) renders correctly with no hardcoded
 * hex. A `null` projection renders nothing (no model binding / held activation).
 */
import React from "react";
import { Icon } from "@mdi/react";
import {
  mdiStateMachine,
  mdiShieldCheckOutline,
  mdiGavel,
  mdiHelpRhombusOutline,
  mdiLayersOutline,
  mdiInformationOutline,
} from "@mdi/js";
import {
  pendingKey,
  type DeterminismProjection,
  type PendingTransition,
  type TransitionKind,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-projection.js";

/** Per-kind accent token (theme-safe). Amber == `--accent-orange` (no theme
 * ships a distinct amber; orange is the warm amber in dark/light/warm-stone). */
const KIND_ACCENT: Record<TransitionKind, string> = {
  deterministic: "var(--accent-green)",
  judgment: "var(--accent-orange)",
};

/**
 * A directed edge marker: a short line + arrowhead. Solid for deterministic,
 * dashed for judgment. `currentColor` from the kind accent keeps it theme-safe.
 */
function EdgeLine({ kind }: { kind: TransitionKind }) {
  const deterministic = kind === "deterministic";
  return (
    <svg
      width="30"
      height="12"
      viewBox="0 0 30 12"
      aria-hidden="true"
      style={{ color: KIND_ACCENT[kind], flexShrink: 0 }}
      data-testid="determinism-edge-line"
      data-line-style={deterministic ? "solid" : "dashed"}
    >
      <line
        x1="1"
        y1="6"
        x2="22"
        y2="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={deterministic ? undefined : "3 3"}
      />
      <path d="M22 2 L29 6 L22 10 Z" fill="currentColor" />
    </svg>
  );
}

/** One pending transition rendered as an edge row. */
function EdgeRow({ p }: { p: PendingTransition }) {
  const accent = KIND_ACCENT[p.kind];
  const deterministic = p.kind === "deterministic";
  return (
    <li
      data-testid="determinism-edge"
      data-kind={p.kind}
      data-to={p.to}
      data-via-event={p.via_event}
      data-edge-key={pendingKey(p)}
      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
      style={{
        borderColor: "var(--border-secondary)",
        borderLeftWidth: 3,
        borderLeftColor: accent,
        background: `color-mix(in srgb, ${accent} 6%, var(--bg-surface))`,
      }}
    >
      <EdgeLine kind={p.kind} />
      {/* target stage */}
      <span
        className="text-[11px] font-semibold whitespace-nowrap"
        style={{ color: "var(--text-primary)" }}
      >
        → {p.to}
      </span>
      {/* the triggering event (mono) */}
      <span
        className="text-[10px] truncate px-1 py-0.5 rounded"
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          background: "color-mix(in srgb, var(--text-muted) 12%, transparent)",
        }}
        title={`via ${p.via_event}`}
      >
        {p.via_event}
      </span>
      <span className="flex-1" />
      {/* authorization label: gate (deterministic) vs who (judgment) */}
      {deterministic ? (
        <span
          data-testid="determinism-edge-gate"
          className="inline-flex items-center gap-1 text-[10px] font-medium whitespace-nowrap px-1.5 py-0.5 rounded-full"
          style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}
          title={`gate — enforcement mechanism (enforced_by): ${p.gate}`}
        >
          <Icon path={mdiShieldCheckOutline} size={0.5} />
          gate: {p.gate}
        </span>
      ) : (
        <span
          data-testid="determinism-edge-who"
          className="inline-flex items-center gap-1 text-[10px] font-medium whitespace-nowrap px-1.5 py-0.5 rounded-full"
          style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}
          title={`who — decision authority (escalate_to): ${p.who}`}
        >
          <Icon path={mdiGavel} size={0.5} />
          who: {p.who}
        </span>
      )}
    </li>
  );
}

/** A compact legend so the solid/dashed + green/amber code is self-explanatory. */
function EdgeLegend() {
  return (
    <div
      className="flex items-center gap-3 text-[9px]"
      style={{ color: "var(--text-muted)" }}
      data-testid="determinism-legend"
    >
      <span className="inline-flex items-center gap-1">
        <EdgeLine kind="deterministic" />
        deterministic · gate
      </span>
      <span className="inline-flex items-center gap-1">
        <EdgeLine kind="judgment" />
        judgment · who
      </span>
    </div>
  );
}

/** The stage pill + optional meaning gloss (tooltip + subtitle). */
function StageHeader({ projection }: { projection: DeterminismProjection }) {
  const { stage, stage_meaning, machine } = projection;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full self-start"
          data-testid="determinism-stage"
          data-stage={stage ?? ""}
          style={{ color: "var(--accent-blue)", backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
          title={stage_meaning ?? undefined}
        >
          <Icon path={mdiStateMachine} size={0.55} />
          {stage}
        </span>
        <span
          className="text-[9px] truncate"
          style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
          title={`determinism machine: ${machine}`}
        >
          {machine}
        </span>
      </div>
      {stage_meaning && (
        <p
          className="text-[10px] leading-snug"
          style={{ color: "var(--text-secondary)" }}
          data-testid="determinism-stage-meaning"
        >
          {stage_meaning}
        </p>
      )}
    </div>
  );
}

/** The honest degrade badge (spine-only partial fold). Unmapped is a body state. */
function DegradeBadge({ projection }: { projection: DeterminismProjection }) {
  if (projection.degrade !== "spine-only") return null;
  return (
    <span
      data-testid="determinism-degrade-badge"
      data-degrade="spine-only"
      className="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full self-start"
      style={{ color: "var(--accent-orange)", background: "color-mix(in srgb, var(--accent-orange) 14%, transparent)" }}
      title="partial fold — only the spine event-types are mapped; the §16 canon-touch adds the absent event-types"
    >
      <Icon path={mdiLayersOutline} size={0.5} />
      partial fold (spine-only)
    </span>
  );
}

export function DeterminismOverlay({ projection }: { projection: DeterminismProjection | null }) {
  // No model binding (endpoint unregistered / held activation) → render nothing.
  if (!projection) return null;

  const { thread_id, stage, pending, degrade } = projection;
  const unmapped = degrade === "unmapped";

  return (
    <div
      data-testid="determinism-overlay"
      data-thread-id={thread_id}
      data-stage={stage ?? ""}
      data-degrade={degrade ?? ""}
      className="rounded-lg border px-3 py-2.5 flex flex-col gap-2"
      style={{ borderColor: "var(--border-secondary)", background: "var(--bg-surface)" }}
    >
      {/* Section label */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          determinism
        </span>
        <span className="flex-1" />
        <DegradeBadge projection={projection} />
      </div>

      {unmapped ? (
        // Present-but-unmapped: honest "not mapped / unknown", NOT an error.
        <div
          data-testid="determinism-unmapped"
          className="flex items-start gap-2 rounded-md px-2 py-1.5"
          style={{ background: "color-mix(in srgb, var(--text-muted) 8%, transparent)" }}
        >
          <Icon path={mdiHelpRhombusOutline} size={0.6} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1 }} />
          <p className="text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
            not mapped / unknown — this thread isn’t in the determinism machine yet. No stage, no edges. This is the honest degrade, not an error.
          </p>
        </div>
      ) : (
        <>
          <StageHeader projection={projection} />
          {pending.length === 0 ? (
            // No pending transitions represented in THIS projection. NOT a
            // terminality claim: with degrade:"spine-only" the fold is partial,
            // so absent edges may just be unfolded event-types, not a dead end.
            // Neutral (muted) styling — no success/terminal signal.
            <div
              data-testid="determinism-no-edges"
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              style={{ background: "color-mix(in srgb, var(--text-muted) 8%, transparent)" }}
            >
              <Icon path={mdiInformationOutline} size={0.6} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <p className="text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                no pending transitions in this projection.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <ul className="flex flex-col gap-1" data-testid="determinism-edges">
                {pending.map((p) => (
                  <EdgeRow key={pendingKey(p)} p={p} />
                ))}
              </ul>
              <EdgeLegend />
            </div>
          )}
        </>
      )}
    </div>
  );
}
