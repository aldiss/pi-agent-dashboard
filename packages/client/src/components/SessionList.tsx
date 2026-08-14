import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { SpawnErrorBanner } from "./SpawnErrorBanner.js";
import { getApiBase } from "../lib/api-context.js";
import { useLocation } from "wouter";
import { Icon } from "@mdi/react";
import { mdiChevronRight, mdiChevronDown, mdiChevronUp, mdiPlus, mdiPin, mdiFolder, mdiFolderOpen, mdiConsoleLine, mdiCog, mdiPuzzleOutline, mdiFileDocumentOutline, mdiViewDashboard, mdiAccountGroup, mdiCube, mdiHelpCircle, mdiSteering } from "@mdi/js";
import { PiLogo } from "./PiLogo.js";
import { FolderActionBar } from "./FolderActionBar.js";
import { encodeFolderPath } from "../lib/folder-encoding.js";
import { DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { SortablePinnedGroup } from "./SortablePinnedGroup.js";
import type { DashboardSession, OpenSpecData, CommandInfo, FlowInfo, ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import {
  groupSessionsByDirectory,
  groupSessionsByTier,
  classifyTier,
  filterSessions,
  filterStaleSessions,
  filterByQuery,
  sortSessionsByOrder,
  groupTierByFolder,
  stablePartitionByBand,
  SESSION_TIER_ORDER,
  type DirectoryGroup,
  type SessionTier,
} from "../lib/session-grouping.js";
// TerminalCard removed — terminals now in TerminalsView
import {
  getCollapsedGroups,
  setCollapsedGroups,
  pruneStaleCollapsedGroups,
  removeLegacyHiddenSessions,
  getStaleHoursThreshold,
  getHideStale,
  setHideStale,
  getGroupByFolder,
  setGroupByFolder,
} from "../lib/session-filter-storage.js";
import { SessionCard, GroupGitInfo, EditorButtons, branchCache } from "./SessionCard.js";
import { PlaceholderSessionCard } from "./PlaceholderSessionCard.js";
import { FolderOpenSpecSection } from "./FolderOpenSpecSection.js";
import { SidebarFolderSectionSlot } from "@blackbelt-technology/dashboard-plugin-runtime";
import { ThemeToggle } from "./ThemeToggle.js";
import { ThemePicker } from "./ThemePicker.js";
import { useEditors } from "../lib/use-editors.js";
import { openEditor } from "../lib/editor-api.js";
import { Toast, useToast } from "./Toast.js";
import { BranchSwitchDialog } from "./BranchSwitchDialog.js";
import { truncatePathMiddle } from "../lib/truncate-path.js";
import { selectedCardScrollFingerprint } from "../lib/session-list-scroll.js";
import { TunnelButton } from "./TunnelButton.js";
import { InstallButton } from "./InstallButton.js";
import { useInstallPrompt } from "../hooks/useInstallPrompt.js";
import { useSkinContext } from "./SkinProvider.js";


export interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
}

interface Props {
  sessions: DashboardSession[];
  selectedId?: string;
  onSelect: (sessionId: string) => void;
  /**
   * Cold-load success oracle (build-2 fix-cycle-2 MAJOR 1). When `false`, the
   * fleet has NOT settled-loaded (a REST/snapshot or surfaces source is still
   * pending or failed), so the sidebar must NOT show the calm "No active
   * sessions" copy — an unsettled/failed source renders a loading line instead.
   * `undefined` = back-compat (treated as loaded, preserving existing callers).
   */
  hasLoadedOnce?: boolean;
  contextUsageMap?: Map<string, ContextUsageInfo>;
  openspecMap?: Map<string, OpenSpecData>;
  sessionOrderMap?: Map<string, string[]>;
  onReorderSessions?: (cwd: string, sessionIds: string[]) => void;
  onSendPrompt?: (sessionId: string, text: string, images?: ImageContent[]) => void;
  onFlowAction?: (sessionId: string, action: string, opts?: { flowName?: string; task?: string; description?: string }) => void;
  onOpenSpecRefresh?: (cwd: string) => void;
  onAttachProposal?: (sessionId: string, changeName: string) => void;
  onBulkArchive?: (cwd: string, cleanupWorktree?: boolean) => void;
  onReadArtifact?: (cwd: string, changeName: string, artifactId: string) => void;
  onOpenPiResources?: (cwd: string) => void;
  onDetachProposal?: (sessionId: string) => void;
  onRename?: (sessionId: string, name: string) => void;
  /** Read-only dark-card liveness re-check (build-2 P0 fix #4). Replaces the
   *  removed destructive Exit control; re-runs server hygiene, never retires. */
  onCheckLiveness?: (sessionId: string) => void;
  onResume?: (sessionId: string, mode: "continue" | "fork") => void;
  /**
   * Drag-to-resume entry point. Distinct from `onResume` so the WS
   * message can carry `placement: "keep"`, preserving the dropped slot
   * through the resume round-trip.
   * See change: differentiate-resume-intent-by-trigger.
   */
  onResumeKeepPosition?: (sessionId: string) => void;
  onHideSession?: (sessionId: string) => void;
  onUnhideSession?: (sessionId: string) => void;
  onSpawnSession?: (cwd: string, attachProposal?: string) => void;
  onSpawnWorktree?: (cwd: string) => void;
  spawningCwds?: Set<string>;
  spawnResult?: { success: boolean; message: string } | null;
  onSpawnResultSeen?: () => void;
  pinnedDirectories?: string[];
  onPinDirectory?: (dirPath: string) => void;
  /** Called when the "Add folder" button is clicked. Opens the app-level PinDirectoryDialog. */
  onOpenPinDialog?: () => void;
  onUnpinDirectory?: (dirPath: string) => void;
  onReorderPinnedDirs?: (paths: string[]) => void;
  terminals?: TerminalSession[];
  onKillTerminal?: (terminalId: string) => void;
  onRenameTerminal?: (terminalId: string, title: string) => void;
  onCollapseSidebar?: () => void;
  commandsMap?: Map<string, CommandInfo[]>;
  flowsMap?: Map<string, FlowInfo[]>;
  onKillProcess?: (sessionId: string, pgid: number) => void;
  onOpenSpecs?: (cwd: string) => void;
  onOpenArchive?: (cwd: string) => void;
  onViewReadme?: (cwd: string) => void;
  onOpenTerminals?: (cwd: string) => void;
  onOpenEditor?: (cwd: string) => void;
  editorStatuses?: Map<string, { id: string; status: import("@blackbelt-technology/pi-dashboard-shared/editor-types.js").EditorInstanceStatus }>;
  editorAvailable?: boolean;
  /** Extra content rendered in the sidebar header toolbar */
  headerExtra?: React.ReactNode;
  /** Set of session IDs that have an active error */
  errorSessionIds?: Set<string>;
  /** Per-workspace spawn errors (cwd → detail). See change: spawn-failure-diagnostics. */
  spawnErrors?: Map<string, import("../hooks/useMessageHandler.js").SpawnErrorDetail>;
  /** Dismiss a spawn error for a workspace */
  onDismissSpawnError?: (cwd: string) => void;
  /** Per-session resume errors (sessionId → message) */
  resumeErrors?: Map<string, string>;
  /** Dismiss a resume error for a session */
  onDismissResumeError?: (sessionId: string) => void;
}

// Re-export for backwards compatibility
export { groupSessionsByDirectory, filterSessions, type DirectoryGroup } from "../lib/session-grouping.js";

/**
 * Per-tier UI metadata: label shown in the section header + icon used to
 * the left of the label. Kept alongside SessionList because these are
 * presentation-layer choices, not classification semantics.
 */
const TIER_LABEL: Record<SessionTier, string> = {
  "standing-crew": "Standing crew",
  drivers: "Drivers",
  "cell-executor": "Cell-executors",
  "operator-chat-pane": "Operator chat-panes",
  worker: "Workers",
  other: "Other",
};

const TIER_ICON: Record<SessionTier, string> = {
  "standing-crew": mdiAccountGroup,
  drivers: mdiSteering,
  "cell-executor": mdiCube,
  "operator-chat-pane": mdiConsoleLine,
  worker: mdiCog,
  other: mdiHelpCircle,
};

/**
 * Tiers whose section is expanded by default. Tiers NOT listed here
 * (operator-chat-pane, worker, other) default to collapsed; the user's
 * explicit toggle inverts the default and is persisted by flipping the
 * presence of `tier:<name>` in the shared collapsed-groups set.
 */
const DEFAULT_EXPANDED_TIERS: ReadonlySet<SessionTier> = new Set<SessionTier>([
  "standing-crew",
  "drivers",
  "cell-executor",
]);

function tierStorageKey(tier: SessionTier): string {
  return `tier:${tier}`;
}

/**
 * Resolve a tier's effective collapsed state from the shared collapsed set.
 * Default-expanded tiers are collapsed iff the key is present; default-collapsed
 * tiers are collapsed iff the key is ABSENT — so a single boolean flip via
 * `toggleTierCollapsed` produces the user-expected behavior regardless of
 * which side of the default they started on.
 */
function isTierCollapsedDefault(tier: SessionTier, collapsed: Set<string>): boolean {
  const key = tierStorageKey(tier);
  const defaultExpanded = DEFAULT_EXPANDED_TIERS.has(tier);
  return defaultExpanded ? collapsed.has(key) : !collapsed.has(key);
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-1.5 py-0.5 rounded border ${
        active
          ? "border-blue-500/50 text-blue-400 bg-blue-500/10"
          : "border-[var(--border-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

export function SessionList({ sessions, selectedId, onSelect, hasLoadedOnce, contextUsageMap, openspecMap, sessionOrderMap, onReorderSessions, onSendPrompt, onFlowAction, onOpenSpecRefresh, onAttachProposal, onDetachProposal, onBulkArchive, onReadArtifact, onOpenPiResources, onRename, onCheckLiveness, onResume, onResumeKeepPosition, onHideSession, onUnhideSession, onSpawnSession, onSpawnWorktree, spawningCwds, spawnResult, onSpawnResultSeen, pinnedDirectories, onPinDirectory, onOpenPinDialog, onUnpinDirectory, onReorderPinnedDirs, terminals, onKillTerminal, onRenameTerminal, onCollapseSidebar, commandsMap, flowsMap, onKillProcess, onOpenSpecs, onOpenArchive, onOpenTerminals, onOpenEditor, editorStatuses, editorAvailable, headerExtra, errorSessionIds, spawnErrors, onDismissSpawnError, resumeErrors, onDismissResumeError }: Props) {
  // Coarse, interval-updated wall clock. Used only by the relative-time badge
  // (`now - selectBadgeTimestamp(session)`, class `hidden md:inline`) and the
  // stale-active filter (≤30s staleness is irrelevant to either). Computing
  // `Date.now()` inline on every render minted a fresh `now` each pass, which
  // poisoned the `filteredSessions` useMemo dep chain AND defeated
  // React.memo(SessionCard) via a fresh `now` prop. Refresh on a 30s interval
  // instead so identity stays stable across unrelated re-renders.
  // See change: fix-session-list-rerender-storm.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [, navigate] = useLocation();
  const { messages, showToast, dismissToast } = useToast();
  const installPrompt = useInstallPrompt();
  const { skin } = useSkinContext();

  // Scroll-to-selected-card wiring.
  // See change: auto-scroll-selected-session-card.
  // - Scroll on background re-sort of unchanged selection (status/hidden/cwd/order index).
  // - One-shot scroll on first mount when selectedId is set (deep-link arrival).
  // - Do NOT scroll on subsequent selectedId changes (user click / programmatic switch).
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevSelectedRef = useRef<string | undefined>(selectedId);
  const firstMountRef = useRef(true);
  const scrollFingerprint = useMemo(
    () => selectedCardScrollFingerprint(selectedId, sessions, sessionOrderMap),
    [selectedId, sessions, sessionOrderMap],
  );
  useEffect(() => {
    if (scrollFingerprint === null) {
      // Even when noop'ing, keep prev-selected ref in sync so a subsequent
      // background re-sort of a newly-clicked selection scrolls correctly.
      prevSelectedRef.current = selectedId;
      firstMountRef.current = false;
      return;
    }
    const selectionChanged = prevSelectedRef.current !== selectedId;
    prevSelectedRef.current = selectedId;
    const isFirstMount = firstMountRef.current;
    firstMountRef.current = false;
    if (!isFirstMount && selectionChanged) {
      // User clicked / programmatic switch — do not hijack scroll position.
      return;
    }
    if (!selectedId) return;
    const escaped = (window.CSS && typeof window.CSS.escape === "function")
      ? window.CSS.escape(selectedId)
      : selectedId.replace(/"/g, '\\"');
    const el = listRef.current?.querySelector(`[data-session-id="${escaped}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [scrollFingerprint, selectedId]);


  // Detect editors for all unique cwds (sessions + pinned directories)
  const cwds = useMemo(() => [...sessions.map((s) => s.cwd), ...(pinnedDirectories ?? [])], [sessions, pinnedDirectories]);
  const editorMap = useEditors(cwds);

  // Track which directories have README.md



  const handleOpenEditor = useCallback(async (cwd: string, editorId: string) => {
    const result = await openEditor(cwd, editorId);
    if (!result.success) {
      showToast(result.error ?? "Failed to open editor");
    }
  }, [showToast]);

  // Remove legacy client-side hidden storage on mount
  useEffect(() => {
    removeLegacyHiddenSessions();
  }, []);

  // Show toast for spawn results
  useEffect(() => {
    if (spawnResult) {
      showToast(spawnResult.success ? spawnResult.message : `Spawn failed: ${spawnResult.message}`);
      onSpawnResultSeen?.();
    }
  }, [spawnResult, showToast, onSpawnResultSeen]);

  const [branchDialogCwd, setBranchDialogCwd] = useState<string | null>(null);

  // Filter state - active-only defaults to ON
  // Single visibility toggle: `Show hidden`. The previous `Active only`
  // toggle was removed in favour of universal active-first ranking and
  // per-folder search. Ended sessions
  // are always visible but ranked below active ones; hidden sessions
  // are off by default and surfaced via this single toggle.
  // See change: pin-and-search-sessions (design D1 revised).
  const [showHidden, setShowHidden] = useState(false);
  // Stale-active filter state. When `hideStale` is on (default ON), sessions whose
  // `status` is not `ended` but which have seen no activity in the last
  // `staleHoursThreshold` hours are hidden. The currently-selected session is
  // always preserved by `filterStaleSessions` so the user does not lose context.
  // Persisted via dashboard:hideStale / dashboard:staleHours.
  const [hideStale, setHideStaleState] = useState(() => getHideStale());
  const staleHoursThreshold = useMemo(() => getStaleHoursThreshold(), []);
  // Folder-grouping toggle. When ON (default), each tier's sessions are grouped
  // into directory folders; when OFF, the tier renders a flat list of sessions
  // with no directory wrapping. Persisted via dashboard:groupByFolder.
  const [groupByFolder, setGroupByFolderState] = useState(() => getGroupByFolder());
  // Sidebar-level search/filter.
  //   - workspaceFilter: substring match against the folder path.
  //     Narrows the folder list. Matching folders auto-expand.
  //   - sessionSearch: case-insensitive match against session.name /
  //     firstMessage. Sessions outside the matching set are hidden;
  //     the folder containing them auto-expands to reveal the match.
  // Both filters compose with `Show hidden`. AND-composition when both
  // are filled. See change: pin-and-search-sessions (design D1 revised).
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  // Per-folder "show ended" expansion state. Ended sessions are collapsed
  // by default inside each folder; a minimal `Show N ended` row at the
  // bottom toggles. State is keyed by cwd; absent = collapsed (default).
  // The session-search query auto-expands ended in matching folders.
  const [endedExpanded, setEndedExpanded] = useState<Set<string>>(new Set());
  const toggleEndedExpanded = useCallback((cwd: string) => {
    setEndedExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  // Collapsed groups state
  const [collapsedGroups, setCollapsedGroupsState] = useState(() => getCollapsedGroups());

  const handleToggleTierCollapse = useCallback((tier: SessionTier) => {
    setCollapsedGroupsState((prev) => {
      const key = `tier:${tier}`;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setCollapsedGroups(next);
      return next;
    });
  }, []);

  // Prune stale collapsed groups when sessions change
  useEffect(() => {
    if (sessions.length === 0) return;
    const knownCwds = new Set(sessions.map((s) => s.cwd));
    const prunedGroups = pruneStaleCollapsedGroups(knownCwds);
    setCollapsedGroupsState(prunedGroups);
  }, [sessions.length]);



  const handleHide = useCallback((id: string) => {
    onHideSession?.(id);
  }, [onHideSession]);

  const handleToggleCollapse = useCallback((cwd: string) => {
    setCollapsedGroupsState((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      setCollapsedGroups(next);
      return next;
    });
  }, []);

  const handleUnhide = useCallback((id: string) => {
    onUnhideSession?.(id);
  }, [onUnhideSession]);

  // `filterSessions` is called with `activeOnly: false` permanently —
  // active-first ranking now happens per-folder via `rankActiveFirst`,
  // so the global "hide ended" pre-filter is unnecessary.
  //
  // The stale-active filter runs in the same pipeline step: it sweeps
  // out non-ended sessions older than `staleHoursThreshold` hours, but
  // explicitly preserves `selectedId` so the user never loses what they
  // are looking at to a background filter.
  const filteredSessions = useMemo(
    () => filterStaleSessions(
      filterSessions(sessions, false, showHidden),
      staleHoursThreshold,
      hideStale,
      now,
      selectedId,
    ),
    [sessions, showHidden, staleHoursThreshold, hideStale, now, selectedId],
  );

  const hiddenCount = useMemo(
    () => sessions.filter((s) => s.hidden).length,
    [sessions],
  );

  // Build a map of terminals by cwd for quick lookup
  const terminalsByCwd = useMemo(() => {
    const map = new Map<string, TerminalSession[]>();
    for (const t of terminals ?? []) {
      const existing = map.get(t.cwd);
      if (existing) existing.push(t);
      else map.set(t.cwd, [t]);
    }
    return map;
  }, [terminals]);

  const { pinned: pinnedGroups, unpinned: unpinnedGroups } = useMemo(
    () => groupSessionsByDirectory(filteredSessions, sessionOrderMap, pinnedDirectories),
    [filteredSessions, sessionOrderMap, pinnedDirectories],
  );
  // Tier-grouped view of the UNPINNED sessions only. Pinned directories stay
  // in their dedicated section above the tier list (preserves drag-to-reorder
  // semantics + the explicit operator pinning intent regardless of role).
  //
  // Within each tier the existing directory grouping logic applies (sessions
  // group by cwd; cwd ordering matches `sortSessionsByOrder` for stability).
  // A directory containing sessions across multiple tiers naturally appears
  // in each tier with only that tier's sessions visible inside it.
  const tierGroups = useMemo<Array<{ tier: SessionTier; sessions: DashboardSession[]; groups: DirectoryGroup[] }>>(() => {
    const unpinnedSessions = unpinnedGroups.flatMap((g) => g.sessions);
    const byTier = groupSessionsByTier(unpinnedSessions);
    const out: Array<{ tier: SessionTier; sessions: DashboardSession[]; groups: DirectoryGroup[] }> = [];
    for (const tier of SESSION_TIER_ORDER) {
      const tierSessions = byTier.get(tier);
      if (!tierSessions || tierSessions.length === 0) continue;
      // groupByFolder ON → split into directory folders; OFF → one flat bucket
      // (keyed per-tier so ended-toggle state stays stable). Powers the
      // sidebar "Folders" toggle.
      const groups = groupTierByFolder(tierSessions, groupByFolder, sessionOrderMap, `__tier__:${tier}`);
      out.push({ tier, sessions: tierSessions, groups });
    }
    return out;
  }, [unpinnedGroups, sessionOrderMap, groupByFolder]);
  const allGroups = useMemo(
    () => [...pinnedGroups, ...tierGroups.flatMap((tg) => tg.groups)],
    [pinnedGroups, tierGroups],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeType = active.data.current?.type;
    const overType = over.data.current?.type;

    // Cross-type drag is a no-op
    if (activeType !== overType) return;

    if (activeType === "session") {
      for (const group of allGroups) {
        // Flat-mode tier buckets use a synthetic cwd key and have no real
        // directory to persist order against — skip reorder/resume for them.
        if (group.cwd.startsWith("__tier__:")) continue;
        // Session IDs only (terminals moved to TerminalsView)
        const sessionIds = group.sessions.map((s) => s.id);
        const oldIndex = sessionIds.indexOf(active.id as string);
        const newIndex = sessionIds.indexOf(over.id as string);
        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(sessionIds, oldIndex, newIndex);
          onReorderSessions?.(group.cwd, newOrder);
          // Drag-to-resume: if the user dragged an ENDED session onto
          // an ALIVE one (i.e., placed it inside the alive tier), treat
          // that as intent to bring the session back. Auto-resume in
          // continue mode. The persisted order (with the ended id now
          // in the alive zone) means the client filter will pick it up
          // at the dropped position once status flips to alive.
          // See change: pin-and-search-sessions.
          const draggedSession = group.sessions.find((s) => s.id === active.id);
          const overSession = group.sessions.find((s) => s.id === over.id);
          if (
            draggedSession?.status === "ended" &&
            draggedSession.sessionFile &&
            overSession && overSession.status !== "ended"
          ) {
            // Drag-to-resume — the dropped slot was just persisted by
            // the `onReorderSessions` call above; route through the
            // keep-position callback so the server's ended→alive
            // branch does NOT move the id to the front and clobber it.
            // Fallback to onResume for callers that haven't wired the
            // new callback yet (preserves legacy behavior).
            // See change: differentiate-resume-intent-by-trigger.
            if (onResumeKeepPosition) {
              onResumeKeepPosition(draggedSession.id);
            } else {
              onResume?.(draggedSession.id, "continue");
            }
          }
          break;
        }
      }
    } else if (activeType === "pinned-group") {
      const ids = pinnedGroups.map((g) => g.cwd);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(ids, oldIndex, newIndex);
        onReorderPinnedDirs?.(newOrder);
      }
    }
  }, [allGroups, pinnedGroups, onReorderSessions, onReorderPinnedDirs, onResume, onResumeKeepPosition]);

  /**
   * Decide whether a folder should be visible given the active filters.
   * Workspace filter matches against folder path; session filter matches
   * against any session title within the folder. Both are AND'd when set.
   */
  function folderMatchesFilters(group: DirectoryGroup): boolean {
    const wf = workspaceFilter.trim().toLowerCase();
    const sf = sessionSearch.trim().toLowerCase();
    const folderHit = wf.length === 0 || group.cwd.toLowerCase().includes(wf);
    if (!folderHit) return false;
    if (sf.length === 0) return true;
    return filterByQuery(group.sessions, sf).length > 0;
  }

  /**
   * Force-expand folders when a filter is active so users can immediately
   * see what matched without an extra click. The user-toggled
   * `collapsedGroups` set still controls behavior at rest.
   */
  function isFolderCollapsed(cwd: string): boolean {
    if (workspaceFilter.length > 0 || sessionSearch.length > 0) return false;
    return collapsedGroups.has(cwd);
  }

  function renderGroup(group: DirectoryGroup, isPinned: boolean) {
    const dirName = truncatePathMiddle(group.cwd, 45);
    const isCollapsed = isFolderCollapsed(group.cwd);

    return (
      <div key={group.cwd} className="bg-[var(--bg-secondary)] rounded-lg p-2">
        <div
          className="px-2 py-1.5 min-h-[44px] md:min-h-0 cursor-pointer rounded hover:bg-[var(--bg-hover)]"
          onClick={() => handleToggleCollapse(group.cwd)}
        >
          <div className="flex items-center gap-1.5">
            <span className="inline-flex text-[var(--text-tertiary)]">
              <Icon path={isCollapsed ? mdiChevronRight : mdiChevronDown} size={0.6} />
            </span>
            <span className="text-xs font-medium text-[var(--text-secondary)] truncate flex items-center gap-1">
              <Icon path={isCollapsed ? mdiFolder : mdiFolderOpen} size={0.5} className="shrink-0" /> {dirName}
            </span>
            <span className="text-[10px] text-[var(--text-muted)]">({group.sessions.length})</span>
            {/* Pin/Unpin toggle */}
            {(isPinned || onPinDirectory) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPinned) onUnpinDirectory?.(group.cwd);
                  else onPinDirectory?.(group.cwd);
                }}
                className={`ml-auto px-1 py-0.5 rounded ${isPinned ? "text-yellow-400 hover:text-yellow-300" : "text-[var(--text-tertiary)] hover:text-yellow-400"}`}
                title={isPinned ? "Unpin directory" : "Pin directory"}
                data-testid={isPinned ? "unpin-dir-btn" : "pin-dir-btn"}
              >
                <Icon path={mdiPin} size={0.55} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <GroupGitInfo
              sessions={group.sessions}
              cwd={group.cwd}
              onBranchClick={() => setBranchDialogCwd(group.cwd)}
            />
          </div>
          <div className="mt-1 ml-5">
            <FolderActionBar
              cwd={group.cwd}
              terminalCount={terminalsByCwd.get(group.cwd)?.length ?? 0}
              editorStatus={editorStatuses?.get(group.cwd)}
              editorAvailable={editorAvailable}
              nativeEditors={editorMap.get(group.cwd) ?? []}
              spawningDisabled={spawningCwds?.has(group.cwd)}
              onSpawnSession={() => onSpawnSession?.(group.cwd)}
              onSpawnWorktree={onSpawnWorktree ? () => onSpawnWorktree(group.cwd) : undefined}
              onOpenTerminals={() => onOpenTerminals?.(group.cwd)}
              onOpenEditor={() => onOpenEditor?.(group.cwd)}
              onOpenNativeEditor={(editorId) => handleOpenEditor(group.cwd, editorId)}
              onOpenPiResources={() => onOpenPiResources?.(group.cwd)}
            />
          </div>
          {/* Plugin slot: sidebar-folder-section (additive, coexists with FolderOpenSpecSection) */}
          <SidebarFolderSectionSlot folder={{ cwd: group.cwd }} />
          {openspecMap?.get(group.cwd)?.initialized && (
            <FolderOpenSpecSection
              data={openspecMap.get(group.cwd)!}
              cwd={group.cwd}
              onRefresh={() => onOpenSpecRefresh?.(group.cwd)}
              onReadArtifact={onReadArtifact ? (changeName, artifactId) => onReadArtifact(group.cwd, changeName, artifactId) : undefined}
              sessions={group.sessions}
              onNavigateToSession={onSelect}
              onOpenSpecs={onOpenSpecs ? () => onOpenSpecs(group.cwd) : undefined}
              onOpenArchive={onOpenArchive ? () => onOpenArchive(group.cwd) : undefined}
              onSpawnAttached={onSpawnSession ? (cwd, changeName) => onSpawnSession(cwd, changeName) : undefined}
            />
          )}

        </div>
        {/* Session + terminal cards — animated collapse */}
        <div className={`group-collapse ${isCollapsed ? "collapsed" : "expanded"}`}>
          {renderSessionCards(group)}
        </div>
      </div>
    );
  }

  /**
   * Render just the session cards for a group — spawn-error banner, placeholder
   * card, active/ended card list, and the ended-toggle row. Shared by
   * {@link renderGroup} (wrapped in folder chrome) and the flat tier render
   * (no folder chrome, when the "Folders" toggle is OFF).
   */
  function renderSessionCards(group: DirectoryGroup) {
    return (
        <div className="space-y-1 pt-1">
          {/* Spawn error banner — see change: spawn-failure-diagnostics */}
          {spawnErrors?.get(group.cwd) && (
            <SpawnErrorBanner
              detail={spawnErrors.get(group.cwd)!}
              onDismiss={onDismissSpawnError ? () => onDismissSpawnError(group.cwd) : undefined}
            />
          )}
          {spawningCwds?.has(group.cwd) && <PlaceholderSessionCard />}
          {(() => {
            // Render pipeline:
            //   1. Start from `group.sessions` (already filtered by `showHidden`).
            //   2. Narrow by global `sessionSearch` if one is typed.
            //   3. Split into active vs ended buckets.
            //   4. Ended bucket is collapsed by default per folder; the
            //      bottom "Show N ended" row toggles. A non-empty
            //      `sessionSearch` AUTO-EXPANDS ended (because the user's
            //      query may match an ended session). The user's explicit
            //      `endedExpanded` set also wins.
            //   5. Pin partition (§7) is applied to whichever buckets are
            //      currently rendered.
            // See change: pin-and-search-sessions §8.
            const matched = sessionSearch.length > 0
              ? filterByQuery(group.sessions, sessionSearch)
              : group.sessions;
            // Flat-merge mode: when session-search is active AND no
            // folder filter is typed, don't apply the active-first sort —
            // ended results stay inline with active so the user sees
            // results in their natural order. The user opted into
            // searching across pinned folders by typing a session query;
            // they don't also want a status-based reshuffling.
            // See change: pin-and-search-sessions.
            const flatMergeMode = sessionSearch.length > 0 && workspaceFilter.length === 0;
            const activeSessions = matched.filter((s) => s.status !== "ended");
            // Ended-tier sort: most-recently-ended first, regardless of
            // sessionOrder (which is alive-only post-prune). Falls back
            // to startedAt for legacy entries without endedAt. See
            // change: top-of-tier-on-status-change.
            const endedSessions = matched
              .filter((s) => s.status === "ended")
              .sort(
                (a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt),
              );
            const showAllEnded = endedExpanded.has(group.cwd) || sessionSearch.length > 0;
            const selectedEndedExternal = endedSessions.find(
              (session) => session.id === selectedId && session.external?.readOnly,
            );
            const visibleEndedSessions = showAllEnded
              ? endedSessions
              : selectedEndedExternal
                ? [selectedEndedExternal]
                : [];
            const showEnded = visibleEndedSessions.length > 0;
            const visibleSessions = flatMergeMode
              ? matched // ended interleaved naturally; sessionOrder still applies below
              : (showEnded
                  ? [...activeSessions, ...visibleEndedSessions]
                  : activeSessions);
            // Empty-state: search query active but nothing matched in
            // this folder. Still rendered inline so the user can clear
            // and recover.
            if (sessionSearch.length > 0 && matched.length === 0) {
              return (
                <div
                  className="text-xs text-[var(--text-muted)] italic px-2 py-2 select-none"
                  data-testid="folder-search-empty"
                >
                  No sessions match your search
                </div>
              );
            }
            const sessionIds = visibleSessions.map((s) => s.id);
            const sessionMap = new Map(visibleSessions.map((s) => [s.id, s]));
            // Honor `sessionOrder` for every id it contains — ended OR
            // alive. The server-side `onChange` hook prunes ended ids
            // from `sessionOrder` when a session naturally transitions
            // to ended, so any ended id that's STILL in the order list
            // got there because the user explicitly dragged it into the
            // alive zone (drag-to-resume). Honoring its position keeps
            // the dropped placement stable through the resume round-trip.
            // See change: pin-and-search-sessions.
            const orderedIds = (sessionOrderMap?.get(group.cwd) ?? sessionIds).filter(
              (id) => sessionIds.includes(id),
            );
            // Tail: ids not in the persisted order. Preserves
            // visibleSessions order, which already has ended at the end.
            const orderedSet = new Set(orderedIds);
            const baseIds = [...orderedIds, ...sessionIds.filter((id) => !orderedSet.has(id))];
            // Stable-partition AFTER the persisted-order base (build-2 P0
            // fix #10 + #3): needs-you (ask_user ∨ unseenServerError) rises to
            // the top of the ALIVE zone; calm-alive and ended keep their
            // incoming relative order (ended stays at the tail — a corpse never
            // rises into the needs band). This refines order WITHIN the folder;
            // pins/folder/tier boundaries above are untouched. No second lane.
            // Applied in SEARCH/flat-merge mode too (build-2 fix-cycle NIT 1):
            // the frozen rank rule is UNQUALIFIED — a filtered list must still
            // surface needs-you first, not revert to persisted order.
            const allIds = stablePartitionByBand(baseIds, sessionMap);
            // Index of the first ended card in the rendered order — used
            // to inject a top "Hide ended" button when ended sessions are
            // currently expanded. Only meaningful in the non-flat layout
            // where active and ended are separated; in flat-merge mode
            // (search across pinned, mixed-status), no inline button.
            const firstEndedIdx = !flatMergeMode && showEnded
              ? allIds.findIndex((id) => sessionMap.get(id)?.status === "ended")
              : -1;
            // The top "Hide ended" button should appear:
            //   - only when ended sessions are expanded
            //   - only when the user manually expanded (not auto-expanded
            //     by a search query — in that mode the user expects
            //     results to stay visible until query is cleared)
            //   - only when at least one ended session exists in render
            const showInlineHideEnded =
              firstEndedIdx >= 0 &&
              endedExpanded.has(group.cwd) &&
              sessionSearch.length === 0 &&
              workspaceFilter.length === 0;
            return (
              <>
                {allIds.map((id, idx) => {
                  const session = sessionMap.get(id);
                  if (!session) return null;
                  const renderTopHideEnded = showInlineHideEnded && idx === firstEndedIdx;
                  return (
                    <React.Fragment key={`f-${id}`}>
                      {renderTopHideEnded && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleEndedExpanded(group.cwd); }}
                          className="w-full text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1 px-2 select-none flex items-center justify-center gap-1 border-t border-[var(--border-subtle)]"
                          data-testid={`folder-ended-toggle-top-${group.cwd}`}
                          aria-label={`Hide ${endedSessions.length} ended sessions`}
                        >
                          <Icon path={mdiChevronDown} size={0.4} />
                          <span>Hide ended</span>
                        </button>
                      )}
                    <React.Fragment key={`f-${id}`}>
                      <SessionCard
                        session={session}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        now={session.external?.readOnly ? Date.now() : now}
                        isHidden={!!session.hidden}
                        onHide={handleHide}
                        onUnhide={handleUnhide}
                        contextUsage={contextUsageMap?.get(session.id)}
                        openspecChanges={openspecMap?.get(session.cwd)?.changes}
                        onRename={onRename}
                        onCheckLiveness={onCheckLiveness}
                        onResume={onResume}
                        hasError={errorSessionIds?.has(session.id)}
                      />
                      {resumeErrors?.get(session.id) && (
                        <div data-testid="resume-error-banner" className="mt-1 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs text-red-300">
                          <span className="flex-1">Resume failed: {resumeErrors.get(session.id)}</span>
                          {onDismissResumeError && (
                            <button
                              data-testid="resume-error-dismiss"
                              onClick={() => onDismissResumeError(session.id)}
                              className="text-red-400 hover:text-red-300 shrink-0"
                            >✕</button>
                          )}
                        </div>
                      )}
                    </React.Fragment>
                    </React.Fragment>
                  );
                })}
              </>
            );
          })()}
          {/* Minimal `Show N ended` expand row at the bottom of the folder.
              Hidden when there are no ended sessions, when the user has
              already expanded them, or when a search query is active
              (search auto-expands ended). Click toggles. */}
          {(() => {
            const matched = sessionSearch.length > 0
              ? filterByQuery(group.sessions, sessionSearch)
              : group.sessions;
            const endedCount = matched.filter((s) => s.status === "ended").length;
            if (endedCount === 0) return null;
            if (sessionSearch.length > 0) return null; // auto-expanded
            const expanded = endedExpanded.has(group.cwd);
            return (
              <button
                onClick={(e) => { e.stopPropagation(); toggleEndedExpanded(group.cwd); }}
                className="w-full text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1 px-2 select-none flex items-center justify-center gap-1"
                data-testid={`folder-ended-toggle-${group.cwd}`}
                aria-label={expanded ? `Hide ${endedCount} ended sessions` : `Show ${endedCount} ended sessions`}
              >
                {/* Bottom toggle: arrow points UP when expanded (collapse-up
                    direction — matches where the click takes the eye) and
                    RIGHT when collapsed (consistent with sidebar folder
                    chevrons). The top "Hide ended" button uses mdiChevronDown
                    deliberately because it sits ABOVE the ended group and
                    pointing down at it would still mean "this collapses what's
                    below me" — inverse direction is intentional. */}
                <Icon path={expanded ? mdiChevronUp : mdiChevronRight} size={0.4} />
                <span>{expanded ? `Hide ended` : `${endedCount} ended`}</span>
              </button>
            );
          })()}
        </div>
    );
  }

  return (
    <div className="w-full border-r border-[var(--border-primary)] flex flex-col min-h-0 h-full">
      <div className="border-b border-[var(--border-primary)]">
        <div className="flex items-center justify-between px-3 py-1.5" data-testid="header-app-bar">
          <div className="flex gap-1.5 items-center">
            <button onClick={() => navigate("/")} className="editorial-accent-ink flex items-center leading-none text-blue-500 hover:text-blue-400 transition-colors" title="Home">
              <PiLogo size={24} />
            </button>
            {skin !== "editorial" && <ThemePicker />}
            <ThemeToggle />
          </div>
          <div className="flex gap-1 items-center">
            <InstallButton canInstall={installPrompt.canInstall} isInstalled={installPrompt.isInstalled} prompt={installPrompt.prompt} />
            <TunnelButton />
            {headerExtra}
            <button
              onClick={() => navigate("/dashboard")}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] p-2"
              title="Dashboard"
              aria-label="Dashboard"
              data-testid="dashboard-btn"
            >
              <Icon path={mdiViewDashboard} size={0.9} />
            </button>
            <button
              onClick={() => navigate("/settings")}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] p-2"
              title="Settings"
              data-testid="settings-btn"
            >
              <Icon path={mdiCog} size={0.9} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 gap-2" data-testid="header-filter-bar">
          <input
            type="search"
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            placeholder="Folder…"
            className="min-w-0 flex-1 px-2 py-1 text-xs rounded bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]"
            data-testid="workspace-filter-input"
            aria-label="Filter folders by path"
          />
          <input
            type="search"
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
            placeholder="Session…"
            className="min-w-0 flex-1 px-2 py-1 text-xs rounded bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)]"
            data-testid="session-search-input"
            aria-label="Search sessions across folders"
          />
          <ToggleButton active={showHidden} onClick={() => setShowHidden((p) => !p)}>
            Hidden
          </ToggleButton>
          <ToggleButton
            active={hideStale}
            onClick={() => {
              setHideStaleState((p) => {
                const next = !p;
                setHideStale(next);
                return next;
              });
            }}
          >
            {`Hide stale (${staleHoursThreshold}h+)`}
          </ToggleButton>
          <ToggleButton
            active={groupByFolder}
            onClick={() => {
              setGroupByFolderState((p) => {
                const next = !p;
                setGroupByFolder(next);
                return next;
              });
            }}
          >
            Folders
          </ToggleButton>
          {onPinDirectory && (
            <button
              onClick={() => onOpenPinDialog?.()}
              className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-secondary)] text-[var(--text-tertiary)] hover:text-yellow-400 hover:border-yellow-500/50 inline-flex items-center gap-1 shrink-0"
              title="Pin a folder to the sidebar"
              data-testid="pin-dir-dialog-btn"
            >
              <Icon path={mdiPin} size={0.45} />
              <span>Folder</span>
            </button>
          )}
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto">
      {filteredSessions.length === 0 && pinnedGroups.length === 0 ? (
        // Loading ≠ empty (build-2 fix-cycle-2 MAJOR 1): the calm "No active
        // sessions" copy is a factual claim that the fleet IS empty — it must
        // NOT show while a load source is unsettled/failed (`hasLoadedOnce ===
        // false`), otherwise a 503 dropped-snapshot or a `{success:false}`
        // surfaces response leaks a false calm-zero. Show a loading line until
        // the oracle settles; `undefined` (back-compat) treats as loaded.
        hasLoadedOnce === false ? (
          <div className="p-4 text-sm text-[var(--text-tertiary)]" data-testid="session-list-loading">Loading sessions…</div>
        ) : (
          <div className="p-4 text-sm text-[var(--text-tertiary)]" data-testid="session-list-empty">No active sessions</div>
        )
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <ul className="flex flex-col gap-2 p-2">
          {/* Pinned directory groups (filtered if workspace/session filter active) */}
          {pinnedGroups.length > 0 && (
            <SortableContext items={pinnedGroups.filter(folderMatchesFilters).map((g) => g.cwd)} strategy={verticalListSortingStrategy}>
              {pinnedGroups.filter(folderMatchesFilters).map((group) => (
                <SortablePinnedGroup key={group.cwd} id={group.cwd}>
                  {renderGroup(group, true)}
                </SortablePinnedGroup>
              ))}
            </SortableContext>
          )}
          {/* Gap between pinned and unpinned is handled by flex gap */}
          {/* Tier sections — each tier renders the unpinned directory groups whose
              sessions classify into that tier. Empty tiers (post-filter) are
              omitted. Tier headers are collapsible; default-expanded for
              standing-crew + cell-executor, default-collapsed for the rest.
              Tier order matches SESSION_TIER_ORDER. */}
          {tierGroups.map(({ tier, sessions: tierSessions, groups }) => {
            // Compute the tier's visible content + header count. Two modes:
            //   • Folders ON  → directory-folder cards (one renderGroup each)
            //   • Folders OFF → a single flat list of session cards (no folder chrome)
            let content: React.ReactNode;
            let count: number;
            if (groupByFolder) {
              const visibleDirGroups = groups.filter((g) =>
                workspaceFilter.length > 0
                  ? folderMatchesFilters(g)
                  : g.sessions.some((s) => s.status !== "ended" || s.external?.readOnly)
              );
              if (visibleDirGroups.length === 0) return null;
              count = visibleDirGroups.length;
              content = (
                <div className="flex flex-col gap-2">
                  {visibleDirGroups.map((group) => renderGroup(group, false))}
                </div>
              );
            } else {
              // Flat mode: `groups` holds exactly one synthetic bucket per tier.
              const flatGroup = groups[0];
              const matched = sessionSearch.length > 0
                ? filterByQuery(tierSessions, sessionSearch)
                : tierSessions;
              const aliveCount = tierSessions.filter((s) => s.status !== "ended").length;
              const hasExternal = tierSessions.some((s) => s.external?.readOnly);
              const hasVisible = sessionSearch.length > 0 ? matched.length > 0 : aliveCount > 0 || hasExternal;
              if (!flatGroup || !hasVisible) return null;
              count = sessionSearch.length > 0 ? matched.length : aliveCount;
              content = (
                <div className="bg-[var(--bg-secondary)] rounded-lg p-2">
                  {renderSessionCards(flatGroup)}
                </div>
              );
            }
            const filterActive = workspaceFilter.length > 0 || sessionSearch.length > 0;
            // Auto-expand when only a single tier is present — collapsing the
            // only tier would hide all sidebar content, which is confusing
            // when the operator has a small mesh (e.g. a single TUI session).
            const isOnlyTier = tierGroups.length === 1;
            const tierCollapsed = filterActive || isOnlyTier
              ? false
              : isTierCollapsedDefault(tier, collapsedGroups);
            return (
              <div key={`tier-${tier}`} className="flex flex-col gap-2" data-testid={`tier-section-${tier}`}>
                <button
                  onClick={() => handleToggleTierCollapse(tier)}
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] hover:text-[var(--text-primary)] select-none"
                  aria-expanded={!tierCollapsed}
                  data-testid={`tier-header-${tier}`}
                >
                  <span className="inline-flex text-[var(--text-tertiary)]">
                    <Icon path={tierCollapsed ? mdiChevronRight : mdiChevronDown} size={0.55} />
                  </span>
                  <span className="inline-flex text-[var(--text-tertiary)]">
                    <Icon path={TIER_ICON[tier]} size={0.55} />
                  </span>
                  <span className="editorial-heading">{TIER_LABEL[tier]}</span>
                  <span className="text-[10px] font-normal text-[var(--text-muted)] normal-case tracking-normal">
                    ({count})
                  </span>
                </button>
                {!tierCollapsed && content}
              </div>
            );
          })}
        </ul>
        </DndContext>
      )}
      {hiddenCount > 0 && !showHidden && (
        <div className="p-2 text-center text-[11px] text-[var(--text-muted)]">
          {hiddenCount} hidden
        </div>
      )}
      {branchDialogCwd && (
        <BranchSwitchDialog
          cwd={branchDialogCwd}
          onClose={() => {
            branchCache.delete(branchDialogCwd);
            setBranchDialogCwd(null);
          }}
        />
      )}
      <Toast messages={messages} onDismiss={dismissToast} />

      </div>
    </div>
  );
}
