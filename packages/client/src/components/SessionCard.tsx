import React, { useState, useEffect, type ReactNode } from "react";
import { Icon } from "@mdi/react";
import { mdiFlash, mdiOpenInNew, mdiPencil, mdiPencilOutline, mdiSourceBranch, mdiHeartPulse, mdiEyeOffOutline, mdiEyeOutline, mdiConsoleLine, mdiRobotOutline, mdiCodeTags, mdiApplicationOutline, mdiCommentQuestion, mdiPlayCircleOutline, mdiSourceFork, mdiPaperclip, mdiFileTree } from "@mdi/js";
import type { DashboardSession, ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { getSessionDisplayName } from "../lib/session-display-name.js";
import { formatRelativeTime } from "../lib/format.js";
import { selectBadgeTimestamp } from "../lib/session-card-time.js";
import { deriveCardState } from "../lib/card-state.js";
import { getStaleHoursThreshold } from "../lib/session-filter-storage.js";
import { ContextUsageBar } from "./ContextUsageBar.js";
import { DriverProgressBar } from "./DriverProgressBar.js";
import { EngagementBadge } from "./EngagementBadge.js";
import type { ContextUsageInfo } from "./SessionList.js";
import type { OpenSpecChange } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { OpenSpecActivityBadge } from "./OpenSpecActivityBadge.js";
import { Pressable } from "../motion/index.js";

export const statusColors: Record<string, string> = {
  active: "bg-green-500",
  streaming: "bg-yellow-500 animate-pulse",
  idle: "bg-green-500",
  ended: "bg-[var(--bg-surface)]",
};

export const sourceBadgeColors: Record<string, string> = {
  tui: "text-blue-400",
  zed: "text-purple-400",
  tmux: "text-orange-400",
  dashboard: "text-blue-400",
  terminal: "text-cyan-400",
  unknown: "text-[var(--text-tertiary)]",
};

const sourceIcons: Record<string, string> = {
  tui: mdiConsoleLine,
  dashboard: mdiRobotOutline,
  tmux: mdiApplicationOutline,
  zed: mdiCodeTags,
  terminal: mdiConsoleLine,
};

const sourceLabels: Record<string, string> = {
  tui: "TUI",
  dashboard: "Headless",
  tmux: "tmux",
  zed: "Zed",
  terminal: "Terminal",
};

export function getCardPulseClass(session: DashboardSession): string {
  if (session.currentTool === "ask_user") return "bg-purple-500/5 animate-pulse";
  if (session.status === "streaming" || session.resuming) return "bg-yellow-500/5 animate-pulse";
  if (session.unread) return "bg-cyan-500/5";
  return "";
}

/** Semantic activity kind for the editorial status-as-color system. Drives the
 *  status rail, dot, and status-text color (all share one semantic hue) via
 *  CSS gated by [data-skin="editorial"][data-activity="…"]. Legacy ignores the
 *  resulting data-activity attribute entirely. Mirrors the branch order in
 *  ActivityIndicator so rail color and status text always agree.
 *    live  = green  (running a tool / resuming — work happening now)
 *    think = violet (streaming without a tool — reasoning)
 *    wait  = amber  (alive, awaiting operator input — incl. ask_user)
 *    unread= teal   (ended but has unviewed activity)
 *    idle  = grey   (ended/dormant) · error = red */
export function getActivityKind(session: DashboardSession, hasError?: boolean): string {
  if (hasError) return "error";
  if (session.resuming) return "live";
  if (session.status === "ended") return session.unread ? "unread" : "idle";
  if (session.currentTool === "ask_user") return "wait";
  if (session.currentTool) return "live";
  if (session.status === "streaming") return "think";
  if (session.status === "idle" || session.status === "active") return "wait";
  return "idle";
}

export function ActivityIndicator({ session }: { session: DashboardSession }) {
  if (session.resuming) {
    return <span className="editorial-activity text-yellow-400">Resuming…</span>;
  }
  if (session.status === "ended") return null;
  if (session.currentTool === "ask_user") {
    return <span className="editorial-activity text-purple-400 truncate inline-flex items-center gap-0.5"><Icon path={mdiFlash} size={0.5} /> Waiting for input</span>;
  }
  if (session.currentTool) {
    return <span className="editorial-activity text-yellow-400 truncate inline-flex items-center gap-0.5"><Icon path={mdiFlash} size={0.5} /> {session.currentTool}</span>;
  }
  if (session.status === "streaming") {
    return <span className="editorial-activity text-yellow-400 truncate inline-flex items-center gap-0.5"><Icon path={mdiFlash} size={0.5} /> Thinking…</span>;
  }
  if (session.status === "idle" || session.status === "active") {
    return <span className="editorial-activity text-[var(--text-tertiary)] truncate inline-flex items-center gap-0.5"><Icon path={mdiFlash} size={0.5} /> Waiting for input</span>;
  }
  return null;
}

export function WorktreeIndicator({ session }: { session: DashboardSession }) {
  if (!session.worktree) return null;
  return (
    <div
      className="text-[11px] mt-0.5 ml-4 flex items-center gap-1.5 text-[var(--text-tertiary)]"
      title={`Worktree: ${session.worktree.path}`}
    >
      <Icon path={mdiFileTree} size={0.5} />
      <span className="px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 text-[10px] font-mono truncate max-w-[160px]">
        {session.worktree.branch}
      </span>
    </div>
  );
}

export function GitInfo({ session }: { session: DashboardSession }) {
  if (!session.gitBranch) return null;
  return (
    <div className="text-[11px] mt-0.5 ml-4 flex items-center gap-1.5 text-[var(--text-tertiary)]">
      <Icon path={mdiSourceBranch} size={0.5} />
      {session.gitBranchUrl ? (
        <a href={session.gitBranchUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">
          {session.gitBranch}
        </a>
      ) : (
        <span className="truncate">{session.gitBranch}</span>
      )}
      {session.gitPrNumber != null && (
        <>
          <span className="text-[var(--text-muted)]">·</span>
          {session.gitPrUrl ? (
            <a href={session.gitPrUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
              #{session.gitPrNumber}
            </a>
          ) : (
            <span>#{session.gitPrNumber}</span>
          )}
        </>
      )}
    </div>
  );
}

// Exported for BranchSwitchDialog cache invalidation
export const branchCache = new Map<string, { branch: string | null; noGit: boolean }>();

import { getApiBase } from "../lib/api-context.js";

interface GroupGitInfoProps {
  sessions: DashboardSession[];
  cwd: string;
  onBranchClick?: () => void;
}

export function GroupGitInfo({ sessions, cwd, onBranchClick }: GroupGitInfoProps) {
  const session = sessions.find((s) => s.gitBranch);
  const cached = branchCache.get(cwd);
  const [fetchedBranch, setFetchedBranch] = useState<string | null>(cached?.branch ?? null);
  const [noGitRepo, setNoGitRepo] = useState(cached?.noGit ?? false);

  useEffect(() => {
    if (session?.gitBranch) {
      setFetchedBranch(null);
      setNoGitRepo(false);
      return;
    }
    if (branchCache.has(cwd)) return;
    if (!cwd) return;

    let cancelled = false;
    fetch(`${getApiBase()}/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) {
          branchCache.set(cwd, { branch: json.data.current, noGit: false });
          setFetchedBranch(json.data.current);
          setNoGitRepo(false);
        } else {
          branchCache.set(cwd, { branch: null, noGit: true });
          setNoGitRepo(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          branchCache.set(cwd, { branch: null, noGit: true });
          setNoGitRepo(true);
        }
      });
    return () => { cancelled = true; };
  }, [cwd, session?.gitBranch]);

  const branchName = session?.gitBranch ?? fetchedBranch;
  const branchUrl = session?.gitBranchUrl;
  const prNumber = session?.gitPrNumber;
  const prUrl = session?.gitPrUrl;

  if (!branchName) {
    return (
      <div className="text-[11px] flex items-center gap-1.5 text-[var(--text-muted)]">
        <button
          onClick={(e) => { e.stopPropagation(); onBranchClick?.(); }}
          className="flex items-center gap-1 hover:text-[var(--text-secondary)] transition-colors"
          title={noGitRepo ? "Initialize git repository" : "Git branches"}
          data-testid="git-init-btn"
        >
          <Icon path={mdiSourceBranch} size={0.5} />
          {noGitRepo && <span className="text-[10px]">Init git</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="text-[11px] flex items-center gap-1.5 text-[var(--text-tertiary)]">
      <button
        onClick={(e) => { e.stopPropagation(); onBranchClick?.(); }}
        className="flex items-center gap-1 hover:text-blue-400 transition-colors"
        title="Switch branch"
        data-testid="git-branch-btn"
      >
        <Icon path={mdiSourceBranch} size={0.5} />
      </button>
      {branchUrl ? (
        <a href={branchUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">
          {branchName}
        </a>
      ) : (
        <span className="truncate">{branchName}</span>
      )}
      {prNumber != null && (
        <>
          <span className="text-[var(--text-muted)]">·</span>
          {prUrl ? (
            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
              #{prNumber}
            </a>
          ) : (
            <span>#{prNumber}</span>
          )}
        </>
      )}
    </div>
  );
}

const editorIcons: Record<string, ReactNode> = {
  zed: <Icon path={mdiOpenInNew} size={0.5} />,
  vscode: <Icon path={mdiOpenInNew} size={0.5} />,
  idea: <Icon path={mdiOpenInNew} size={0.5} />,
};

export function EditorButtons({
  editors,
  onOpen,
}: {
  editors: { id: string; name: string }[];
  onOpen: (editorId: string) => void;
}) {
  if (editors.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {editors.map((editor) => (
        <button
          key={editor.id}
          onClick={(e) => { e.stopPropagation(); onOpen(editor.id); }}
          className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-secondary)] text-[var(--text-secondary)] hover:text-blue-400 hover:border-blue-500/50"
          title={`Open in ${editor.name}`}
        >
          <span className="inline-flex items-center gap-0.5">{editorIcons[editor.id] ?? <Icon path={mdiOpenInNew} size={0.5} />} {editor.name}</span>
        </button>
      ))}
    </div>
  );
}

// Meta chip component — used for git branch, worktree, attached proposal
function MetaChip({ icon, label, colorClass, maxWidth }: { icon: ReactNode; label: string; colorClass?: string; maxWidth?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border border-[var(--border-subtle)] bg-transparent ${
        colorClass ?? "text-[var(--text-muted)]"
      }`}
    >
      {icon}
      <span className={`truncate ${maxWidth ?? "max-w-[120px]"}`}>{label}</span>
    </span>
  );
}

export const SessionCard = React.memo(function SessionCard({
  session,
  selectedId,
  onSelect,
  now,
  isHidden,
  onHide,
  onUnhide,
  contextUsage,
  openspecChanges,
  onRename,
  onCheckLiveness,
  onResume,
  hasError,
}: {
  session: DashboardSession;
  selectedId?: string;
  onSelect: (id: string) => void;
  now: number;
  isHidden: boolean;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  contextUsage?: ContextUsageInfo;
  openspecChanges?: OpenSpecChange[];
  onRename?: (id: string, name: string) => void;
  /**
   * Read-only liveness re-check for a dark card (build-2 P0 fix #4). Replaces
   * the removed destructive "Exit pi session" control, which unregistered a
   * session WITHOUT death verification (the kill-0 hole — a SIGSTOP'd
   * interactive/tmux process can't service the shutdown command yet its row was
   * marked ended). This re-runs server-side hygiene (GET /api/sessions →
   * reconcileSessionHygiene) which re-probes kill-0 liveness and rescues a
   * false-ended row — it NEVER retires a target. Confirmed
   * terminate→verify-dead→retire stays P1.
   */
  onCheckLiveness?: (id: string) => void;
  onResume?: (id: string, mode: "continue" | "fork") => void;
  hasError?: boolean;
}) {
  const isSelected = selectedId === session.id;
  const isAlive = session.status !== "ended";
  const showCost = (session.cost ?? 0) > 0;
  const dotColor = session.resuming
    ? "bg-yellow-500 animate-pulse"
    : hasError
      ? "bg-red-500"
      : (statusColors[session.status] ?? "bg-[var(--bg-surface)]");

  const selectedRing = isSelected
    ? "border-blue-500/60 bg-blue-500/5 backdrop-blur-sm"
    : "border-[var(--border-subtle)] bg-[var(--bg-tertiary)]";

  const hasMetaChips = !!(session.gitBranch || session.worktree || session.attachedProposal);

  // Wire the ONE pure card-state derivation into the production card render
  // (build-2 fix-cycle NIT 2). Emitted as `data-age-band` / `data-band-reason`
  // so the derivation has a real production caller + an operator-visible DOM
  // surface (assertable), WITHOUT disturbing the existing editorial
  // `data-activity` hue CSS. error/ask are retained through age-decay by
  // `deriveCardState` itself (needs band never decays). `now` is the card's
  // interval clock; staleHours reuses the persisted `dashboard:staleHours`.
  const cardStaleHours = getStaleHoursThreshold();
  const cardState = deriveCardState(session, now, cardStaleHours);

  return (
    <Pressable
      as="li"
      pressScale={0.985}
      data-session-id={session.id}
      data-activity={getActivityKind(session, hasError)}
      data-age-band={cardState.ageBand}
      data-band-reason={cardState.reason}
      onClick={() => onSelect(session.id)}
      className={`editorial-card group relative px-3 py-2.5 md:px-3.5 md:py-2.5 cursor-pointer rounded-xl border shadow-sm shadow-[var(--shadow-card)] hover:shadow-md transition-shadow duration-200 flex flex-col gap-1 md:gap-2 ${
        selectedRing
      } ${isHidden ? "opacity-40" : ""} ${getCardPulseClass(session)}`}
    >
      {/* Row 1: status dot + source icon (desktop) + name + action buttons (desktop) + time (desktop) + cost (mobile) */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={`editorial-dot w-2 h-2 md:w-2.5 md:h-2.5 rounded-full shrink-0 ${dotColor}`} />
        {/* Source icon — desktop only */}
        <span
          className={`hidden md:inline-flex shrink-0 ${sourceBadgeColors[session.source] ?? "text-[var(--text-tertiary)]"}`}
          title={sourceLabels[session.source] ?? session.source}
        >
          <Icon path={sourceIcons[session.source] ?? mdiConsoleLine} size={0.55} />
        </span>
        {/* Session name */}
        <span className="editorial-name text-sm md:text-sm font-medium text-[var(--text-primary)] truncate flex-1">
          {getSessionDisplayName(session)}
        </span>
        {/* Action buttons — desktop only, visible on hover */}
        <span className="hidden md:flex items-center gap-1.5 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {isHidden ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUnhide(session.id); }}
              className="hover:text-green-400 transition-colors"
              title="Show session"
              data-testid="session-unhide-btn"
            >
              <Icon path={mdiEyeOutline} size={0.45} />
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onHide(session.id); }}
              className="hover:text-[var(--text-muted)] transition-colors"
              title="Hide session"
              data-testid="session-hide-btn"
            >
              <Icon path={mdiEyeOffOutline} size={0.45} />
            </button>
          )}
          {isAlive && onCheckLiveness && (
            <button
              onClick={(e) => { e.stopPropagation(); onCheckLiveness(session.id); }}
              className="hover:text-blue-400 transition-colors"
              title="Check liveness — re-verify this session is still running (read-only)"
              data-testid="session-check-liveness-btn"
            >
              <Icon path={mdiHeartPulse} size={0.5} />
            </button>
          )}
          {isAlive && (
            <button
              onClick={(e) => { e.stopPropagation(); onSelect(session.id); }}
              className="hover:text-green-400 transition-colors"
              title="Open session"
              data-testid="session-open-btn"
            >
              <Icon path={mdiOpenInNew} size={0.5} />
            </button>
          )}
        </span>
        {/* Time — desktop only */}
        <span
          className="hidden md:inline text-[10px] md:text-[11px] text-[var(--text-muted)] shrink-0"
          title={`Started ${new Date(session.startedAt).toLocaleString()}`}
        >
          {formatRelativeTime(now - selectBadgeTimestamp(session))}
        </span>
        {/* Cost — mobile only (inline in row 1), desktop in row 3 */}
        {showCost && (
          <span className="md:hidden text-[11px] text-[var(--text-secondary)] shrink-0 tabular-nums">
            ${session.cost!.toFixed(2)}
          </span>
        )}
      </div>

      {/* Mobile-only dark-card control row (build-2 fix-cycle FATAL 3): LITERAL
          visible text `Open` + read-only `Check liveness` at 393px (not just
          title/aria-label). Desktop uses the hover icon cluster above. There is
          NO destructive Exit here — the removed Exit path was the kill-0 hole.
          Only alive cards (a dark/unknown/kill-0-live session looks alive). */}
      {isAlive && (
        <div className="md:hidden flex items-center gap-2 pt-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(session.id); }}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-green-400 transition-colors px-1.5 py-1 rounded"
            data-testid="session-open-btn-mobile"
          >
            <Icon path={mdiOpenInNew} size={0.55} />
            <span>Open</span>
          </button>
          {onCheckLiveness && (
            <button
              onClick={(e) => { e.stopPropagation(); onCheckLiveness(session.id); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)] hover:text-blue-400 transition-colors px-1.5 py-1 rounded"
              data-testid="session-check-liveness-btn-mobile"
              title="Re-verify this session is still running (read-only)"
            >
              <Icon path={mdiHeartPulse} size={0.55} />
              <span>Check liveness</span>
            </button>
          )}
        </div>
      )}

      {/* Row 2: model + thinking level (left) | resume/fork (desktop right) */}
      <div className="flex items-center text-[11px] md:text-xs text-[var(--text-secondary)]">
        {session.model && (
          <span className="editorial-meta truncate">
            {session.model}{session.thinkingLevel ? ` (${session.thinkingLevel})` : ""}
          </span>
        )}
        <span className="flex-1" />
        {/* Resume/Fork — desktop only, ended sessions only */}
        {onResume && session.sessionFile && !isAlive && (
          <span className="hidden md:flex items-center gap-1.5 shrink-0 pl-3">
            {(!isAlive || isHidden) && (
              <button
                onClick={(e) => { e.stopPropagation(); onResume(session.id, "continue"); }}
                disabled={session.resuming}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title="Resume session"
              >
                <Icon path={mdiPlayCircleOutline} size={0.4} className="inline mr-0.5" />Resume
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onResume(session.id, "fork"); }}
              disabled={session.resuming}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Fork session"
            >
              <Icon path={mdiSourceFork} size={0.4} className="inline mr-0.5" />Fork
            </button>
          </span>
        )}
      </div>

      {/* Row 3: activity (left) | context bar + cost (right) — context+activity always visible per operator-empirical mobile friction 2026-05-23 ~23:35 CEST; cost desktop-only since mobile shows it in Row 1 */}
      <div className="flex items-center text-[11px] gap-2 mt-0.5">
        <ActivityIndicator session={session} />
        <span className="flex-1" />
        <ContextUsageBar
          tokens={contextUsage?.tokens ?? null}
          contextWindow={contextUsage?.contextWindow}
          compact
        />
        {showCost && (
          <span className="hidden md:inline text-[var(--text-secondary)] w-9 text-right tabular-nums">
            ${session.cost!.toFixed(2)}
          </span>
        )}
      </div>

      {/* Row 3b: per-driver self-report (dl-2620) — progress-% (left) + next-
          engagement-effort badge (right), shown ALONGSIDE context-% for drivers
          that self-report via the `driver-report` CLI. Renders ONLY when present,
          so non-driver cards are pixel-identical to before. */}
      {(session.progress || session.nextEngagement) && (
        <div className="flex items-center gap-2 text-[11px]" data-testid="driver-indicators-row">
          <DriverProgressBar progress={session.progress} compact />
          <span className="flex-1" />
          <EngagementBadge nextEngagement={session.nextEngagement} />
        </div>
      )}

      {/* Row 4: OpenSpec badge — desktop only, conditional */}
      {(session.openspecPhase || session.openspecChange) ? (
        <div className="hidden md:block">
          <OpenSpecActivityBadge
            phase={session.openspecPhase ?? undefined}
            changeName={session.openspecChange ?? undefined}
            completedTasks={
              session.openspecChange
                ? openspecChanges?.find((c) => c.name === session.openspecChange)?.completedTasks
                : undefined
            }
            totalTasks={
              session.openspecChange
                ? openspecChanges?.find((c) => c.name === session.openspecChange)?.totalTasks
                : undefined
            }
          />
        </div>
      ) : null}

      {/* Row 5 (desktop) / Row 3-4 (mobile): Meta chips */}
      {hasMetaChips && (
        <div className="flex flex-wrap gap-1.5 mt-0.5">
          {session.gitBranch && (
            <MetaChip
              icon={<Icon path={mdiSourceBranch} size={0.4} />}
              label={session.gitPrNumber != null ? `${session.gitBranch} · #${session.gitPrNumber}` : session.gitBranch}
            />
          )}
          {session.worktree && (
            <MetaChip
              icon={<Icon path={mdiFileTree} size={0.4} />}
              label={session.worktree.branch}
              maxWidth="max-w-[100px]"
            />
          )}
          {session.attachedProposal && (
            <MetaChip
              icon={<Icon path={mdiPaperclip} size={0.4} />}
              label={session.attachedProposal}
              maxWidth="max-w-[160px]"
            />
          )}
        </div>
      )}
    </Pressable>
  );
});
