/**
 * ActiveOperatorSurfaces — collapsible section rendering Path B canonical
 * operator-facing surfaces (decks / specs / briefs / substrates / session-logs)
 * from `~/.pi/orchestration-state/operator-active-surfaces-current.md` via
 * `GET /api/operator-active-surfaces`.
 *
 * Path B sister-coupling primitive per AGENTS.md v1.4.4 deck-surfacing
 * discipline + Bert tenure-5 d20 architect-of-coherence ratification
 * 2026-05-23 ~21:00 CEST. Sister-shape to v1.1 operator-state.json
 * release_at lifecycle pattern.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.4 Feature 4).
 *
 * Mount: top of session-list sidebar (cross-session canonical; visible
 * regardless of which session is selected; collapsible so it does not
 * dominate dashboard real-estate). Polls every 10s + manual refresh button
 * (belt-and-suspenders per W3 Q4 + Bert RATIFIED). Skips render of expired/
 * archived entries by default; toggle exposes them when present.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Icon } from "@mdi/react";
import {
  mdiChevronDown,
  mdiChevronRight,
  mdiRefresh,
  mdiOpenInNew,
  mdiContentCopy,
  mdiCheck,
  mdiPresentation,
  mdiFileDocumentOutline,
  mdiFileDocumentEditOutline,
  mdiFileDocumentMultipleOutline,
  mdiHistory,
  mdiLink,
} from "@mdi/js";
import { getApiBase } from "../lib/api-context.js";
import { formatRelativeTime } from "../lib/format.js";

type LifecycleState = "active" | "expiring" | "expired" | "archived";
type SurfaceTier = "A" | "B" | "C";
type SurfaceType = "deck" | "spec" | "brief" | "substrate" | "session-log" | "other";
type OperatorAction = "none" | "ratify" | "push" | "review" | "decide";

interface ActiveSurface {
  id: string;
  url: string | null;
  path: string | null;
  emitter: string;
  timestamp: string;
  brief_description: string;
  surface_type: SurfaceType;
  tier: SurfaceTier;
  expires_at: string | null;
  lifecycle_state: LifecycleState;
  operator_action?: OperatorAction;
}

interface ActiveSurfacesResponse {
  schema_version: string;
  updated_at: string | null;
  updated_by: string | null;
  surfaces: ActiveSurface[];
  parse_warning?: string;
}

const COLLAPSED_KEY = "dashboard:activeOperatorSurfacesCollapsed";
const SHOW_EXPIRED_KEY = "dashboard:activeOperatorSurfacesShowExpired";
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
function getShowExpired(): boolean {
  try {
    return window.localStorage.getItem(SHOW_EXPIRED_KEY) === "true";
  } catch {
    return false;
  }
}
function setShowExpiredPersist(value: boolean): void {
  try {
    window.localStorage.setItem(SHOW_EXPIRED_KEY, String(value));
  } catch {
    /* ignore */
  }
}

const SURFACE_TYPE_ICONS: Record<SurfaceType, string> = {
  deck: mdiPresentation,
  spec: mdiFileDocumentOutline,
  brief: mdiFileDocumentEditOutline,
  substrate: mdiFileDocumentMultipleOutline,
  "session-log": mdiHistory,
  other: mdiLink,
};

/** Tier color classes (Tailwind via CSS variables in dashboard theme). */
function tierClasses(tier: SurfaceTier): string {
  switch (tier) {
    case "A":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "B":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    case "C":
    default:
      return "bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-color)]";
  }
}

/** Operator-action visual distinction per Joan tenure-27 operator-direct
 *  ratification 2026-05-26 ~00:30 CEST. Returns CSS classes for a small badge
 *  + left-border accent on the row. Default 'none' returns empty (no visual
 *  distinction; informational surface). */
