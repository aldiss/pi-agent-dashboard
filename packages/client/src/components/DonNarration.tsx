/**
 * DonNarration — dashboard tile rendering Don's periodic plain-prose
 * narration of system activity during out-of-engagement windows.
 *
 * Path B sister-coupling primitive per AGENTS.md v1.4.4 deck-surfacing
 * discipline + sister-shape ActiveOperatorSurfaces canonical Path B first
 * instance shipped 2026-05-23. Reads canonical state-file via
 * `GET /api/don-narration`; reads canonical pacing-mode via
 * `GET /api/operator-pacing-mode` for A3 stale-narration freshness-guard
 * detection (if pacing-mode endpoint absent, falls back to stale_after
 * timestamp comparison).
 *
 * Cell: operator-driver-experience-don-build/v1 (W6 D7 deliverable per
 * Don 7th canonical standing-crew BUILD cell scope-split 2026-05-28).
 *
 * A3 STRUCTURAL fix per W5 council amendment canonical: when frontmatter
 * `stale_after` has passed OR `source_mode` differs from current pacing
 * mode, render `.stale` visual attenuation + top-of-tile stale banner.
 *
 * Minimum-viable v0 per design-pass v2 §(c).3 Phase A scope-bounding:
 * - 10s polling refresh (sister-shape ActiveOperatorSurfaces canonical)
 * - manual refresh button (belt-and-suspenders)
 * - cadence selector dropdown (15min / 30min / 60min / event-driven) —
 *   surfaces operator intent; actual cadence enforced by Don tmux loop
 *   (NOT this client component) — see don-brief.md § Workflow
 * - last-rendered timestamp display
 * - markdown-rendered body via MarkdownContent (existing dashboard
 *   convention)
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Icon } from "@mdi/react";
import {
  mdiChevronDown,
  mdiChevronRight,
  mdiRefresh,
  mdiAlertOutline,
} from "@mdi/js";
import { getApiBase } from "../lib/api-context.js";
import { formatRelativeTime } from "../lib/format.js";
import { MarkdownContent } from "./MarkdownContent.js";

interface DonNarrationFrontmatter {
  rendered_at: string | null;
  source_mode: string | null;
  source_mode_mtime_or_rev: string | null;
  source_inputs_hash: string | null;
  stale_after: string | null;
  cadence_minutes: number | null;
  schema_version: string | null;
  emitter: string | null;
}

interface DonNarrationResponse {
  schema_version: string;
  frontmatter_metadata: DonNarrationFrontmatter;
  markdown: string;
  parse_warning?: string;
}

type CadenceChoice = "15" | "30" | "60" | "event-driven";

const COLLAPSED_KEY = "dashboard:donNarrationCollapsed";
const CADENCE_KEY = "dashboard:donNarrationCadenceChoice";
const POLL_INTERVAL_MS = 10_000;

function getCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}
function setCollapsedPersist(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(value));
  } catch {
    /* ignore */
  }
}
function getCadenceChoice(): CadenceChoice {
  try {
    const v = window.localStorage.getItem(CADENCE_KEY);
    if (v === "15" || v === "30" || v === "60" || v === "event-driven") return v;
  } catch {
    /* ignore */
  }
  return "30";
}
function setCadenceChoicePersist(value: CadenceChoice): void {
  try {
    window.localStorage.setItem(CADENCE_KEY, value);
  } catch {
    /* ignore */
  }
}

function formatTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const age = Date.now() - ts;
  if (age < 0) return iso;
  return `${formatRelativeTime(age)} ago`;
}

/**
 * Compute stale-state per A3 STRUCTURAL fix canonical:
 *  - `stale_after` timestamp has passed, OR
 *  - `source_mode` differs from current pacing mode (best-effort detection;
 *    pacing-mode endpoint may not exist yet — falls back to time-only check).
 */
function computeStaleState(
  frontmatter: DonNarrationFrontmatter,
  currentMode: string | null,
): { stale: boolean; reason: string | null } {
  // Time check.
  if (frontmatter.stale_after) {
    const staleAfterTs = Date.parse(frontmatter.stale_after);
    if (!Number.isNaN(staleAfterTs) && Date.now() > staleAfterTs) {
      return {
        stale: true,
        reason:
          "Narration is past its freshness window. Don will refresh at next cron-fire.",
      };
    }
  }
  // Mode check (only when both values known).
  if (
    currentMode !== null &&
    frontmatter.source_mode !== null &&
    currentMode !== frontmatter.source_mode
  ) {
    return {
      stale: true,
      reason: `Narration was rendered for mode "${frontmatter.source_mode}"; current mode is "${currentMode}". Don will refresh at next cron-fire.`,
    };
  }
  return { stale: false, reason: null };
}

