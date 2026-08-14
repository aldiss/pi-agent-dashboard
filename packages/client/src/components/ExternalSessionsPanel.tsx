/**
 * ExternalSessionsPanel — READ-ONLY viewer for Codex / Claude Code sessions
 * that run in tmux panes on socket `pi` (invisible to the pi-session pipeline).
 *
 * Polls `GET /api/external-sessions` every 2s (same polling/collapsible idiom
 * as ActiveOperatorSurfaces). There is NO input path here by design: no prompt
 * box, no send / abort / kill / resume — viewing only. The one honesty rule the
 * UI must uphold: an ENDED session is shown as ended (gray pill, dimmed frozen
 * output, `ended … ago`), never as live.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@mdi/react";
import { mdiChevronDown, mdiChevronRight, mdiRefresh, mdiEyeOutline } from "@mdi/js";
import {
  fetchExternalSessions,
  type ExternalSession,
  type ExternalRuntime,
} from "../lib/external-sessions-api.js";
import { formatRelativeTime } from "../lib/format.js";

const POLL_INTERVAL_MS = 2_000;
const COLLAPSED_KEY = "dashboard:externalSessionsCollapsed";

/**
 * `full`    — dedicated /dashboard page: every session's output rendered inline.
 * `compact` — main session list sidebar: one row per session (badge / state /
 *             title / meta); the output is revealed per-row on click, so seven
 *             sessions don't push the operator's pi sessions off-screen.
 */
export type ExternalSessionsVariant = "full" | "compact";

/** Collapse state is per-variant so the sidebar and the page toggle independently. */
function collapsedKey(variant: ExternalSessionsVariant): string {
  return variant === "full" ? COLLAPSED_KEY : `${COLLAPSED_KEY}:${variant}`;
}
function getCollapsed(variant: ExternalSessionsVariant): boolean {
  try {
    return window.localStorage.getItem(collapsedKey(variant)) === "true";
  } catch {
    return false;
  }
}
function setCollapsedPersist(variant: ExternalSessionsVariant, value: boolean): void {
  try {
    window.localStorage.setItem(collapsedKey(variant), String(value));
  } catch {
    /* ignore */
  }
}

/** Distinct, never-lumped runtime badge styling + label. */
const RUNTIME_LABEL: Record<ExternalRuntime, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};
function runtimeBadgeClasses(runtime: ExternalRuntime): string {
  // Codex → teal/emerald; Claude Code → amber/orange. Visually distinct.
  return runtime === "codex"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
}

function relAgo(msEpoch: number): string {
  const age = Date.now() - msEpoch;
  return `${formatRelativeTime(age < 0 ? 0 : age)} ago`;
}

