import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRoute, useLocation, Redirect, Switch, Route } from "wouter";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useSidebarState } from "./hooks/useSidebarState.js";
import { SessionList } from "./components/SessionList.js";
import { FleetBriefBanner } from "./components/FleetBriefBanner.js";
import { ResizableSidebar } from "./components/ResizableSidebar.js";
import { DashboardPage } from "./components/DashboardPage.js";
import { HamburgerButton, MobileOverlay } from "./components/MobileOverlay.js";
import { MobileShell } from "./components/MobileShell.js";
import { useMobile } from "./hooks/useMobile.js";
import { getMobileDepth } from "./lib/mobile-depth.js";
import { resendAllRenderedAcks } from "./lib/prompt-rendered-ack.js";
import { getSessionDisplayName } from "./lib/session-display-name.js";
import { ChatView, type ChatViewHandle } from "./components/ChatView.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import {
  FlowDashboard,
  FlowAgentDetail,
  FlowArchitect,
  FlowArchitectDetail,
} from "@blackbelt-technology/pi-dashboard-flows-plugin/client";
import { MarkdownPreviewView } from "./components/MarkdownPreviewView.js";
import { PiResourcesView } from "./components/PiResourcesView.js";
import { SpecsBrowserView } from "./components/SpecsBrowserView.js";
import { ArchiveBrowserView } from "./components/ArchiveBrowserView.js";
import { useOpenSpecReader } from "./hooks/useOpenSpecReader.js";
import type { OpenSpecArtifact } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { ModelReasoningSheet } from "./components/ModelReasoningSheet.js";import { ServerSelector } from "./components/ServerSelector.js";
import { Toast, useToast } from "./components/Toast.js";
import { ConnectionStatusBanner } from "./components/ConnectionStatusBanner.js";
import { performServerSwitch } from "./lib/server-switch.js";
import { openStagingSocket } from "./lib/staging-socket.js";
import { PiUpdateBadge } from "./components/PiUpdateBadge.js";
import { TokenStatsBar } from "./components/TokenStatsBar.js";