export function DonNarration(): React.ReactElement | null {
  const [collapsed, setCollapsed] = useState<boolean>(() => getCollapsed());
  const [cadenceChoice, setCadenceChoice] = useState<CadenceChoice>(() =>
    getCadenceChoice(),
  );
  const [payload, setPayload] = useState<DonNarrationResponse | null>(null);
  const [currentMode, setCurrentMode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const fetchNarration = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/don-narration`);
      const body = await res.json();
      if (!mountedRef.current) return;
      if (body && body.success && body.data) {
        setPayload(body.data as DonNarrationResponse);
        setError(null);
      } else {
        setError(typeof body?.error === "string" ? body.error : "unknown response");
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message ?? String(e));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  /**
   * Best-effort pacing-mode fetch for stale-detection. If the endpoint is
   * absent (404 / 500 / parse error), silently fall back to time-only
   * staleness — the A3 freshness-guard MUST NOT block render on missing
   * endpoint.
   */
  const fetchPacingMode = useCallback(async (): Promise<void> => {
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/operator-pacing-mode`);
      if (!res.ok) return;
      const body = await res.json();
      if (!mountedRef.current) return;
      if (body && body.success && body.data && typeof body.data.mode === "string") {
        setCurrentMode(body.data.mode);
      }
    } catch {
      /* endpoint unavailable — fall back to time-only stale check */
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchNarration();
    void fetchPacingMode();
    const handle = window.setInterval(() => {
      void fetchNarration();
      void fetchPacingMode();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, [fetchNarration, fetchPacingMode]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapsedPersist(next);
      return next;
    });
  }, []);

  const onRefresh = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void fetchNarration();
      void fetchPacingMode();
    },
    [fetchNarration, fetchPacingMode],
  );

  const onCadenceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value as CadenceChoice;
      setCadenceChoice(v);
      setCadenceChoicePersist(v);
      // Note: this only surfaces operator intent. Actual cron cadence
      // is enforced by Don's tmux loop reading a state-file (v0.5+
      // candidate per design-pass v2 §(c).6). For v0 the dropdown is
      // a visual hint; cadence enforcement lives at the agent tier.
    },
    [],
  );

  const { stale, staleReason } = useMemo(() => {
    if (!payload) return { stale: false, staleReason: null };
    const r = computeStaleState(payload.frontmatter_metadata, currentMode);
    return { stale: r.stale, staleReason: r.reason };
  }, [payload, currentMode]);

  const isEmpty = !!(
    payload &&
    (!payload.markdown || payload.markdown.trim().length === 0)
  );
  const parseWarning = payload?.parse_warning ?? null;
  const renderedAt = payload?.frontmatter_metadata.rendered_at ?? null;
  const sourceMode = payload?.frontmatter_metadata.source_mode ?? null;
  const cadenceMinutes = payload?.frontmatter_metadata.cadence_minutes ?? null;

  return (
    <div
      className="don-narration-container border border-[var(--border-color)] rounded bg-[var(--bg-secondary)] flex-shrink-0"
      data-testid="don-narration"
    >
      <button
        onClick={toggleCollapsed}
        className="don-narration-header w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-surface)] transition-colors"
        aria-expanded={!collapsed}
        aria-controls="don-narration-body"
      >
        <Icon
          path={collapsed ? mdiChevronRight : mdiChevronDown}
          size={0.55}
          className="text-[var(--text-secondary)] flex-shrink-0"
        />
        <span className="text-xs font-medium text-[var(--text-primary)] flex-1">
          Don&rsquo;s narration
          {sourceMode && (
            <span className="text-[var(--text-secondary)] ml-1">
              ({sourceMode})
            </span>
          )}
        </span>
        {!collapsed && (
          <>
            <select
              value={cadenceChoice}
              onChange={onCadenceChange}
              onClick={(e) => e.stopPropagation()}
              className="don-narration-cadence-select text-[10px] bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded px-1 py-0.5"
              title="Operator-preferred cadence (visual hint; actual cadence enforced at agent tier)"
              aria-label="Don narration cadence"
            >
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
              <option value="event-driven">event-driven</option>
            </select>
            <button
              onClick={onRefresh}
              className={`p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ${isLoading ? "animate-pulse" : ""}`}
              title="Refresh"
              aria-label="Refresh Don narration"
            >
              <Icon path={mdiRefresh} size={0.55} />
            </button>
          </>
        )}
      </button>
      {!collapsed && (
        <div id="don-narration-body" className="don-narration-body-wrapper">
          {stale && staleReason && (
            <div
              className="don-narration-stale-banner flex items-start gap-1.5 px-2 py-1.5 text-[11px] text-amber-400 bg-amber-500/10 border-b border-amber-500/30"
              role="status"
            >
              <Icon
                path={mdiAlertOutline}
                size={0.55}
                className="flex-shrink-0 mt-0.5"
              />
              <span>{staleReason}</span>
            </div>
          )}
          {error ? (
            <div className="px-2 py-1.5 text-[11px] text-red-400">
              Failed to load: {error}
            </div>
          ) : isEmpty ? (
            <div className="don-narration-empty-state px-2 py-2 text-[11px] text-[var(--text-tertiary)] italic">
              {parseWarning
                ? parseWarning
                : "Don is bootstrapping — first narration will appear after the build cell completes."}
            </div>
          ) : payload ? (
            <div
              className={`don-narration-body px-2 py-2 text-[12px] text-[var(--text-primary)] ${stale ? "stale opacity-60" : ""}`}
            >
              <MarkdownContent content={payload.markdown} />
            </div>
          ) : (
            <div className="px-2 py-2 text-[11px] text-[var(--text-tertiary)] italic">
              Loading&hellip;
            </div>
          )}
          {parseWarning && !isEmpty && (
            <div className="px-2 py-1 text-[10px] text-amber-500 border-t border-[var(--border-color)]">
              {parseWarning}
            </div>
          )}
          {renderedAt && (
            <div className="px-2 py-1 text-[10px] text-[var(--text-tertiary)] border-t border-[var(--border-color)] flex items-center gap-2">
              <span>Rendered {formatTimestamp(renderedAt)}</span>
              {cadenceMinutes !== null && (
                <>
                  <span>·</span>
                  <span>cadence {cadenceMinutes} min</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