function operatorActionBadgeClasses(action: OperatorAction): string {
  switch (action) {
    case "ratify":
      return "bg-amber-500/20 text-amber-300 border border-amber-500/40";
    case "push":
      return "bg-blue-500/20 text-blue-300 border border-blue-500/40";
    case "review":
      return "bg-violet-500/20 text-violet-300 border border-violet-500/40";
    case "decide":
      return "bg-red-500/20 text-red-300 border border-red-500/40";
    case "none":
    default:
      return "";
  }
}

/** Left-border accent for rows that require operator action (operator_action ≠ 'none'). */
function operatorActionRowAccent(action: OperatorAction): string {
  if (action === "none") return "";
  return "border-l-2 border-l-amber-500/60";
}

function lifecycleDotClasses(state: LifecycleState): string {
  switch (state) {
    case "active":
      return "bg-green-500";
    case "expiring":
      return "bg-amber-500";
    case "expired":
      return "bg-[var(--text-tertiary)]";
    case "archived":
    default:
      return "bg-[var(--text-tertiary)] opacity-50";
  }
}

function formatTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const age = Date.now() - ts;
  if (age < 0) return iso;
  return `${formatRelativeTime(age)} ago`;
}

/** Click-to-open for HTTP(S) urls; for paths, copy-to-clipboard (filesystem
 *  paths can't open from a browser sandbox without a custom protocol handler). */
async function handlePathCopy(text: string, onCopied: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onCopied();
  } catch {
    /* clipboard API unavailable — fail silently */
  }
}