import { CommandInput } from "./components/CommandInput.js";
import { readAllDrafts, writeDraft, deleteDraft } from "./lib/draft-storage.js";
import { resizeImagesForSend } from "./lib/image-resize.js";
import { getSendFullResolution } from "./hooks/useSendFullResolution.js";
import { extractUserPromptHistory } from "./lib/message-history.js";
import type { AudienceSessionCtx } from "./lib/message-filter-classifier.js";
import { deriveHistoricalEvidence } from "./lib/message-filter-classifier.js";
import { StatusBar } from "./components/StatusBar.js";
import { LandingPage } from "./components/LandingPage.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { ZrokInstallGuide } from "./components/ZrokInstallGuide.js";
import { InstallBanner } from "./components/InstallBanner.js";
import { UpdatePrompt } from "./components/UpdatePrompt.js";
import { BootstrapBanner } from "./components/BootstrapBanner.js";
import { PendingInputBanner } from "./components/PendingInputBanner.js";
import { useBootstrapStatus } from "./hooks/useBootstrapStatus.js";
import { useInstallPrompt } from "./hooks/useInstallPrompt.js";
import { useSessionsBootstrap } from "./hooks/useSessionsBootstrap.js";
import { useFleetBrief } from "./hooks/useFleetBrief.js";
import { deriveHasLoadedOnce } from "./lib/has-loaded-once.js";
import { countAlive } from "./lib/card-state.js";
import { TerminalsView } from "./components/TerminalsView.js";
import { EditorView } from "./components/EditorView.js";
import { decodeFolderPath, encodeFolderPath } from "./lib/folder-encoding.js";
import { FileDiffView } from "./components/FileDiffView.js";
import { createInitialState, findLastUserPrompt, reduceEvent, resolveInteractiveRequest, markQueueEntryFailed, type SessionState } from "./lib/event-reducer.js";
import { useMessageHandler } from "./hooks/useMessageHandler.js";
import { useEditors } from "./lib/use-editors.js";
import { useContentViews } from "./hooks/useContentViews.js";
import { useDesktopBack } from "./hooks/useDesktopBack.js";
import { useViewDispatcher } from "./hooks/useViewDispatcher.js";
import { selectViewedSessionId } from "./lib/selectViewedSessionId.js";
import { useSessionActions } from "./hooks/useSessionActions.js";
import { usePendingPromptTimeout } from "./hooks/usePendingPromptTimeout.js";
import { useQueueStuckTimeout } from "./hooks/useQueueStuckTimeout.js";
import { useOpenSpecActions } from "./hooks/useOpenSpecActions.js";
import type { DashboardSession, CommandInfo, FlowInfo, FileEntry, OpenSpecData, OpenSpecGroup, ModelInfo, RoleInfo, ImageContent, ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { SearchableSelectDialog, type SelectOption } from "./components/SearchableSelectDialog.js";
import { FlowLaunchDialog } from "@blackbelt-technology/pi-dashboard-flows-plugin/client";
import { GenericExtensionDialog } from "./components/extension-ui/GenericExtensionDialog.js";
import { ToastSlot } from "./components/extension-ui/ToastSlot.js";
import { PinDirectoryDialog } from "./components/PinDirectoryDialog.js";
import { WorktreeSpawnDialog } from "./components/WorktreeSpawnDialog.js";
import { DialogPortal } from "./components/DialogPortal.js";
import { useProvidersReady } from "./hooks/useProvidersReady.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import type { EditorInstanceStatus } from "@blackbelt-technology/pi-dashboard-shared/editor-types.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { ServerToBrowserMessage, PendingOperatorInput } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { ToolContext } from "./components/tool-renderers/index.js";
import type { ContextUsageInfo } from "./components/SessionList.js";
import { ApiContext, deriveApiBase, VITE_API_URL, setGlobalApiBase, getApiBase } from "./lib/api-context.js";
import { SessionAssetsProvider } from "./lib/SessionAssetsContext.js";
import { PluginContextProvider, applyPluginConfigUpdate } from "@blackbelt-technology/dashboard-plugin-runtime/context";
import {
  ContentViewSlot,
  ContentHeaderStickySlot,
  ContentInlineFooterSlot,
} from "@blackbelt-technology/dashboard-plugin-runtime";
import { createSlotRegistry } from "@blackbelt-technology/dashboard-plugin-runtime";
import { PLUGIN_REGISTRY } from "./generated/plugin-registry.js";

// Populate the slot registry from the build-time generated plugin manifest.
// PLUGIN_REGISTRY is `[]` on a fresh checkout (committed stub) — slot consumers
// then render zero contributions, which is fine. The vite plugin overwrites the
// generated file on dev start and on every build.
const _pluginRegistry = createSlotRegistry();
for (const entry of PLUGIN_REGISTRY) {
  for (const claim of entry.claims) {
    _pluginRegistry.addClaim(claim);
  }
}

const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsPort = window.location.port ? `:${window.location.port}` : "";
const DEFAULT_WS_URL = `${wsProtocol}//${window.location.hostname}${wsPort}/ws`;
const LAST_SERVER_KEY = "pi-dashboard-last-server";
// Stable empty-array reference for sessions with no pending images.
// Frozen so accidental mutation throws in strict mode.
const EMPTY_IMAGES: readonly ImageContent[] = Object.freeze([]);

function getInitialWsUrl(): string {
  const saved = localStorage.getItem(LAST_SERVER_KEY);
  if (saved) {
    try {
      const [host, port] = saved.split(":");
      if (host && port) {
        return `${wsProtocol}//${host}:${port}/ws`;
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_WS_URL;
}



function OpenSpecPreview({
  cwd,
  changeName,
  initialArtifact,
  artifacts,
  onBack,
}: {
  cwd: string;
  changeName: string;
  initialArtifact: string;
  artifacts: OpenSpecArtifact[];
  onBack: () => void;
}) {
  const reader = useOpenSpecReader(cwd, changeName, initialArtifact, artifacts);
  return (
    <MarkdownPreviewView
      title={reader.title}
      content={reader.content}
      isLoading={reader.isLoading}
      error={reader.error}
      tabs={reader.tabs}
      activeTab={reader.activeTab}
      onTabChange={reader.setActiveTab}
      onBack={onBack}
    />
  );
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(getInitialWsUrl);
  const { send, onMessage, status } = useWebSocket(wsUrl);
  const { messages: toastMessages, showToast, dismissToast } = useToast();
  const apiBase = useMemo(() => {
    const base = deriveApiBase(wsUrl) || VITE_API_URL;
    setGlobalApiBase(base);
    return base;
  }, [wsUrl]);
  const [, navigate] = useLocation();
  const [match, params] = useRoute("/session/:id");
  // Legacy /terminal/:id route removed — see change:
  // fix-terminal-half-height-dual-mount. Terminals are reached via
  // /folder/:encodedCwd/terminals. The dual-mount it caused (one
  // <TerminalView> here + one inside <TerminalsView>) was the root
  // cause of half-height rendering and competing FitAddon resizes.
  const [folderTermMatch, folderTermParams] = useRoute("/folder/:encodedCwd/terminals");
  const [folderEditorMatch, folderEditorParams] = useRoute("/folder/:encodedCwd/editor");
  const [settingsMatch] = useRoute("/settings");
  const [tunnelSetupMatch] = useRoute("/tunnel-setup");
  /* /dashboard route — Active Operator Surfaces split out of the
   * session-list sidebar per operator ratification 2026-05-26 ~00:40
   * CEST (defaults 1a + 2a + 3a). Sister-shape to settings/tunnel-setup
   * top-level routes: gates the desktop content area, drives mobile
   * depth=1, and propagates through useContentViews / useOpenSpecActions
   * so content-view overlays close it before opening. */
  const [dashboardMatch] = useRoute("/dashboard");
  const selectedId = match ? params?.id : undefined;
  const selectedSessionIdRef = useRef<string | undefined>(selectedId);
  selectedSessionIdRef.current = selectedId;

  // Drives the server-side viewed-session tracker for unread state.
  // See change: session-card-unread-stripes.
  useViewDispatcher({
    viewedSessionId: selectViewedSessionId(match, params ?? undefined),
    connectionStatus: status,
    send,
  });
  const folderTermCwd = folderTermMatch ? decodeFolderPath(folderTermParams?.encodedCwd ?? "") : null;
  const folderEditorCwd = folderEditorMatch ? decodeFolderPath(folderEditorParams?.encodedCwd ?? "") : null;
  const sidebar = useSidebarState();
  const chatViewRef = useRef<ChatViewHandle>(null);
  const isMobile = useMobile();
  const installPrompt = useInstallPrompt();
  const bootstrapStatus = useBootstrapStatus();
  const [mobileOpen, setMobileOpen] = useState(false);
  /* Feature 2 (message-type filter; cell
   * pi-agent-dashboard-ux-message-discoverability/v1 W4.2.1 wiring fix per
   * Pete tenure-2 W9 strict-spec QA T2 BLOCK 2026-05-23): App-owned toggle
   * state for MessageFilterControls visibility. Wired into SessionHeader
   * (onFilterToggle/isFilterActive) and ChatView (showFilterControls/
   * onCloseFilterControls) below. Sister-shape to chatViewRef-based search
   * toggle wiring — both are W4.x discoverability features. */
  const [showMessageFilterControls, setShowMessageFilterControls] = useState(false);
  const [sessions, setSessions] = useState<Map<string, DashboardSession>>(new Map());
  // Cold-load success oracle sources (build-2 P0 fix #7). `hasLoadedOnce` is
  // ONE derived boolean (no FSM): the calm-zero empty state must never show
  // until BOTH the session source (REST-success-incl-[] OR snapshot) AND the
  // surfaces source have settled successfully. A failure of either keeps the
  // failure/last-known surface up instead of a lying "no sessions".
  const [restSessionsOutcome, setRestSessionsOutcome] = useState<"pending" | "success" | "failure">("pending");
  const [snapshotReceived, setSnapshotReceived] = useState(false);
  // Cold-load HTTP bootstrap — populates sessions immediately, before
  // WebSocket sessions_snapshot arrives. Closes Cluster A n=6 cold-load
  // empirical cluster (cell dashboard-pwa-cold-load-fix/v1 deliverable c).
  useSessionsBootstrap({ setSessions, wsStatus: status, onRestSettled: setRestSessionsOutcome });
  const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(new Map());
  // Surface B: per-session distinct co-driver presence set (multi-operator).
  // Empty/≤1 participant → no presence-of-two chrome (single-op byte-unchanged).
  const [presenceMap, setPresenceMap] = useState<Map<string, import("@blackbelt-technology/pi-dashboard-shared/types.js").PresenceParticipant[]>>(new Map());
  // Per-session chat-input drafts. Hydrated once from localStorage on mount,
  // then persisted (debounced) whenever the map changes.
  const [drafts, setDrafts] = useState<Map<string, string>>(() => readAllDrafts());
  // Track the previous drafts snapshot so the persist effect can compute a
  // precise write-set (added/changed keys) and delete-set (removed/emptied keys).
  const prevDraftsRef = useRef<Map<string, string>>(drafts);
  // Per-session pending pasted-image attachments. Lifted out of
  // useImagePaste's local useState into App so they survive the
  // unmount/remount of <CommandInput> caused by content-area route
  // changes (Settings, terminals, OpenSpec preview, …) and so they
  // do NOT leak across session switches. NOT persisted to
  // localStorage — base64 blobs are large and per-reload reset is
  // acceptable (see openspec/specs/chat-input-state).
  const [pendingImagesMap, setPendingImagesMap] = useState<Map<string, ImageContent[]>>(new Map());
  const [sessionCommands, setSessionCommands] = useState<Map<string, CommandInfo[]>>(new Map());
  const [sessionFlows, setSessionFlows] = useState<Map<string, FlowInfo[]>>(new Map());
  const [fileResults, setFileResults] = useState<{ query: string; files: FileEntry[] } | null>(null);
  const [openspecMap, setOpenspecMap] = useState<Map<string, OpenSpecData>>(new Map());
  const [openspecGroupsMap, setOpenspecGroupsMap] = useState<Map<string, { groups: OpenSpecGroup[]; assignments: Record<string, string> }>>(new Map());
  const [modelsMap, setModelsMap] = useState<Map<string, ModelInfo[]>>(new Map());
  const [rolesMap, setRolesMap] = useState<Map<string, RoleInfo>>(new Map());
  const [spawnResult, setSpawnResult] = useState<{ success: boolean; message: string } | null>(null);
  const [spawnErrors, setSpawnErrors] = useState<Map<string, import("./hooks/useMessageHandler.js").SpawnErrorDetail>>(new Map());
  const [resumeErrors, setResumeErrors] = useState<Map<string, string>>(new Map());
  const [spawningCwds, setSpawningCwds] = useState<Set<string>>(new Set());
  const spawningCwdsRef = useRef<Set<string>>(spawningCwds);
  spawningCwdsRef.current = spawningCwds;
  const spawnTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Maps client-minted requestId → cwd, used to correlate session_added
  // back to the originating click for auto-select after spawn AND fork.
  // Lives alongside `spawningCwds` (which keeps placeholder + disabled-button
  // behavior cwd-keyed). See change: spawn-correlation-token.
  const pendingSpawnsRef = useRef<Map<string, { cwd: string; kind: "spawn" | "resume" }>>(new Map());
  const [sessionOrderMap, setSessionOrderMap] = useState<Map<string, string[]>>(new Map());
  const [pinnedDirectories, setPinnedDirectories] = useState<string[]>([]);
  // Cross-session operator-input pointers (NOS cross-session-askuser-surface). Off by default server-side.
  const [pendingOperatorInputs, setPendingOperatorInputs] = useState<PendingOperatorInput[]>([]);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [worktreeSpawnCwd, setWorktreeSpawnCwd] = useState<string | null>(null);
  const providersReady = useProvidersReady();
  const [terminals, setTerminals] = useState<Map<string, TerminalSession>>(new Map());
  const pendingTerminalCwdRef = useRef<string | null>(null);
  const lastCreatedTerminalIdRef = useRef<string | null>(null);
  const [editorStatuses, setEditorStatuses] = useState<Map<string, { id: string; status: EditorInstanceStatus }>>(new Map());
  const [editorAvailable, setEditorAvailable] = useState<boolean | undefined>(undefined);
  const [discoveredServers, setDiscoveredServers] = useState<import("./components/ServerSelector.js").DiscoveredServerInfo[]>([]);
  const subscribedRef = useRef(new Set<string>());
  const maxSeqMapRef = useRef(new Map<string, number>());
  const [flowDetailAgent, setFlowDetailAgent] = useState<string | null>(null);
  const [architectDetailOpen, setArchitectDetailOpen] = useState(false);
  const [previewState, setPreviewState] = useState<{
    cwd: string;
    changeName: string;
    artifactId: string;
    artifacts: OpenSpecArtifact[];
  } | null>(null);
  const [specsBrowserCwd, setSpecsBrowserCwd] = useState<string | null>(null);
  const [archiveBrowserCwd, setArchiveBrowserCwd] = useState<string | null>(null);
  const [diffViewSessionId, setDiffViewSessionId] = useState<string | null>(null);
  const [flowYamlPreview, setFlowYamlPreview] = useState<{ content: string; title: string } | null>(null);
  const [sourceOpenAgent, setSourceOpenAgent] = useState<string | null>(null);

  // Clear all App-level content view states (everything except useContentViews-owned states)
  const clearAppContentViews = useCallback(() => {
    setPreviewState(null);
    setSpecsBrowserCwd(null);
    setArchiveBrowserCwd(null);
    setDiffViewSessionId(null);
    setFlowYamlPreview(null);
    setSourceOpenAgent(null);
    setFlowDetailAgent(null);
    setArchitectDetailOpen(false);
  }, []);

  const {
    piResourcesState, setPiResourcesState,
    piResourceFilePreview, setPiResourceFilePreview,
    readmePreview, setReadmePreview,
    clearAll: clearContentViews,
    handleOpenPiResources,
    handleViewPiResourceFile,
    handleViewReadme,
  } = useContentViews({
    onBeforeOpen: clearAppContentViews,
    navigate,
    settingsMatch: !!settingsMatch,
    tunnelSetupMatch: !!tunnelSetupMatch,
    dashboardMatch: !!dashboardMatch,
  });

  /** Clear every content view — App-level + useContentViews-owned. */
  const clearAllContentViews = useCallback(() => {
    clearAppContentViews();
    clearContentViews();
  }, [clearAppContentViews, clearContentViews]);

  // Transactional server switching — see openspec/changes/safe-server-switch.
  // Opens a staging WebSocket first; only commits state/localStorage after
  // it reaches OPEN. On failure, live connection is preserved intact.
  const inFlightSwitchKeyRef = useRef<string | null>(null);
  const [inFlightSwitchKey, setInFlightSwitchKey] = useState<string | null>(null);
  const handleServerSwitch = useCallback((host: string, port: number) => {
    const key = `${host}:${port}`;
    if (inFlightSwitchKeyRef.current) return; // ignore duplicate clicks
    inFlightSwitchKeyRef.current = key;
    setInFlightSwitchKey(key);
    const wsProto = wsProtocol === "wss:" ? "wss:" : "ws:";
    performServerSwitch(
      { host, port, wsProtocol: wsProto },
      {
        openStagingSocket,
        clearInMemoryState: () => {
          setSessions(new Map());
          setSessionStates(new Map());
          setSessionCommands(new Map());
          setSessionFlows(new Map());
          setOpenspecMap(new Map());
          setOpenspecGroupsMap(new Map());
          setTerminals(new Map());
          subscribedRef.current.clear();
        },
        setWsUrl,
        persistLastServer: (h, p) => {
          localStorage.setItem(LAST_SERVER_KEY, `${h}:${p}`);
        },
        notifyError: (msg) => showToast(msg),
      },
    ).finally(() => {
      inFlightSwitchKeyRef.current = null;
      setInFlightSwitchKey(null);
    });
  }, []);

  // Parse current server host/port from wsUrl
  const currentServerHost = useMemo(() => {
    try {
      const u = new URL(wsUrl.replace("ws://", "http://").replace("wss://", "https://"));
      return u.hostname;
    } catch { return "localhost"; }
  }, [wsUrl]);
  const currentServerPort = useMemo(() => {
    try {
      const u = new URL(wsUrl.replace("ws://", "http://").replace("wss://", "https://"));
      return parseInt(u.port, 10) || 8000;
    } catch { return 8000; }
  }, [wsUrl]);

  const clearSpawningCwd = useCallback((cwd: string) => {
    setSpawningCwds((prev) => {
      if (!prev.has(cwd)) return prev;
      const next = new Set(prev);
      next.delete(cwd);
      return next;
    });
    const timer = spawnTimeoutsRef.current.get(cwd);
    if (timer) {
      clearTimeout(timer);
      spawnTimeoutsRef.current.delete(cwd);
    }
  }, []);

  const handleMessage = useMessageHandler(
    { setSessions, setSessionStates, setSessionCommands, setSessionFlows, setFileResults, setOpenspecMap, setOpenspecGroupsMap, setModelsMap, setRolesMap, setSpawnResult, setSessionOrderMap, setPinnedDirectories, setTerminals, setEditorStatuses, setDiscoveredServers, setSpawnErrors, setResumeErrors, setPresenceMap, setPendingOperatorInputs, onSnapshotReceived: () => setSnapshotReceived(true) },
    { send, navigate, clearSpawningCwd, spawningCwdsRef, subscribedRef, pendingTerminalCwdRef, lastCreatedTerminalIdRef, maxSeqMapRef, selectedSessionIdRef, pendingSpawnsRef },
  );

  useEffect(() => {
    return onMessage(handleMessage);
  }, [onMessage, handleMessage]);

  // Detect code-server binary availability on mount
  useEffect(() => {
    fetch(`${apiBase}/api/editor/detect`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setEditorAvailable(d.data.available); })
      .catch(() => {});
  }, []);

  // Clear subscriptions on reconnect so sessions get re-subscribed
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (status === "connected" && prevStatusRef.current !== "connected") {
      // NOTE (build-2 fix-cycle MAJOR 1): `snapshotReceived` is NOT set here.
      // Socket-OPEN is not proof the authoritative `sessions_snapshot` FRAME
      // arrived — a connected socket that drops the snapshot would otherwise
      // authorize a false calm-zero. The flag is set in the `sessions_snapshot`
      // message handler (useMessageHandler) on the real frame.
      subscribedRef.current.clear();
      // A1 render-ACK resend-on-reconnect (Pete dl-r4 C1-v2): the interactive
      // dialog cards stay MOUNTED across a WS reconnect (addInteractiveRequest
      // dedups the replay → same state → no remount), and `useWebSocket.send`
      // silently drops a send while the socket is down. So a first ACK that
      // dropped during the outage is re-sent HERE for every still-mounted
      // pending prompt. Server `markRendered` is idempotent → safe.
      resendAllRenderedAcks();
      // sessionOrderMap is replaced atomically by the on-connect
      // `sessions_snapshot` message — no pre-reset needed.
      // See change: fix-stale-sessions-on-reconnect.
      setTerminals(new Map());
      // Fetch current editor statuses
      fetch(`${apiBase}/api/editor/status`)
        .then((r) => r.json())
        .then((data) => {
          if (data.success && Array.isArray(data.data)) {
            const map = new Map<string, { id: string; status: EditorInstanceStatus }>();
            for (const inst of data.data) {
              if (inst.status !== "stopped") {
                map.set(inst.cwd, { id: inst.id, status: inst.status });
              }
            }
            setEditorStatuses(map);
          }
        })
        .catch(() => {});
    }
    prevStatusRef.current = status;
  }, [status]);

  // Redirect to / if session ID in URL is not found after sessions have loaded
  const sessionsLoaded = sessions.size > 0;
  useEffect(() => {
    if (selectedId && sessionsLoaded && !sessions.has(selectedId)) {
      navigate("/", { replace: true });
    }
  }, [selectedId, sessionsLoaded, sessions, navigate]);

  // Clear preview when session changes + lazy subscribe ended sessions
  const prevSelectedRef = useRef(selectedId);
  useEffect(() => {
    if (selectedId !== prevSelectedRef.current) {
      clearAllContentViews();
      prevSelectedRef.current = selectedId;
    }
    // Lazy subscribe: load events for ended sessions when first selected.
    // Also re-subscribes the selected session after reconnect (status change
    // clears subscribedRef, and adding `status` here re-triggers the effect).
    if (selectedId && !subscribedRef.current.has(selectedId) && status === "connected") {
      subscribedRef.current.add(selectedId);
      // Reset replay readiness on subscribe (build-2 fix-cycle MAJOR 2): the
      // session re-enters LOADING until the terminal `event_replay{isLast:true}`
      // arrives, so ChatView never flashes "No messages yet" before replay
      // completes. A brand-new state is already loading (replayComplete
      // undefined); this covers a re-subscribe of an already-viewed session.
      setSessionStates((prev) => {
        const existing = prev.get(selectedId);
        if (!existing || existing.replayComplete === undefined || existing.replayComplete === false) return prev;
        const next = new Map(prev);
        next.set(selectedId, { ...existing, replayComplete: false });
        return next;
      });
      send({ type: "subscribe", sessionId: selectedId, lastSeq: maxSeqMapRef.current.get(selectedId) ?? 0 });
      // Request model list for this session if we don't have it yet (e.g. after page refresh)
      if (!modelsMap.has(selectedId)) {
        send({ type: "request_models", sessionId: selectedId });
      }
    }
  }, [selectedId, send, status]);

  const selectedState = selectedId
    ? sessionStates.get(selectedId) ?? createInitialState()
    : createInitialState();


  // Per-session draft text + history recall for CommandInput.
  const selectedDraft = selectedId ? (drafts.get(selectedId) ?? "") : "";
  // Per-session pending images. Returns the stable EMPTY_IMAGES ref
  // when the session has no entry, so unrelated re-renders don't
  // produce a fresh `[]` and re-render <CommandInput>.
  const selectedImages = (selectedId ? pendingImagesMap.get(selectedId) : undefined) ?? (EMPTY_IMAGES as ImageContent[]);
  const selectedHistory = useMemo(
    () => extractUserPromptHistory(selectedState.messages),
    [selectedState.messages],
  );

  // Debounced persistence for drafts. When the map changes, diff against the
  // previous snapshot and flush writes/deletes after a short idle window so we
  // don't hammer localStorage on every keystroke.
  useEffect(() => {
    const prev = prevDraftsRef.current;
    const timer = setTimeout(() => {
      // Writes: new or changed entries.
      for (const [sid, text] of drafts) {
        if (text === "") {
          // Empty string in the map = cleared draft, treat as delete.
          if (prev.get(sid) !== undefined) deleteDraft(sid);
          continue;
        }
        if (prev.get(sid) !== text) writeDraft(sid, text);
      }
      // Deletes: keys present before but gone now.
      for (const sid of prev.keys()) {
        if (!drafts.has(sid)) deleteDraft(sid);
      }
      prevDraftsRef.current = drafts;
    }, 300);
    return () => clearTimeout(timer);
  }, [drafts]);

  const setDraftForSelected = useCallback(
    (text: string) => {
      if (!selectedId) return;
      setDrafts((m) => {
        const existing = m.get(selectedId) ?? "";
        if (existing === text) return m;
        const next = new Map(m);
        next.set(selectedId, text);
        return next;
      });
    },
    [selectedId],
  );

  const clearDraftForSession = useCallback((sid: string) => {
    setDrafts((m) => {
      if (!m.has(sid)) return m;
      const next = new Map(m);
      next.delete(sid);
      return next;
    });
    // Also clear from localStorage eagerly so a reload before the debounce
    // window fires doesn't resurrect the cleared draft.
    deleteDraft(sid);
  }, []);

  // Per-session pending-image setter. Mutates pendingImagesMap for the
  // currently selected session. Deletes the entry when `next` is empty
  // so the map doesn't accumulate empty arrays.
  const setImagesForSelected = useCallback((next: ImageContent[]) => {
    if (!selectedId) return;
    setPendingImagesMap((m) => {
      const existing = m.get(selectedId);
      if (next.length === 0) {
        if (!m.has(selectedId)) return m;
        const out = new Map(m);
        out.delete(selectedId);
        return out;
      }
      if (existing === next) return m;
      const out = new Map(m);
      out.set(selectedId, next);
      return out;
    });
  }, [selectedId]);

  // Clear pending images for a specific session (used after a successful send).
  const clearImagesForSession = useCallback((sid: string) => {
    setPendingImagesMap((m) => {
      if (!m.has(sid)) return m;
      const next = new Map(m);
      next.delete(sid);
      return next;
    });
  }, []);

  // Safety timeout: clear stuck pendingPrompt after 30s and show error
  usePendingPromptTimeout(!!selectedState.pendingPrompt, useCallback(() => {
    if (selectedId) {
      setSessionStates((prev) => {
        const next = new Map(prev);
        const current = next.get(selectedId);
        if (current?.pendingPrompt) {
          next.set(selectedId, {
            ...current,
            pendingPrompt: undefined,
            lastError: {
              message: "No response from session — the prompt may not have been received.",
              timestamp: Date.now(),
            },
          });
        }
        return next;
      });
    }
  }, [selectedId, setSessionStates]));

  // Message-queue (dashboard-message-queue/v1): per-entry stuck-timeout.
  // Flip any `optimistic` queued entry the bridge never confirms within 30s to
  // a visible `failed` state ("failed — tap to retry"). Makes loss VISIBLE,
  // never silent. See change: dashboard-message-queue.
  const optimisticQueueEntries = useMemo(
    () =>
      selectedState.queue
        .filter((q) => q.state === "optimistic")
        .map((q) => ({ queueNonce: q.queueNonce, createdAt: q.createdAt })),
    [selectedState.queue],
  );
  useQueueStuckTimeout(
    optimisticQueueEntries,
    status === "connected",
    useCallback((queueNonce: string) => {
      if (!selectedId) return;
      setSessionStates((prev) => {
        const current = prev.get(selectedId);
        if (!current) return prev;
        const next = new Map(prev);
        next.set(selectedId, markQueueEntryFailed(current, queueNonce));
        return next;
      });
    }, [selectedId, setSessionStates]),
  );

  const selectedCommands = selectedId
    ? sessionCommands.get(selectedId) ?? []
    : [];

  const selectedFlows = selectedId
    ? sessionFlows.get(selectedId) ?? []
    : [];

  const selectedSession = selectedId ? sessions.get(selectedId) : undefined;
  // Operator-addressed audience context for the selected session (coverage-
  // contract #1 — the shared operator-addressed classifier). B2: derive the
  // PERSISTED-AT-THE-TIME positive evidence (sessionFile / cwd / source) once
  // per session — NOT `classifyTier` (which reads today's registry + the
  // standing-crew NAME regex; that leak let today's registry decide a pre-stamp
  // row's audience). The classifier's retrospective heuristic reads ONLY this
  // evidence; absent evidence → unknown (shown + exempt). The authoritative
  // signal remains the emit-stamp on ChatMessage.audience (B3). Threaded into
  // ChatView → filterMessages / countMessagesByCategory. No session → undefined.
  const sessionCtx = useMemo<AudienceSessionCtx | undefined>(
    () => (selectedSession ? { evidence: deriveHistoricalEvidence(selectedSession) } : undefined),
    [selectedSession],
  );
  const selectedCwd = selectedSession?.cwd;

  // Mobile model/reasoning sheet (parity MVP — surfaces the desktop-only
  // StatusBar controls on touch). Open-state lives here so the sheet can read
  // the same selectedState/modelsMap the desktop StatusBar uses.
  const [modelSheetOpen, setModelSheetOpen] = useState(false);

  // Shared model/thinking/bell handlers — used by BOTH the desktop StatusBar
  // and the mobile sheet (DRY; the message shapes were previously inline-only
  // in the StatusBar JSX). selectedId is captured per-render; the gates that
  // render these are inside the `selectedId ?` scope so it's always defined.
  const handleSelectModel = useCallback((modelStr: string) => {
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx > 0) {
      const provider = modelStr.slice(0, slashIdx);
      const modelId = modelStr.slice(slashIdx + 1);
      send({ type: "set_model", sessionId: selectedId, provider, modelId });
    }
  }, [send, selectedId]);

  const handleSelectThinkingLevel = useCallback((level: string) => {
    send({ type: "set_thinking_level", sessionId: selectedId, level });
  }, [send, selectedId]);

  const handleCycleBell = useCallback(() => {
    const states = ["off", "on", "auto"] as const;
    const current = selectedSession?.pushPrefs?.notifyCompletion ?? "off";
    const nextIdx = (states.indexOf(current) + 1) % states.length;
    send({ type: "set_push_prefs", sessionId: selectedId, prefs: { notifyCompletion: states[nextIdx] } });
  }, [send, selectedId, selectedSession?.pushPrefs?.notifyCompletion]);

  const editorCwds = useMemo(() => selectedCwd ? [selectedCwd] : [], [selectedCwd]);
  const editorMap = useEditors(editorCwds);
  const toolContext: ToolContext = useMemo(() => ({
    cwd: selectedCwd,
    editors: selectedCwd ? editorMap.get(selectedCwd) ?? [] : [],
  }), [selectedCwd, editorMap]);

  const contextUsageMap = useMemo(() => {
    const map = new Map<string, ContextUsageInfo>();
    // First: populate from event-reduced state (live sessions)
    for (const [id, state] of sessionStates) {
      if (state.contextUsage) {
        map.set(id, state.contextUsage);
      }
    }
    // Second: fill in from server-persisted session data (covers all sessions)
    for (const [id, session] of sessions) {
      if (!map.has(id) && session.contextWindow && session.contextTokens !== undefined) {
        map.set(id, { tokens: session.contextTokens ?? null, contextWindow: session.contextWindow });
      }
    }
    return map;
  }, [sessionStates, sessions]);

  const sessionActions = useSessionActions({
    selectedId, send, navigate, setMobileOpen,
    setSessions, setSessionStates, setSpawningCwds, setTerminals,
    clearSpawningCwd, spawnTimeoutsRef, pendingTerminalCwdRef, terminals,
    pendingSpawnsRef,
  });
  const {
    handleAbort, handleForceKill, handleCancelPending, handleRespondToUi, handleRenderedAck, handleFlowAction, handleSend,
    handleSelect, handleRenameSession, handleKillProcess,
    handleSendPromptToSession, handleResumeSession, handleResumeSessionKeepPosition, handleSpawnSession,
    handleHideSession, handleUnhideSession,
    handleCreateTerminal, handleKillTerminal, handleRenameTerminal, handleTerminalTitle,
    handleListFiles,
    handleRetryQueued, handleDismissQueued,
  } = sessionActions;

  // Read-only dark-card liveness re-check (build-2 P0 fix #4). Replaces the
  // removed destructive Exit control. GET /api/sessions re-runs the server-side
  // `reconcileSessionHygiene` read-path (kill-0 re-probe + false-ended rescue +
  // name-canonicalization) and returns the reconciled rows; we merge them into
  // the sessions Map. This NEVER retires a target — the verify-dead retire flow
  // stays P1. A SIGSTOP'd/kill-0-alive target is rescued to live-visible, not
  // marked ended (closes the kill-0 hole from the operator's side).
  const handleCheckLiveness = useCallback(async (_sessionId: string) => {
    try {
      const res = await fetch(`${getApiBase()}/api/sessions`);
      if (!res.ok) return;
      const body = (await res.json()) as ApiResponse<DashboardSession[]>;
      if (!body.success || !Array.isArray(body.data)) return;
      const reconciled = body.data;
      setSessions((prev) => {
        const next = new Map(prev);
        for (const s of reconciled) next.set(s.id, { ...next.get(s.id), ...s });
        return next;
      });
    } catch {
      /* network error — read-only re-check is best-effort */
    }
  }, [setSessions]);

  // Flow picker state (for /flows command intercept)
  const [flowPickerOpen, setFlowPickerOpen] = useState(false);
  const [flowNewOpen, setFlowNewOpen] = useState(false);
  const [flowEditPickerOpen, setFlowEditPickerOpen] = useState(false);
  const [flowEditFlowName, setFlowEditFlowName] = useState<string | null>(null);
  const [flowDeletePickerOpen, setFlowDeletePickerOpen] = useState(false);
  const [flowDeleteFlowName, setFlowDeleteFlowName] = useState<string | null>(null);
  const [flowLaunchTarget, setFlowLaunchTarget] = useState<FlowInfo | null>(null);

  // Extension UI System (Phase 1): currently-open module modal, and the
  // searchable picker shown via the Modules entry point.
  // See change: add-extension-ui-modal.
  const [extensionModuleOpen, setExtensionModuleOpen] = useState<{ sessionId: string; moduleId: string } | null>(null);
  const [extensionModulePickerOpen, setExtensionModulePickerOpen] = useState(false);

  // Built-in slash commands the dashboard handles natively. If an extension
  // pushes a module whose `command` matches one of these, we drop the module
  // (the built-in wins) and warn the developer.
  const BUILTIN_SLASH_COMMANDS = useMemo(() => new Set([
    "/flows", "/flows:new", "/flows:edit", "/flows:delete",
    "/compact", "/reload", "/new", "/model", "/roles",
  ]), []);

  // Wrap handleSend to intercept /flows commands, extension UI module commands,
  // and clear the per-session draft.
  const wrappedHandleSend = useCallback((text: string, images?: ImageContent[]) => {
    const trimmed = text.trim();
    if (trimmed === "/flows") {
      setFlowPickerOpen(true);
      return;
    }
    if (trimmed === "/flows:new") {
      setFlowNewOpen(true);
      return;
    }
    // Extension UI System (Phase 1): exact-match slash command opens the
    // matching module modal and suppresses the prompt send.
    // See change: add-extension-ui-modal.
    if (selectedId && trimmed.startsWith("/")) {
      const session = sessions.get(selectedId);
      const modules = session?.uiModules ?? [];
      const match = modules.find((m) => m.command === trimmed && !BUILTIN_SLASH_COMMANDS.has(m.command));
      if (match) {
        setExtensionModuleOpen({ sessionId: selectedId, moduleId: match.id });
        if (selectedId) {
          clearDraftForSession(selectedId);
          clearImagesForSession(selectedId);
        }
        return;
      }
      // Drop modules colliding with built-ins; warn once per id per session-tick.
      const colliding = modules.find((m) => m.command === trimmed && BUILTIN_SLASH_COMMANDS.has(m.command));
      if (colliding) {
        console.warn(`[extension-ui] Dropping module "${colliding.id}" — command ${colliding.command} collides with a built-in.`);
      }
    }
    const finishClear = () => {
      if (selectedId) {
        clearDraftForSession(selectedId);
        clearImagesForSession(selectedId);
      }
    };
    // Downscale attached images just before send (default ON) to keep phone
    // photos from ballooning the payload + session history. A resize failure
    // must never block the send → fall back to the originals.
    if (images && images.length > 0 && !getSendFullResolution()) {
      resizeImagesForSend(images)
        .then((resized) => handleSend(text, resized))
        .catch(() => handleSend(text, images)) // fail-safe: send originals
        .finally(finishClear);
    } else {
      handleSend(text, images);
      finishClear();
    }
  }, [handleSend, selectedId, clearDraftForSession, clearImagesForSession, sessions, BUILTIN_SLASH_COMMANDS]);

  const openspecActions = useOpenSpecActions({
    send,
    openspecMap,
    setPreviewState,
    clearAllContentViews,
    navigate,
    settingsMatch: !!settingsMatch,
    tunnelSetupMatch: !!tunnelSetupMatch,
    dashboardMatch: !!dashboardMatch,
  });

  // Desktop back-arrow priority chain. See change: fix-desktop-back-navigation.
  const goBackDesktop = useDesktopBack({
    setArchiveBrowserCwd,
    setSpecsBrowserCwd,
    setFlowYamlPreview,
    setDiffViewSessionId,
    setPiResourceFilePreview,
    setReadmePreview,
    setPiResourcesState,
    setPreviewState,
    navigate,
    archiveBrowserCwd,
    specsBrowserCwd,
    flowYamlPreview,
    diffViewSessionId,
    piResourceFilePreview,
    readmePreview,
    piResourcesState,
    previewState,
    selectedId,
  });
  const {
    handleOpenSpecRefresh, handleBulkArchive, handleReadArtifact,
    handleAttachProposal, handleDetachProposal,
  } = openspecActions;

  // Flow YAML viewer helpers
  const openFlowYaml = useCallback(async (sessionId: string) => {
    const state = sessionStates.get(sessionId);
    if (!state) return;
    // Architect: use stored YAML content
    if (state.architectState?.flowYamlContent) {
      clearAllContentViews();
      setFlowYamlPreview({
        content: "```yaml\n" + state.architectState.flowYamlContent + "\n```",
        title: state.architectState.flowName || "Flow YAML",
      });
      return;
    }
    // Execution: fetch via /api/file
    const flowSource = state.flowState?.flowSource;
    const session = sessions.get(sessionId);
    if (flowSource && session?.cwd) {
      try {
        const res = await fetch(`${apiBase}/api/file?cwd=${encodeURIComponent(session.cwd)}&path=${encodeURIComponent(flowSource)}`);
        const body = await res.json();
        if (body.success && body.data?.content) {
          clearAllContentViews();
          setFlowYamlPreview({
            content: "```yaml\n" + body.data.content + "\n```",
            title: state.flowState?.flowName || "Flow YAML",
          });
        }
      } catch { /* ignore fetch errors */ }
    }
  }, [sessionStates, sessions, clearAllContentViews]);

  // Flow agent source viewer — toggle: fetch on open, clear on close
  const toggleFlowAgentSource = useCallback(async (sourcePath: string, agentName: string) => {
    // Toggle off if same agent's source is already open
    if (sourceOpenAgent === agentName) {
      setSourceOpenAgent(null);
      setFlowYamlPreview(null);
      return;
    }
    const session = selectedId ? sessions.get(selectedId) : undefined;
    if (!session?.cwd) return;
    try {
      const res = await fetch(`${apiBase}/api/file?cwd=${encodeURIComponent(session.cwd)}&path=${encodeURIComponent(sourcePath)}`);
      const body = await res.json();
      if (body.success && body.data?.content) {
        clearAllContentViews();
        setSourceOpenAgent(agentName);
        setFlowYamlPreview({ content: body.data.content, title: agentName });
      }
    } catch { /* ignore fetch errors */ }
  }, [selectedId, sessions, sourceOpenAgent, clearAllContentViews]);

  // Compute set of session IDs that have active errors
  const errorSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, state] of sessionStates) {
      if (state.lastError) ids.add(id);
    }
    return ids;
  }, [sessionStates]);

  // Compute set of session IDs in active provider-retry phase (retryState set,
  // no terminal error). See change: fix-provider-retry-infinite-loop.
  const retrySessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, state] of sessionStates) {
      if (state.retryState && !state.lastError) ids.add(id);
    }
    return ids;
  }, [sessionStates]);

  // Stabilize the array identity handed to <SessionList>. `sessions`/`terminals`
  // are `useState<Map>` (new ref only on real mutation), so memoizing by the Map
  // ref means unrelated App re-renders (e.g. openspec_update, which touches zero
  // sessions) no longer mint a fresh array prop and storm the memoized
  // SessionCard list. See change: fix-session-list-rerender-storm.
  const sessionsArr = useMemo(() => Array.from(sessions.values()), [sessions]);
  const terminalsArr = useMemo(() => Array.from(terminals.values()), [terminals]);
  // Alive-only fleet count (build-2 fix-cycle MAJOR 3): the LandingPage "N
  // active" line + Start-session CTA must count only non-ended sessions —
  // `sessions.size` includes ended/hidden corpses ("2 active" while 1 alive).
  const aliveCount = useMemo(() => countAlive(sessionsArr), [sessionsArr]);

  // Fleet-brief (build-2 P0 fix #5/#6/#9/#12): the depth-0 "what needs me"
  // banner. `briefNow` is a coarse 30s ticker so the finished-unseen window
  // advances without re-rendering on every frame. `briefVisible` gates
  // acknowledgement on ACTUAL visibility — on mobile the depth-0 list panel
  // stays mounted (aria-hidden) at depth ≥ 1, so a hidden brief must NOT clear
  // unseen work (fix #6). Desktop: always visible.
  const [briefNow, setBriefNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setBriefNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const fleetBrief = useFleetBrief(sessionsArr, briefNow);
  // The ONE cold-load success oracle (build-2 P0 fix #7). Both sources must
  // settle successfully before we ever show a calm "no sessions" empty state.
  const hasLoadedOnce = deriveHasLoadedOnce({
    restSessions: restSessionsOutcome,
    snapshotReceived,
    surfaces: fleetBrief.surfacesOutcome,
  });
  const briefVisible = !isMobile || getMobileDepth({
    selectedId,
    folderTermCwd,
    folderEditorCwd,
    settingsMatch: !!settingsMatch,
    tunnelSetupMatch: !!tunnelSetupMatch,
    dashboardMatch: !!dashboardMatch,
    hasPreview: !!previewState || !!piResourcesState || !!piResourceFilePreview || !!readmePreview || !!specsBrowserCwd || !!archiveBrowserCwd || !!diffViewSessionId || !!flowYamlPreview,
  }) === 0;

  const sessionList = (
    <div className="flex flex-col h-full min-h-0">
      {/* Fleet-brief banner (build-2 P0 fix #12): depth-0 "what needs me"
          escalation — needs-you sessions + non-none operator surfaces, plus the
          finished-unseen freshness window. THIS is the global escalation lane;
          there is no second one. */}
      <FleetBriefBanner
        items={fleetBrief.items}
        finishedUnseen={fleetBrief.finishedUnseen}
        isVisible={briefVisible}
        onSelect={handleSelect}
        acknowledge={fleetBrief.acknowledge}
      />
      {/* Active operator surfaces was previously mounted here at the top
          of the sidebar (cell pi-agent-dashboard-ux-message-discoverability/v1
          W4.4 + W6). Split out 2026-05-26 to a dedicated `/dashboard` page
          per operator-direct ratification 2026-05-26 ~00:40 CEST so the
          sessions list page shows sessions only. The surfaces tile now
          lives in <DashboardPage /> (see Route below). */}
      <div className="flex-1 flex flex-col min-h-0">
    <SessionList
      sessions={sessionsArr}
      terminals={terminalsArr}
      selectedId={selectedId}
      hasLoadedOnce={hasLoadedOnce}
      onSelect={handleSelect}
      contextUsageMap={contextUsageMap}
      openspecMap={openspecMap}
      sessionOrderMap={sessionOrderMap}
      onReorderSessions={(cwd, sessionIds) => {
        setSessionOrderMap((prev) => {
          const next = new Map(prev);
          next.set(cwd, sessionIds);
          return next;
        });
        send({ type: "reorder_sessions", cwd, sessionIds });
      }}
      onSendPrompt={handleSendPromptToSession}
      onFlowAction={handleFlowAction}
      onOpenSpecRefresh={handleOpenSpecRefresh}
      onBulkArchive={handleBulkArchive}
      onReadArtifact={handleReadArtifact}
      onOpenPiResources={handleOpenPiResources}
      onOpenSpecs={(cwd) => { clearAllContentViews(); setSpecsBrowserCwd(cwd); }}
      onOpenArchive={(cwd) => { clearAllContentViews(); setArchiveBrowserCwd(cwd); }}
      onViewReadme={handleViewReadme}
      onAttachProposal={handleAttachProposal}
      onDetachProposal={handleDetachProposal}
      onRename={handleRenameSession}
      onCheckLiveness={handleCheckLiveness}
      onResume={handleResumeSession}
      onResumeKeepPosition={handleResumeSessionKeepPosition}
      onHideSession={handleHideSession}
      onUnhideSession={handleUnhideSession}
      onSpawnSession={handleSpawnSession}
      onSpawnWorktree={(cwd) => setWorktreeSpawnCwd(cwd)}
      spawningCwds={spawningCwds}
      spawnResult={spawnResult}
      onSpawnResultSeen={() => setSpawnResult(null)}
      pinnedDirectories={pinnedDirectories}
      onOpenPinDialog={() => setPinDialogOpen(true)}
      onPinDirectory={(dirPath) => {
        setPinnedDirectories((prev) => prev.includes(dirPath) ? prev : [...prev, dirPath]);
        send({ type: "pin_directory", path: dirPath });
      }}
      onUnpinDirectory={(dirPath) => {
        setPinnedDirectories((prev) => prev.filter((p) => p !== dirPath));
        send({ type: "unpin_directory", path: dirPath });
      }}
      onReorderPinnedDirs={(paths) => {
        setPinnedDirectories(paths);
        send({ type: "reorder_pinned_dirs", paths });
      }}
      onKillTerminal={handleKillTerminal}
      onRenameTerminal={handleRenameTerminal}
      onCollapseSidebar={sidebar.toggleCollapse}
      commandsMap={sessionCommands}
      flowsMap={sessionFlows}
      onKillProcess={handleKillProcess}
      onOpenTerminals={(cwd) => navigate(`/folder/${encodeFolderPath(cwd)}/terminals`)}
      onOpenEditor={(cwd) => navigate(`/folder/${encodeFolderPath(cwd)}/editor`)}
      editorStatuses={editorStatuses}
      editorAvailable={editorAvailable}
      errorSessionIds={errorSessionIds}
      spawnErrors={spawnErrors}
      onDismissSpawnError={(cwd) => setSpawnErrors((prev) => { const next = new Map(prev); next.delete(cwd); return next; })}
      resumeErrors={resumeErrors}
      onDismissResumeError={(id) => setResumeErrors((prev) => { const next = new Map(prev); next.delete(id); return next; })}
      headerExtra={
        <div className="flex items-center gap-2">
          <PiUpdateBadge />
          <ServerSelector
            currentHost={currentServerHost}
            currentPort={currentServerPort}
            connected={status === "connected"}
            onSwitch={handleServerSwitch}
            inFlightSwitchKey={inFlightSwitchKey}
            onManageServers={() => navigate("/settings?tab=servers")}
          />
        </div>
      }
    />
      </div>
    </div>
  );

  const connectionBanner = (
    <>
      {status === "connecting" && (
        <div className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1 text-center">
          Connecting...
        </div>
      )}
      {status === "offline" && (
        <div className="bg-red-600/20 text-red-400 text-xs px-3 py-1 text-center">
          Server offline
        </div>
      )}
      {status === "auth_required" && (
        <div className="bg-amber-600/20 text-amber-400 text-xs px-3 py-1 text-center">
          Session expired —{" "}
          <a href={`${apiBase}/auth/login?return=${encodeURIComponent(window.location.pathname)}`} className="underline hover:text-amber-300">
            Sign in
          </a>
        </div>
      )}
    </>
  );

  const sessionDetail = selectedId ? (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      {connectionBanner}
      <SessionHeader
        session={sessions.get(selectedId)}
        state={selectedState}
        onRename={handleRenameSession}
        showBack
        onBack={isMobile ? () => navigate("/") : goBackDesktop}
        onResume={selectedId ? (mode) => handleResumeSession(selectedId, mode) : undefined}
        presence={selectedId ? presenceMap.get(selectedId) : undefined}
        mobileActions={isMobile ? {
          editors: selectedCwd ? editorMap.get(selectedCwd) : undefined,
          openspecChanges: selectedCwd ? openspecMap.get(selectedCwd)?.changes : undefined,
          onHide: () => handleHideSession(selectedId),
          onUnhide: () => handleUnhideSession(selectedId),
          onResume: (mode) => handleResumeSession(selectedId, mode),
          onCheckLiveness: () => handleCheckLiveness(selectedId),
          onOpenEditor: selectedCwd ? (editorId) => {
            import("./lib/editor-api.js").then(({ openEditor }) => openEditor(selectedCwd!, editorId));
          } : undefined,
          onAttachProposal: (changeName) => handleAttachProposal(selectedId, changeName),
          onDetachProposal: () => handleDetachProposal(selectedId),
          onSendPrompt: (text) => wrappedHandleSend(text),
          onReadArtifact: (changeName, artifactId) => handleReadArtifact(selectedCwd!, changeName, artifactId),
          onRefresh: () => {
            setSessionStates((prev) => {
              const next = new Map(prev);
              next.set(selectedId, createInitialState());
              return next;
            });
            maxSeqMapRef.current.set(selectedId, 0);
            subscribedRef.current.delete(selectedId);
            subscribedRef.current.add(selectedId);
            send({ type: "subscribe", sessionId: selectedId, lastSeq: 0 });
          },
          // W4.4.1 mobile-kebab context-usage + cost drill (cell
          // pi-agent-dashboard-ux-message-discoverability/v1; operator-direct
          // verdict 2026-05-23 ~23:15 CEST). Closes sister-cell ccd79aa9's
          // broken promise that context-usage/cost would "remain drillable via
          // mobile kebab" — the kebab now actually renders them. Pass-through
          // mirrors the desktop TokenStatsBar wiring below (line 952+).
          contextUsage: selectedState.contextUsage,
          cost: selectedState.cost,
          onOpenModelSheet: () => setModelSheetOpen(true),
        } : undefined}
        commands={selectedCommands}
        flows={selectedFlows}
        onSendPrompt={wrappedHandleSend}
        openspecChanges={selectedCwd ? openspecMap.get(selectedCwd)?.changes : undefined}
        onAttachProposal={(changeName) => handleAttachProposal(selectedId, changeName)}
        onDetachProposal={() => handleDetachProposal(selectedId)}
        onReadArtifact={selectedCwd ? (changeName, artifactId) => handleReadArtifact(selectedCwd, changeName, artifactId) : undefined}
        hasFileChanges={selectedState.hasFileChanges}
        onOpenDiffView={() => { clearAllContentViews(); setDiffViewSessionId(selectedId); }}
        onOpenExtensionModulePicker={() => setExtensionModulePickerOpen(true)}
        onRefresh={() => {
          setSessionStates((prev) => {
            const next = new Map(prev);
            next.set(selectedId, createInitialState());
            return next;
          });
          maxSeqMapRef.current.set(selectedId, 0);
          subscribedRef.current.delete(selectedId);
          subscribedRef.current.add(selectedId);
          send({ type: "subscribe", sessionId: selectedId, lastSeq: 0 });
        }}
        onFilterToggle={() => setShowMessageFilterControls((v) => !v)}
        isFilterActive={showMessageFilterControls}
        onSearchToggle={() => chatViewRef.current?.toggleSearch()}
      />
      {/* Mobile info strip: ELIMINATED per Bert tenure-2 Q2 W3 verdict 2026-05-20
          ~23:55 CEST (RATIFY (a) full elimination). Operator-verbatim per
          Pattern 87 (typo `unncessay` preserved byte-identical):
          "space should be for the chat, not for unncessay info". The strip
          duplicated StatusBar info (model + thinking + streaming + cost +
          context-usage) and consumed 46-60px per-session vertical real-estate.
          Context-usage + cost remain drillable via mobile kebab
          (MobileActionMenu) and the absorbed model+thinking indicator now
          lives compactly in SessionHeader's MobileHeader (Bert Q1 amend).
          Cell: mobile-pwa-chatgpt-style-restructure/v1 (MintOwl). */}
      {!isMobile && (
        <TokenStatsBar
          turnStats={selectedState.turnStats}
          contextUsage={selectedState.contextUsage}
          tokensIn={selectedState.tokensIn}
          tokensOut={selectedState.tokensOut}
          cacheRead={selectedState.cacheRead}
          cacheWrite={selectedState.cacheWrite}
          cost={selectedState.cost}
          onTurnClick={(turnIndex) => chatViewRef.current?.scrollToTurn(turnIndex)}
        />
      )}
      {archiveBrowserCwd ? (
        <ArchiveBrowserView
          cwd={archiveBrowserCwd}
          onBack={() => setArchiveBrowserCwd(null)}
        />
      ) : specsBrowserCwd ? (
        <SpecsBrowserView
          cwd={specsBrowserCwd}
          onBack={() => setSpecsBrowserCwd(null)}
        />
      ) : piResourceFilePreview ? (
        <MarkdownPreviewView
          title={piResourceFilePreview.title}
          content={piResourceFilePreview.content}
          isLoading={piResourceFilePreview.isLoading}
          error={piResourceFilePreview.error}
          onBack={() => setPiResourceFilePreview(null)}
        />
      ) : readmePreview ? (
        <MarkdownPreviewView
          title={`README.md — ${readmePreview.cwd.split("/").pop()}`}
          content={readmePreview.content}
          isLoading={readmePreview.isLoading}
          error={readmePreview.error}
          onBack={() => setReadmePreview(null)}
        />
      ) : piResourcesState ? (
        <PiResourcesView
          cwd={piResourcesState.cwd}
          onBack={() => setPiResourcesState(null)}
          onViewFile={handleViewPiResourceFile}
        />
      ) : previewState ? (
        <OpenSpecPreview
          cwd={previewState.cwd}
          changeName={previewState.changeName}
          initialArtifact={previewState.artifactId}
          artifacts={previewState.artifacts}
          onBack={() => setPreviewState(null)}
        />
      ) : flowYamlPreview ? (
        <MarkdownPreviewView
          title={flowYamlPreview.title}
          content={flowYamlPreview.content}
          onBack={() => { setFlowYamlPreview(null); setSourceOpenAgent(null); }}
        />
      ) : diffViewSessionId ? (
        <FileDiffView
          sessionId={diffViewSessionId}
          onBack={() => setDiffViewSessionId(null)}
        />
      ) : architectDetailOpen && selectedState.architectState ? (
        <>
          {selectedState.architectState && (
            <div className="sticky top-0 z-10">
              <FlowArchitect
                state={selectedState.architectState}
                onAbort={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "abort" })}
                onClick={() => setArchitectDetailOpen(prev => !prev)}
                isDetailOpen={architectDetailOpen}
                onPromptRespond={(promptId, answer) => selectedId && send({ type: "architect_prompt_response" as any, sessionId: selectedId, promptId, answer })}
                onViewYaml={() => selectedId && openFlowYaml(selectedId)}
                onViewAgentSource={(name, source) => { clearAllContentViews(); setFlowYamlPreview({ content: "```yaml\n" + source + "\n```", title: name }); }}
              />
            </div>
          )}
          <FlowArchitectDetail
            state={selectedState.architectState}
            onBack={() => setArchitectDetailOpen(false)}
          />
        </>
      ) : flowDetailAgent && selectedState.flowState?.agents.has(flowDetailAgent) ? (
        <>
          {selectedState.architectState && (
            <div className="sticky top-0 z-10">
              <FlowArchitect
                state={selectedState.architectState}
                onAbort={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "abort" })}
                onClick={() => setArchitectDetailOpen(prev => !prev)}
                isDetailOpen={architectDetailOpen}
                onPromptRespond={(promptId, answer) => selectedId && send({ type: "architect_prompt_response" as any, sessionId: selectedId, promptId, answer })}
                onViewYaml={() => selectedId && openFlowYaml(selectedId)}
                onViewAgentSource={(name, source) => { clearAllContentViews(); setFlowYamlPreview({ content: "```yaml\n" + source + "\n```", title: name }); }}
              />
            </div>
          )}
          {selectedState.flowState && (
            <div className={`sticky ${selectedState.architectState ? 'top-auto' : 'top-0'} z-10`}>
              <FlowDashboard
                flowState={selectedState.flowState}
                flowStates={selectedState.flowStates}
                session={selectedSession}
                onAgentClick={setFlowDetailAgent}
                selectedAgent={flowDetailAgent}
                onAbort={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "abort" })}
                onToggleAutonomous={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "toggle_autonomous" })}
                onDismiss={() => {
                  setFlowDetailAgent(null);
                  selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "dismiss_summary" });
                }}
                onSendPrompt={(text) => handleSend(text)}
                onViewYaml={() => selectedId && openFlowYaml(selectedId)}
                onViewAgentSource={toggleFlowAgentSource}
                sourceOpenAgent={sourceOpenAgent}
              />
            </div>
          )}
          <FlowAgentDetail
            agent={selectedState.flowState!.agents.get(flowDetailAgent)!}
            onBack={() => setFlowDetailAgent(null)}
          />
        </>
      ) : (
        <>
          {selectedState.architectState && (
            <div className="sticky top-0 z-10">
              <FlowArchitect
                state={selectedState.architectState}
                onAbort={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "abort" })}
                onClick={() => setArchitectDetailOpen(prev => !prev)}
                isDetailOpen={architectDetailOpen}
                onPromptRespond={(promptId, answer) => selectedId && send({ type: "architect_prompt_response" as any, sessionId: selectedId, promptId, answer })}
                onViewYaml={() => selectedId && openFlowYaml(selectedId)}
                onViewAgentSource={(name, source) => { clearAllContentViews(); setFlowYamlPreview({ content: "```yaml\n" + source + "\n```", title: name }); }}
              />
            </div>
          )}
          {selectedState.flowState && (
            <div className={`sticky ${selectedState.architectState ? 'top-auto' : 'top-0'} z-10`}>
              <FlowDashboard
                flowState={selectedState.flowState}
                flowStates={selectedState.flowStates}
                session={selectedSession}
                onAgentClick={setFlowDetailAgent}
                selectedAgent={flowDetailAgent}
                onAbort={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "abort" })}
                onToggleAutonomous={() => selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "toggle_autonomous" })}
                onDismiss={() => {
                  selectedId && send({ type: "flow_control" as any, sessionId: selectedId, action: "dismiss_summary" });
                }}
                onSendPrompt={(text) => handleSend(text)}
                onViewYaml={() => selectedId && openFlowYaml(selectedId)}
                onViewAgentSource={toggleFlowAgentSource}
                sourceOpenAgent={sourceOpenAgent}
              />
            </div>
          )}
          {/* Plugin slot: content-header-sticky (additive, coexists with FlowDashboard until extract-flows-as-plugin) */}
          <ContentHeaderStickySlot session={sessions.get(selectedId)!} />
          <ErrorBoundary fallback={
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="text-center space-y-2">
                <div className="text-red-400 text-sm">Chat view encountered an error</div>
                <button onClick={() => window.location.reload()} className="text-xs text-blue-400 hover:underline">Reload page</button>
              </div>
            </div>
          }>
            <SessionAssetsProvider assets={selectedSession?.assets}>
            <ChatView ref={chatViewRef} sessionId={selectedId} state={selectedState} sessionCtx={sessionCtx} toolContext={toolContext} onCancelPending={handleCancelPending} onRespondToUi={handleRespondToUi} onRendered={handleRenderedAck} onAbort={handleAbort} onForceKill={handleForceKill} onForkFromMessage={selectedId ? (entryId) => handleResumeSession(selectedId, "fork", entryId) : undefined} onRetryAfterError={selectedId ? () => {
              // Retry the last user prompt by re-sending it via send_prompt.
              // The previous behaviour (handleResumeSession with mode="continue")
              // no-ops on alive-but-errored sessions because the server short-
              // circuits with "Session is already active". See change:
              // fix-retry-resends-last-user-message.
              const last = findLastUserPrompt(selectedState.messages);
              if (last) handleSendPromptToSession(selectedId, last.text, last.images);
            } : undefined} onDismissError={selectedId ? () => {
              setSessionStates((prev) => {
                const next = new Map(prev);
                const current = next.get(selectedId!);
                if (current?.lastError) {
                  next.set(selectedId!, { ...current, lastError: undefined });
                }
                return next;
              });
            } : undefined} onRetryQueued={handleRetryQueued} onDismissQueued={handleDismissQueued} showFilterControls={showMessageFilterControls} onCloseFilterControls={() => setShowMessageFilterControls(false)} dataUnavailable={selectedSession?.dataUnavailable} />
            </SessionAssetsProvider>
          </ErrorBoundary>
          {/* StatusBar: desktop-only per-session footer (Bert tenure-2 Q1 W3
              verdict 2026-05-20 ~23:55 CEST AMEND (c)→(a)). Mobile path
              absorbs a minimal model+thinking indicator into SessionHeader's
              MobileHeader instead — model-switching mid-work is a real flow;
              ChatGPT-iOS reference confirms model picker visible in top
              header. The 29px footer was operator-verbatim chrome per
              "space should be for the chat, not for unncessay info" (typo
              `unncessay` preserved byte-identical per Pattern 87).
              Sister-precedent: cd70e4dd `!isMobile` ContentHeaderStickySlot
              gate at line ~1291.
              Cell: mobile-pwa-chatgpt-style-restructure/v1 (MintOwl). */}
          {!isMobile && (
            <StatusBar
              model={selectedState.model ?? selectedSession?.model}
              models={modelsMap.get(selectedId)}
              roles={rolesMap.get(selectedId)}
              thinkingLevel={selectedState.thinkingLevel ?? selectedSession?.thinkingLevel}
              status={selectedState.status}
              currentTool={selectedState.currentTool}
              streamingText={selectedState.streamingText || undefined}
              onSelectModel={handleSelectModel}
              onSelectThinkingLevel={handleSelectThinkingLevel}
              onRoleSet={(role, modelId) => {
                send({ type: "role_set", sessionId: selectedId, role, modelId });
              }}
              onPresetLoad={(presetName) => {
                send({ type: "role_preset_load", sessionId: selectedId, presetName });
              }}
              onPresetSave={(presetName) => {
                send({ type: "role_preset_save", sessionId: selectedId, presetName });
              }}
              onPresetDelete={(presetName) => {
                send({ type: "role_preset_delete", sessionId: selectedId, presetName });
              }}
              bellState={selectedSession?.pushPrefs?.notifyCompletion ?? "off"}
              onBellClick={handleCycleBell}
              pushEnabled={true}
            />
          )}
          {isMobile && modelSheetOpen && (
            <ModelReasoningSheet
              sessionName={selectedSession ? getSessionDisplayName(selectedSession) : undefined}
              currentModel={selectedState.model ?? selectedSession?.model}
              models={modelsMap.get(selectedId)}
              thinkingLevel={selectedState.thinkingLevel ?? selectedSession?.thinkingLevel}
              bellState={selectedSession?.pushPrefs?.notifyCompletion ?? "off"}
              pushEnabled={true}
              onSelectModel={handleSelectModel}
              onSelectThinkingLevel={handleSelectThinkingLevel}
              onCycleBell={handleCycleBell}
              onClose={() => setModelSheetOpen(false)}
            />
          )}
          <CommandInput
            commands={selectedCommands}
            onSend={wrappedHandleSend}
            onListFiles={handleListFiles}
            fileResults={fileResults}
            disabled={false}
            sessionStatus={selectedState.status}
            retrying={selectedState.retryState !== undefined}
            onAbort={handleAbort}
            onForceKill={handleForceKill}
            pendingPrompt={!!selectedState.pendingPrompt}
            onCancelPending={handleCancelPending}
            queuedCount={selectedState.queue.length}
            sessionId={selectedId}
            sessionName={selectedSession?.name}
            draft={selectedDraft}
            onDraftChange={setDraftForSelected}
            history={selectedHistory}
            images={selectedImages}
            onImagesChange={setImagesForSelected}
          />
          {/* Plugin slot: content-inline-footer (additive, coexists with FlowSummary until extract-flows-as-plugin) */}
          <ContentInlineFooterSlot session={sessions.get(selectedId)!} />
          {flowPickerOpen && (() => {
            const hasFlowsNew = selectedCommands.some(c => c.name === "flows:new");
            const hasFlowsEdit = selectedCommands.some(c => c.name === "flows:edit");
            const hasFlowsDelete = selectedCommands.some(c => c.name === "flows:delete");
            const flowOptions: SelectOption[] = [
              ...(hasFlowsNew ? [{ value: "__new__", label: "+ New Flow", description: "Design a new flow with the Flow Architect" }] : []),
              ...(hasFlowsEdit && selectedFlows.length > 0 ? [{ value: "__edit__", label: "\u270E\uFE0E Edit Flow...", description: "Edit an existing flow" }] : []),
              ...(hasFlowsDelete && selectedFlows.length > 0 ? [{ value: "__delete__", label: "\u00D7 Delete Flow...", description: "Delete a saved flow" }] : []),
              ...selectedFlows.map((f) => ({
                value: f.name,
                label: f.name,
                description: f.description,
              })),
            ];
            return (
              <SearchableSelectDialog
                title="Flows"
                options={flowOptions}
                placeholder="Search flows..."
                emptyMessage="No flows available"
                onSelect={(value) => {
                  setFlowPickerOpen(false);
                  if (value === "__new__") {
                    setFlowNewOpen(true);
                  } else if (value === "__edit__") {
                    setFlowEditPickerOpen(true);
                  } else if (value === "__delete__") {
                    setFlowDeletePickerOpen(true);
                  } else {
                    const flow = selectedFlows.find(f => f.name === value);
                    if (flow) {
                      if (flow.taskRequired) {
                        setFlowLaunchTarget(flow);
                      } else {
                        if (selectedId) handleFlowAction(selectedId, "run", { flowName: flow.name });
                      }
                    }
                  }
                }}
                onCancel={() => setFlowPickerOpen(false)}
              />
            );
          })()}
          {flowNewOpen && (
            <FlowLaunchDialog
              flowName="flows:new"
              description="Design a new flow with the Flow Architect"
              onSubmit={(task) => {
                if (selectedId && task.trim()) handleFlowAction(selectedId, "new", { description: task.trim() });
                setFlowNewOpen(false);
              }}
              onCancel={() => setFlowNewOpen(false)}
            />
          )}
          {flowEditPickerOpen && (
            <SearchableSelectDialog
              title="Edit Flow"
              options={selectedFlows.map((f) => ({ value: f.name, label: f.name, description: f.description }))}
              placeholder="Search flows..."
              emptyMessage="No flows available"
              onSelect={(value) => {
                setFlowEditFlowName(value);
                setFlowEditPickerOpen(false);
              }}
              onCancel={() => setFlowEditPickerOpen(false)}
            />
          )}
          {flowEditFlowName && (
            <FlowLaunchDialog
              flowName={flowEditFlowName}
              description="Describe how this flow should be updated"
              onSubmit={(desc) => {
                if (selectedId && desc.trim()) handleFlowAction(selectedId, "edit", { flowName: flowEditFlowName, description: desc.trim() });
                setFlowEditFlowName(null);
              }}
              onCancel={() => setFlowEditFlowName(null)}
            />
          )}
          {flowDeletePickerOpen && (
            <SearchableSelectDialog
              title="Delete Flow"
              options={selectedFlows.map((f) => ({ value: f.name, label: f.name, description: f.description }))}
              placeholder="Search flows..."
              emptyMessage="No flows available"
              onSelect={(value) => {
                setFlowDeleteFlowName(value);
                setFlowDeletePickerOpen(false);
              }}
              onCancel={() => setFlowDeletePickerOpen(false)}
            />
          )}
          {flowDeleteFlowName && (
            <ConfirmDialog
              message={`Delete flow "${flowDeleteFlowName}"? This will remove the flow file and any associated agents.`}
              confirmLabel="Delete"
              onConfirm={() => {
                if (selectedId) handleFlowAction(selectedId, "delete", { flowName: flowDeleteFlowName });
                setFlowDeleteFlowName(null);
              }}
              onCancel={() => setFlowDeleteFlowName(null)}
            />
          )}
          {flowLaunchTarget && (
            <FlowLaunchDialog
              flowName={flowLaunchTarget.name}
              description={flowLaunchTarget.description}
              session={selectedSession}
              onSubmit={(task) => {
                if (selectedId) handleFlowAction(selectedId, "run", { flowName: flowLaunchTarget.name, task: task || undefined });
                setFlowLaunchTarget(null);
              }}
              onCancel={() => setFlowLaunchTarget(null)}
            />
          )}
          {/* Extension UI System (Phase 1): module picker + generic modal. */}
          {/* See change: add-extension-ui-modal. */}
          {extensionModulePickerOpen && selectedId && (() => {
            const session = sessions.get(selectedId);
            const modules = session?.uiModules ?? [];
            const options: SelectOption[] = modules.map((m) => ({
              value: m.id,
              label: m.title,
              description: m.description ?? m.command,
              badge: m.category,
            }));
            return (
              <SearchableSelectDialog
                title="Extension Modules"
                options={options}
                placeholder="Search modules..."
                emptyMessage="No modules available"
                onSelect={(moduleId) => {
                  setExtensionModuleOpen({ sessionId: selectedId, moduleId });
                  setExtensionModulePickerOpen(false);
                }}
                onCancel={() => setExtensionModulePickerOpen(false)}
              />
            );
          })()}
          {/* Extension UI System (Phase 2): toast slot — top-right tray. */}
          {/* See change: add-extension-ui-decorations. */}
          <ToastSlot sessions={sessions} />
          {extensionModuleOpen && (() => {
            const session = sessions.get(extensionModuleOpen.sessionId);
            const module = session?.uiModules?.find((m) => m.id === extensionModuleOpen.moduleId);
            if (!module) return null;
            const dataEvent = module.view.dataEvent;
            const rows = dataEvent ? (session?.uiDataMap?.[dataEvent] ?? []) : [];
            return (
              <GenericExtensionDialog
                module={module}
                rows={rows}
                onDispatch={({ action, event, params }) => {
                  send({
                    type: "ui_management",
                    sessionId: extensionModuleOpen.sessionId,
                    action,
                    event,
                    params,
                  });
                }}
                onClose={() => setExtensionModuleOpen(null)}
              />
            );
          })()}
        </>
      )}
    </div>
  ) : null;

  // Get terminals for a specific folder cwd
  const getTerminalsForCwd = useCallback((cwd: string) => {
    return Array.from(terminals.values()).filter((t) => t.cwd === cwd);
  }, [terminals]);

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const handleEditorClose = useCallback(() => navigateRef.current("/"), []);

  // Folder view content (TerminalsView or EditorView)
  const folderViewContent = useMemo(() => {
    if (folderTermCwd) {
      const pendingTermId = lastCreatedTerminalIdRef.current;
      if (pendingTermId) lastCreatedTerminalIdRef.current = null;
      return (
        <TerminalsView
          cwd={folderTermCwd}
          terminals={getTerminalsForCwd(folderTermCwd)}
          activeTerminalId={pendingTermId ?? undefined}
          onCreateTerminal={handleCreateTerminal}
          onKillTerminal={handleKillTerminal}
          onRenameTerminal={handleRenameTerminal}
          onTerminalTitle={handleTerminalTitle}
        />
      );
    }
    if (folderEditorCwd) {
      return <EditorView cwd={folderEditorCwd} onClose={handleEditorClose} />;
    }
    return null;
  }, [folderTermCwd, folderEditorCwd, getTerminalsForCwd, handleCreateTerminal, handleKillTerminal, handleRenameTerminal, handleTerminalTitle, handleEditorClose]);

  const allSessionsList = useMemo(() => Array.from(sessions.values()), [sessions]);

  // Outer chrome ErrorBoundary — defense-in-depth for first-party shell
  // components (sidebar, session list, content header, MobileShell). The
  // inner ChatView ErrorBoundary still wins for chat-tree errors via React's
  // nearest-boundary semantics; this only fires when chrome itself throws
  // (e.g. a missing import / undefined symbol in SessionCard / SessionList).
  // Without it, a render-time ReferenceError in any chrome component blanks
  // the entire window. See change:
  // fix-session-card-icon-import-and-shell-boundary.
  const apiProvider = (children: React.ReactNode) => (
    <ApiContext.Provider value={apiBase}>
      <PluginContextProvider
        registry={_pluginRegistry}
        sessions={allSessionsList}
        send={(msg) => send(msg as Parameters<typeof send>[0])}
      >
        {/* PWA update pill — additive top-center overlay, mounted once for both
            the mobile and desktop branches. Sits OUTSIDE the shell ErrorBoundary
            so it still surfaces if the shell crashes (an update often fixes it).
            Renders nothing until a new service worker is waiting. */}
        <UpdatePrompt />
        <ErrorBoundary fallback={
          <div className="min-h-screen flex items-center justify-center p-8 bg-[var(--bg-primary)] text-[var(--text-primary)]" data-testid="shell-error-fallback">
            <div className="text-center space-y-2">
              <div className="text-red-400 text-sm">Shell encountered an error</div>
              <button onClick={() => window.location.reload()} className="text-xs text-blue-400 hover:underline">Reload page</button>
            </div>
          </div>
        }>
          {children}
        </ErrorBoundary>
      </PluginContextProvider>
    </ApiContext.Provider>
  );

  // Mobile: two-step full-screen navigation
  if (isMobile) {
    const mobileDepth = getMobileDepth({
      selectedId,
      folderTermCwd,
      folderEditorCwd,
      settingsMatch: !!settingsMatch,
      tunnelSetupMatch: !!tunnelSetupMatch,
      dashboardMatch: !!dashboardMatch,
      hasPreview: !!previewState || !!piResourcesState || !!piResourceFilePreview || !!readmePreview || !!specsBrowserCwd || !!archiveBrowserCwd || !!diffViewSessionId || !!flowYamlPreview,
    });
    return apiProvider(
      <div className="bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <BootstrapBanner state={bootstrapStatus.state} onRetry={bootstrapStatus.retry} />
        <PendingInputBanner
          items={pendingOperatorInputs}
          selectedSessionId={selectedId}
          onJump={(sid) => navigate(`/session/${sid}`)}
        />
        {sessions.size === 0 && (
          <ConnectionStatusBanner
            status={status}
            currentServerHost={currentServerHost}
            inFlightSwitch={inFlightSwitchKey !== null}
          />
        )}
        <Toast messages={toastMessages} onDismiss={dismissToast} />
        <MobileShell
          depth={mobileDepth}
          onBack={() => {
            if (archiveBrowserCwd) {
              setArchiveBrowserCwd(null);
            } else if (specsBrowserCwd) {
              setSpecsBrowserCwd(null);
            } else if (flowYamlPreview) {
              setFlowYamlPreview(null);
            } else if (diffViewSessionId) {
              setDiffViewSessionId(null);
            } else if (piResourceFilePreview) {
              setPiResourceFilePreview(null);
            } else if (readmePreview) {
              setReadmePreview(null);
            } else if (piResourcesState) {
              setPiResourcesState(null);
            } else if (previewState) {
              setPreviewState(null);
            } else {
              navigate("/");
            }
          }}
          listPanel={
            <div className="flex flex-col h-full">
              <InstallBanner canInstall={installPrompt.canInstall} isIOS={installPrompt.isIOS} isInstalled={installPrompt.isInstalled} prompt={installPrompt.prompt} />
              {connectionBanner}
              {sessionList}
            </div>
          }
          detailPanel={
            dashboardMatch ? (
              <DashboardPage />
            ) : settingsMatch ? (
              <SettingsPanel />
            ) : tunnelSetupMatch ? (
              <ZrokInstallGuide onBack={() => navigate("/")} />
            ) : archiveBrowserCwd ? (
              <ArchiveBrowserView
                cwd={archiveBrowserCwd}
                onBack={() => setArchiveBrowserCwd(null)}
              />
            ) : specsBrowserCwd ? (
              <SpecsBrowserView
                cwd={specsBrowserCwd}
                onBack={() => setSpecsBrowserCwd(null)}
              />
            ) : flowYamlPreview ? (
              <MarkdownPreviewView
                title={flowYamlPreview.title}
                content={flowYamlPreview.content}
                onBack={() => { setFlowYamlPreview(null); setSourceOpenAgent(null); }}
              />
            ) : diffViewSessionId ? (
              <FileDiffView
                sessionId={diffViewSessionId}
                onBack={() => setDiffViewSessionId(null)}
              />
            ) : piResourceFilePreview ? (
              <MarkdownPreviewView
                title={piResourceFilePreview.title}
                content={piResourceFilePreview.content}
                isLoading={piResourceFilePreview.isLoading}
                error={piResourceFilePreview.error}
                onBack={() => setPiResourceFilePreview(null)}
              />
            ) : readmePreview ? (
              <MarkdownPreviewView
                title={`README.md — ${readmePreview.cwd.split("/").pop()}`}
                content={readmePreview.content}
                isLoading={readmePreview.isLoading}
                error={readmePreview.error}
                onBack={() => setReadmePreview(null)}
              />
            ) : piResourcesState ? (
              <PiResourcesView
                cwd={piResourcesState.cwd}
                onBack={() => setPiResourcesState(null)}
                onViewFile={handleViewPiResourceFile}
              />
            ) : previewState ? (
              <OpenSpecPreview
                cwd={previewState.cwd}
                changeName={previewState.changeName}
                initialArtifact={previewState.artifactId}
                artifacts={previewState.artifacts}
                onBack={() => setPreviewState(null)}
              />
            ) : folderTermCwd ? (
              <TerminalsView
                cwd={folderTermCwd}
                terminals={getTerminalsForCwd(folderTermCwd)}
                activeTerminalId={lastCreatedTerminalIdRef.current ?? undefined}
                onCreateTerminal={handleCreateTerminal}
                onKillTerminal={handleKillTerminal}
                onRenameTerminal={handleRenameTerminal}
                onTerminalTitle={handleTerminalTitle}
              />
            ) : folderEditorCwd ? (
              <EditorView cwd={folderEditorCwd} onClose={handleEditorClose} />
            ) : sessionDetail ?? (
            // Legacy /terminal/:id branch removed — see change:
            // fix-terminal-half-height-dual-mount.
              <LandingPage
                providersReady={providersReady.ready}
                pinnedCount={pinnedDirectories.length}
                sessionsCount={aliveCount} hasLoadedOnce={hasLoadedOnce}
                firstPinnedCwd={pinnedDirectories[0] ?? null}
                onOpenPinDialog={() => setPinDialogOpen(true)}
                onSpawnSession={handleSpawnSession}
                navigate={navigate}
              />
            )
          }
        />
        {pinDialogOpen && (
          <DialogPortal>
            <PinDirectoryDialog
              onPin={(dirPath) => {
                setPinnedDirectories((prev) => prev.includes(dirPath) ? prev : [...prev, dirPath]);
                send({ type: "pin_directory", path: dirPath });
                setPinDialogOpen(false);
              }}
              onCancel={() => setPinDialogOpen(false)}
            />
          </DialogPortal>
        )}
        {worktreeSpawnCwd && (
          <WorktreeSpawnDialog
            cwd={worktreeSpawnCwd}
            onClose={() => setWorktreeSpawnCwd(null)}
            onSpawning={(cwd) => {
              setSpawningCwds(prev => new Set(prev).add(cwd));
              setTimeout(() => setSpawningCwds(prev => {
                const next = new Set(prev);
                next.delete(cwd);
                return next;
              }), 60_000);
            }}
          />
        )}
      </div>
    );
  }

  // Desktop: side-by-side layout
  return apiProvider(
    <div className="flex h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="hidden md:flex">
        <ResizableSidebar sidebar={sidebar}>
          {sessionList}
        </ResizableSidebar>
      </div>

      <HamburgerButton onClick={() => setMobileOpen(true)} />
      <MobileOverlay open={mobileOpen} onClose={() => setMobileOpen(false)}>
        {sessionList}
      </MobileOverlay>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {connectionBanner}
        {/* Folder views (TerminalsView or EditorView) — single owner of
            <TerminalView> mounting. The legacy keep-alive list above
            (mounted unconditionally for the /terminal/:id route) was
            removed; it caused dual-mounting per terminal id and the
            half-height rendering bug. See change:
            fix-terminal-half-height-dual-mount. */}
        {folderViewContent && (
          <div className="flex-1 flex flex-col min-w-0 min-h-0">{folderViewContent}</div>
        )}
        {/* Show session detail or landing page when no folder view is selected */}
        {!folderTermCwd && !folderEditorCwd && !settingsMatch && !tunnelSetupMatch && !dashboardMatch && (
          archiveBrowserCwd ? (
            <ArchiveBrowserView
              cwd={archiveBrowserCwd}
              onBack={() => setArchiveBrowserCwd(null)}
            />
          ) : specsBrowserCwd ? (
            <SpecsBrowserView
              cwd={specsBrowserCwd}
              onBack={() => setSpecsBrowserCwd(null)}
            />
          ) : piResourceFilePreview ? (
            <MarkdownPreviewView
              title={piResourceFilePreview.title}
              content={piResourceFilePreview.content}
              isLoading={piResourceFilePreview.isLoading}
              error={piResourceFilePreview.error}
              onBack={() => setPiResourceFilePreview(null)}
            />
          ) : readmePreview ? (
            <MarkdownPreviewView
              title={`README.md — ${readmePreview.cwd.split("/").pop()}`}
              content={readmePreview.content}
              isLoading={readmePreview.isLoading}
              error={readmePreview.error}
              onBack={() => setReadmePreview(null)}
            />
          ) : piResourcesState && !selectedId ? (
            <PiResourcesView
              cwd={piResourcesState.cwd}
              onBack={() => setPiResourcesState(null)}
              onViewFile={handleViewPiResourceFile}
            />
          ) : previewState && !selectedId ? (
            <OpenSpecPreview
              cwd={previewState.cwd}
              changeName={previewState.changeName}
              initialArtifact={previewState.artifactId}
              artifacts={previewState.artifacts}
              onBack={() => setPreviewState(null)}
            />
          ) : (
            /* Plugin slot: content-view (additive; rendered after existing routes, before sessionDetail fallback). Gate on registry claims so empty slot does NOT mask sessionDetail/LandingPage via `??`. */
            (selectedId && selectedSession && _pluginRegistry.getClaims("content-view").length > 0
              ? <ContentViewSlot session={selectedSession} routeParams={{}} onClose={() => navigate("/")} />
              : null
            ) ?? sessionDetail ?? (
              <LandingPage
                providersReady={providersReady.ready}
                pinnedCount={pinnedDirectories.length}
                sessionsCount={aliveCount} hasLoadedOnce={hasLoadedOnce}
                firstPinnedCwd={pinnedDirectories[0] ?? null}
                onOpenPinDialog={() => setPinDialogOpen(true)}
                onSpawnSession={handleSpawnSession}
                navigate={navigate}
              />
            )
          )
        )}
        {dashboardMatch && <DashboardPage />}
        {settingsMatch && <SettingsPanel availableModels={(() => {
          const seen = new Set<string>();
          const models: Array<{ provider: string; id: string }> = [];
          for (const list of modelsMap.values()) {
            for (const m of list) {
              const key = `${m.provider}/${m.id}`;
              if (!seen.has(key)) { seen.add(key); models.push(m); }
            }
          }
          return models;
        })()} />}
        {tunnelSetupMatch && <ZrokInstallGuide onBack={() => navigate("/")} />}
      </div>
      {pinDialogOpen && (
        <DialogPortal>
          <PinDirectoryDialog
            onPin={(dirPath) => {
              setPinnedDirectories((prev) => prev.includes(dirPath) ? prev : [...prev, dirPath]);
              send({ type: "pin_directory", path: dirPath });
              setPinDialogOpen(false);
            }}
            onCancel={() => setPinDialogOpen(false)}
          />
        </DialogPortal>
      )}
      {worktreeSpawnCwd && (
        <WorktreeSpawnDialog
          cwd={worktreeSpawnCwd}
          onClose={() => setWorktreeSpawnCwd(null)}
          onSpawning={(cwd) => {
            setSpawningCwds(prev => new Set(prev).add(cwd));
            setTimeout(() => setSpawningCwds(prev => {
              const next = new Set(prev);
              next.delete(cwd);
              return next;
            }), 60_000);
          }}
        />
      )}
    </div>
  );
}