function SessionCard({
  session,
  compact = false,
}: {
  session: ExternalSession;
  compact?: boolean;
}): React.ReactElement {
  const live = session.state === "live";
  const meta: string[] = [];
  if (session.model) meta.push(session.model);
  if (session.effort) meta.push(session.effort);
  // Compact rows start closed; the operator opens the one they want to read.
  const [open, setOpen] = useState<boolean>(false);
  const showOutput = !compact || open;

  return (
    <li
      className={`px-3 py-2.5 border-b border-[var(--border-color)] last:border-b-0 ${
        compact ? "cursor-pointer hover:bg-[var(--bg-surface)] transition-colors" : ""
      }`}
      data-testid="external-session-card"
      data-runtime={session.runtime}
      data-state={session.state}
      {...(compact
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": open,
            onClick: () => setOpen((v) => !v),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen((v) => !v);
              }
            },
          }
        : {})}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {compact && (
          <Icon
            path={open ? mdiChevronDown : mdiChevronRight}
            size={0.5}
            className="text-[var(--text-tertiary)] flex-shrink-0"
          />
        )}
        <span
          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${runtimeBadgeClasses(session.runtime)}`}
        >
          {RUNTIME_LABEL[session.runtime]}
        </span>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
            live
              ? "bg-green-500/20 text-green-300 border border-green-500/40"
              : "bg-[var(--bg-surface)] text-[var(--text-tertiary)] border border-[var(--border-color)]"
          }`}
          title={live ? "live" : "ended"}
        >
          {live ? "Live" : "Ended"}
        </span>
        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
          {session.title}
        </span>
        {!live && session.endedAt != null && (
          <span className="text-[10px] text-[var(--text-tertiary)]">
            ended {relAgo(session.endedAt)}
          </span>
        )}
      </div>

      {(session.cwd || meta.length > 0) && (
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--text-tertiary)] flex-wrap">
          {meta.length > 0 && (
            <span className="text-[var(--text-secondary)]">{meta.join(" · ")}</span>
          )}
          {session.cwd && <span className="font-mono truncate">{session.cwd}</span>}
        </div>
      )}

      {showOutput && (
        <pre
          className={`mt-1.5 ${compact ? "max-h-48" : "max-h-64"} overflow-auto whitespace-pre rounded bg-[var(--bg-primary)] border border-[var(--border-color)] p-2 text-[11px] font-mono leading-snug text-[var(--text-secondary)] ${
            live ? "" : "opacity-50"
          }`}
          data-testid="external-session-output"
          {...(compact ? { onClick: (e: React.MouseEvent) => e.stopPropagation() } : {})}
        >
          {session.output || "(no output captured)"}
        </pre>
      )}

      <div className="mt-1 text-[10px] text-[var(--text-tertiary)]">
        {session.lineCount} line{session.lineCount === 1 ? "" : "s"} · updated {relAgo(session.outputAt)}
        {compact && !open && <span className="ml-1 opacity-70">· click to read</span>}
      </div>
    </li>
  );
}

export function ExternalSessionsPanel({
  variant = "full",
}: {
  variant?: ExternalSessionsVariant;
} = {}): React.ReactElement {
  const compact = variant === "compact";
  const [collapsed, setCollapsed] = useState<boolean>(() => getCollapsed(variant));
  const [sessions, setSessions] = useState<ExternalSession[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const list = await fetchExternalSessions();
      if (!mountedRef.current) return;
      setSessions(list);
      setError(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message ?? String(e));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const handle = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, [load]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapsedPersist(variant, next);
      return next;
    });
  }, [variant]);
  const onRefresh = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void load();
    },
    [load],
  );

  const liveCount = sessions.filter((s) => s.state === "live").length;

  return (
    <div
      className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)]"
      data-testid="external-sessions-panel"
    >
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-surface)] transition-colors"
        aria-expanded={!collapsed}
        aria-controls="external-sessions-list"
      >
        <Icon
          path={collapsed ? mdiChevronRight : mdiChevronDown}
          size={0.55}
          className="text-[var(--text-secondary)] flex-shrink-0"
        />
        <span className="text-xs font-medium text-[var(--text-primary)] flex-1">
          Codex &amp; Claude Code sessions
          {sessions.length > 0 && (
            <span className="text-[var(--text-secondary)] ml-1">
              ({liveCount} live / {sessions.length})
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] mr-1">
          <Icon path={mdiEyeOutline} size={0.5} />
          {compact ? "read-only" : "read-only view"}
        </span>
        <button
          onClick={onRefresh}
          className={`p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ${isLoading ? "animate-pulse" : ""}`}
          title="Refresh"
          aria-label="Refresh external sessions"
        >
          <Icon path={mdiRefresh} size={0.55} />
        </button>
      </button>

      {!collapsed && (
        <div id="external-sessions-list">
          {error ? (
            <div className="px-2 py-1.5 text-[11px] text-red-400">Failed to load: {error}</div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-[var(--text-tertiary)] italic">
              No Codex or Claude Code sessions found on tmux socket <code>pi</code>.
            </div>
          ) : (
            <ul className="list-none p-0 m-0">
              {sessions.map((s) => (
                <SessionCard key={s.id} session={s} compact={compact} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