function SurfaceRow({ surface }: { surface: ActiveSurface }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const typeIcon = SURFACE_TYPE_ICONS[surface.surface_type];
  const hasHttp = !!surface.url && /^https?:\/\//i.test(surface.url);
  const operatorAction: OperatorAction = surface.operator_action ?? "none";
  const showActionBadge = operatorAction !== "none";

  return (
    <li
      className={`px-2 py-1.5 border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--bg-surface)] transition-colors ${operatorActionRowAccent(operatorAction)}`}
      data-operator-action={operatorAction}
    >
      <div className="flex items-start gap-2">
        <div
          className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${lifecycleDotClasses(surface.lifecycle_state)}`}
          title={`lifecycle: ${surface.lifecycle_state}`}
          aria-label={`lifecycle ${surface.lifecycle_state}`}
        />
        <Icon
          path={typeIcon}
          size={0.55}
          className="text-[var(--text-secondary)] mt-0.5 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${tierClasses(surface.tier)}`}
              title={`tier ${surface.tier}`}
            >
              {surface.tier}
            </span>
            {showActionBadge && (
              <span
                className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${operatorActionBadgeClasses(operatorAction)}`}
                title={`operator action: ${operatorAction}`}
                aria-label={`operator action ${operatorAction}`}
              >
                {operatorAction}
              </span>
            )}
            <span className="text-xs font-medium text-[var(--text-primary)] truncate">
              {surface.id}
            </span>
          </div>
          {surface.brief_description && (
            <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">
              {surface.brief_description}
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--text-tertiary)]">
            <span>{surface.emitter}</span>
            <span>·</span>
            <span title={surface.timestamp}>{formatTimestamp(surface.timestamp)}</span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {hasHttp && surface.url ? (
            <a
              href={surface.url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-primary)] transition-colors"
              title={`Open ${surface.url}`}
              aria-label={`Open ${surface.id} URL`}
            >
              <Icon path={mdiOpenInNew} size={0.55} />
            </a>
          ) : null}
          {surface.path ? (
            <button
              onClick={() => handlePathCopy(surface.path!, onCopied)}
              className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-primary)] transition-colors"
              title={copied ? "Copied!" : `Copy path: ${surface.path}`}
              aria-label={`Copy path for ${surface.id}`}
            >
              <Icon path={copied ? mdiCheck : mdiContentCopy} size={0.55} />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function ActiveOperatorSurfaces(): React.ReactElement | null {
  const [collapsed, setCollapsed] = useState<boolean>(() => getCollapsed());
  const [showExpired, setShowExpired] = useState<boolean>(() => getShowExpired());
  const [surfaces, setSurfaces] = useState<ActiveSurface[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [parseWarning, setParseWarning] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const fetchSurfaces = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/operator-active-surfaces`);
      const body = await res.json();
      if (!mountedRef.current) return;
      if (body && body.success && body.data) {
        const data = body.data as ActiveSurfacesResponse;
        setSurfaces(data.surfaces ?? []);
        setUpdatedAt(data.updated_at ?? null);
        setParseWarning(data.parse_warning ?? null);
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

  useEffect(() => {
    mountedRef.current = true;
    void fetchSurfaces();
    const handle = window.setInterval(() => {
      void fetchSurfaces();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, [fetchSurfaces]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapsedPersist(next);
      return next;
    });
  }, []);
  const toggleShowExpired = useCallback(() => {
    setShowExpired((prev) => {
      const next = !prev;
      setShowExpiredPersist(next);
      return next;
    });
  }, []);
  const onRefresh = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void fetchSurfaces();
    },
    [fetchSurfaces],
  );

  // Sort: timestamp DESC (most-recent first). Filter: skip expired/archived
  // unless showExpired toggle is ON.
  const { visibleSurfaces, hiddenCount } = useMemo(() => {
    const sorted = [...surfaces].sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
    if (showExpired) return { visibleSurfaces: sorted, hiddenCount: 0 };
    const visible: ActiveSurface[] = [];
    let hidden = 0;
    for (const s of sorted) {
      if (s.lifecycle_state === "expired" || s.lifecycle_state === "archived") {
        hidden += 1;
        continue;
      }
      visible.push(s);
    }
    return { visibleSurfaces: visible, hiddenCount: hidden };
  }, [surfaces, showExpired]);

  const totalCount = surfaces.length;
  const visibleCount = visibleSurfaces.length;

  return (
    <div
      className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0"
      data-testid="active-operator-surfaces"
    >
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-surface)] transition-colors"
        aria-expanded={!collapsed}
        aria-controls="active-operator-surfaces-list"
      >
        <Icon
          path={collapsed ? mdiChevronRight : mdiChevronDown}
          size={0.55}
          className="text-[var(--text-secondary)] flex-shrink-0"
        />
        <span className="text-xs font-medium text-[var(--text-primary)] flex-1">
          Active operator surfaces
          {totalCount > 0 && (
            <span className="text-[var(--text-secondary)] ml-1">({visibleCount})</span>
          )}
        </span>
        <button
          onClick={onRefresh}
          className={`p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ${isLoading ? "animate-pulse" : ""}`}
          title="Refresh"
          aria-label="Refresh active operator surfaces"
        >
          <Icon path={mdiRefresh} size={0.55} />
        </button>
      </button>
      {!collapsed && (
        <div id="active-operator-surfaces-list" className="max-h-64 overflow-y-auto">
          {error ? (
            <div className="px-2 py-1.5 text-[11px] text-red-400">
              Failed to load: {error}
            </div>
          ) : visibleSurfaces.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-[var(--text-tertiary)] italic">
              No active surfaces. (Peers emit to this index when surface-iff
              sister-shape conditions fire.)
            </div>
          ) : (
            <ul className="list-none p-0 m-0">
              {visibleSurfaces.map((s) => (
                <SurfaceRow key={s.id} surface={s} />
              ))}
            </ul>
          )}
          {(hiddenCount > 0 || showExpired) && (
            <button
              onClick={toggleShowExpired}
              className="w-full px-2 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors text-left"
            >
              {showExpired
                ? "Hide expired/archived"
                : `Show ${hiddenCount} expired/archived`}
            </button>
          )}
          {parseWarning && (
            <div className="px-2 py-1 text-[10px] text-amber-500 border-t border-[var(--border-color)]">
              {parseWarning}
            </div>
          )}
          {updatedAt && (
            <div className="px-2 py-1 text-[10px] text-[var(--text-tertiary)] border-t border-[var(--border-color)]">
              Updated {formatTimestamp(updatedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
