/**
 * Browser Gateway - WebSocket handler for browser client connections.
 * Runs on the HTTP server port via upgrade handling.
 */
import { WebSocketServer, WebSocket } from "ws";
import type {
  ServerToBrowserMessage,
  BrowserToServerMessage,
  PendingOperatorInput,
} from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { SessionManager } from "./memory-session-manager.js";
import type { EventStore } from "./memory-event-store.js";
import type { PiGateway } from "./pi-gateway.js";
import type { TokenPayload } from "./auth.js";
// PendingLoadManager removed — server loads sessions directly via DirectoryService
import { createHeadlessPidRegistry, type HeadlessPidRegistry } from "./headless-pid-registry.js";
import { projectSession } from "./session-projection.js";
import type { DashboardEvent, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { PendingForkRegistry } from "./pending-fork-registry.js";
import type { SessionOrderManager } from "./session-order-manager.js";
import type { PreferencesStore } from "./preferences-store.js";
import { hasOpenSpecDir, type DirectoryService } from "./directory-service.js";
import { extractTranslationRequest, type DashboardTranslator } from "./translator-service.js";

/**
 * Pure helper: build the per-cwd `openspec_update` messages a freshly
 * connecting browser should receive. One message per known cwd.
 * Disambiguates three states:
 *   - cache populated         → cached payload
 *   - openspec dir but cold   → { initialized: false, pending: true }
 *   - no openspec dir         → { initialized: false, pending: false }
 *
 * Exported so cold-boot snapshot semantics can be unit-tested without
 * spinning up a WS server. See change: fix-cold-boot-openspec-protocol.
 */
export function buildOpenSpecConnectSnapshot(
  directoryService: Pick<DirectoryService, "knownDirectories" | "getOpenSpecData">,
  hasDir: (cwd: string) => boolean,
): Array<ServerToBrowserMessage> {
  const out: Array<ServerToBrowserMessage> = [];
  for (const cwd of directoryService.knownDirectories()) {
    const cached = directoryService.getOpenSpecData(cwd);
    if (cached && cached.initialized) {
      out.push({ type: "openspec_update", cwd, data: cached });
    } else if (hasDir(cwd)) {
      out.push({
        type: "openspec_update",
        cwd,
        data: { initialized: false, pending: true, changes: [] },
      });
    } else {
      out.push({
        type: "openspec_update",
        cwd,
        data: { initialized: false, pending: false, changes: [] },
      });
    }
  }
  return out;
}
import { createPendingResumeRegistry, type PendingResumeRegistry } from "./pending-resume-registry.js";
import { createViewedSessionTracker, type ViewedSessionTracker } from "./viewed-session-tracker.js";
import { createSessionPresenceTracker } from "./session-presence-tracker.js";
import { getAgentPresence } from "./agent-presence.js";
import { deriveAuthor } from "./derive-author.js";
import { buildPromptResponseForward } from "./prompt-response-forward.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { BrowserHandlerContext } from "./browser-handlers/handler-context.js";
import { authorizeWsMessage } from "./ws-session-gate.js";
import { handleSubscribe } from "./browser-handlers/subscription-handler.js";
import { handleSendPrompt, handleResumeSession, handleSpawnSession, handleShutdown, handleAbort, handleFlowControl, handleForceKill, handleKillProcess } from "./browser-handlers/session-action-handler.js";
import { handleRenameSession, handleHideSession, handleUnhideSession, handleAttachProposal, handleDetachProposal, handleFetchContent, handleListSessions } from "./browser-handlers/session-meta-handler.js";
import { handleCreateTerminal, handleKillTerminal, handleRenameTerminal } from "./browser-handlers/terminal-handler.js";
import { handlePinDirectory, handleUnpinDirectory, handleReorderPinnedDirs, handleReorderSessions, handleOpenSpecRefresh, handleOpenSpecBulkArchive, handleExtensionUiResponse, handlePiGatewayForward } from "./browser-handlers/directory-handler.js";
import type { CellAccessController } from "./cell-access.js";
import {
  authorizeGuestBrowserMessage,
  filterServerMessageForPrincipal,
} from "./cell-access-ws.js";



export interface BrowserGateway {
  wss: WebSocketServer;
  broadcastEvent(sessionId: string, seq: number, event: any): void;
  broadcastSessionAdded(session: any, opts?: { spawnRequestId?: string }): void;
  broadcastSessionUpdated(sessionId: string, updates: any): void;
  broadcastSessionRemoved(sessionId: string): void;
  sendToSubscribers(sessionId: string, msg: ServerToBrowserMessage): void;
  broadcastToAll(msg: ServerToBrowserMessage): void;
  /** Get number of browser subscribers for a session */
  getSubscriberCount(sessionId: string): number;
  /** Track a pending interactive UI request for replay on reconnect */
  trackUiRequest(sessionId: string, requestId: string, method: string, params: Record<string, unknown>): boolean | void;
  /** Clear a pending interactive UI request (resolved or cancelled) */
  clearUiRequest(sessionId: string, requestId: string): void;
  /** Track a pending PromptBus request for replay on browser refresh */
  trackPromptRequest(sessionId: string, msg: Record<string, unknown>): void;
  /** Clear a pending PromptBus request (dismissed or cancelled) */
  clearPromptRequest(sessionId: string, promptId: string): void;
  /** Tell browser subscribers to reset accumulated state for a session (bridge reconnected) */
  broadcastSessionStateReset(sessionId: string): void;
  /** Shut down all tracked headless child processes */
  shutdownHeadlessProcesses(): void;
  /** Registry for linking headless PIDs to session IDs */
  headlessPidRegistry: HeadlessPidRegistry;
  /** Registry for pending auto-resume prompts */
  pendingResumeRegistry: PendingResumeRegistry;
  /**
   * Tracker for which browser is currently viewing which session. Used by
   * the unread-trigger evaluation in event-wiring.ts.
   * See change: session-card-unread-stripes.
   */
  viewedSessionTracker: ViewedSessionTracker;
  /** Send a message to a specific WebSocket client */
  sendToClient(ws: WebSocket, msg: ServerToBrowserMessage): void;
  /** Callback invoked when a new browser client connects */
  onConnect?: (ws: WebSocket) => void;
  /** Broadcast a message to all connected clients */
  broadcast(msg: ServerToBrowserMessage): void;
  /** Plugin-origin broadcast. Unscoped plugin messages are operator-only. */
  broadcastPluginMessage(msg: unknown): void;
  /** Re-send principal-filtered replacement snapshots after registry changes. */
  refreshAccessSnapshots(): void;
}

export function createBrowserGateway(
  sessionManager: SessionManager,
  eventStore: EventStore,
  piGateway: PiGateway,
  _pendingLoadManager?: unknown,
  pendingForkRegistry?: PendingForkRegistry,
  sessionOrderManager?: SessionOrderManager,
  preferencesStore?: PreferencesStore,
  directoryService?: DirectoryService,
  terminalManager?: TerminalManager,
  pendingDashboardSpawns?: Map<string, number>,
  maxWsBufferBytes?: number,
  pendingAttachRegistry?: import("./pending-attach-registry.js").PendingAttachRegistry,
  pendingResumeIntents?: import("./pending-resume-intent-registry.js").PendingResumeIntentRegistry,
  pendingClientCorrelations?: import("./pending-client-correlations.js").PendingClientCorrelations,
  pushPrefsMap?: Map<string, import("./push/push-types.js").PushPrefs>,
  getPushDefaults?: () => import("@blackbelt-technology/pi-dashboard-shared/config.js").PushDefaults | undefined,
  /**
   * Build 0 (PRINCIPAL-CAPTURE) multi-operator gate. When true, every browser
   * connection is required (at the `/ws` upgrade) to have bound a verified
   * principal, and the send-seam authorization gate enforces principal
   * presence. Default false → single-operator, gate no-ops (byte-unchanged).
   */
  requireBrowserAuth = false,
  /**
   * Build 1b WS-closure: the startup-frozen operator identities
   * (`auth.operatorUsers`). Threaded onto every socket's handler context so the
   * central WS session-write gate enforces operator-only actions. The SAME
   * frozen values the REST + send-seam gates read. Unset/empty → operator-only
   * enforcement is INERT; flag OFF → the gate no-ops entirely.
   */
  operatorUsers?: string[],
  /**
   * Stream-2 D: the shared bounded-cell (N=2) admission tracker. The SAME
   * instance passed to the REST gate policy in `server.ts`, so WS + REST bound a
   * session to 2 distinct humans from ONE source. Threaded onto every socket's
   * handler context (the WS gate consults it) and freed here on last-socket-leave
   * + session removal. Unset → admission SKIPPED (byte-unchanged).
   */
  operatorSet?: import("./operator-set-tracker.js").OperatorSetTracker,
  /** Optional direct-dashboard guest→cell boundary. */
  cellAccess?: CellAccessController,
  /** Read-only assistant-message rendering service. */
  translator?: DashboardTranslator,
): BrowserGateway {
  // perMessageDeflate enabled: the sessions_snapshot frame is ~345 KB uncompressed
  // at ~380 sessions and re-ships on every (re)connect; gzip of the identical payload
  // is ~46 KB (7.4× smaller). Compression cost is on the server CPU, not the mobile
  // client. Diagnostic 2026-06-07 perMessageDeflate lever (§4.3/§5.2).
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024, // only compress frames >1 KB (skip tiny control frames)
    },
  });

  // Track subscriptions: ws → Set<sessionId>
  const subscriptions = new Map<WebSocket, Set<string>>();
  // Build 0 (PRINCIPAL-CAPTURE): bind the verified principal captured at the
  // `/ws` upgrade to each socket. Null when single-operator mode allowed the
  // connection with no cookie. Read by handlers via `ctx.principal` so every
  // session-write derives its actor from the connection, never from the
  // message body (anti-spoof). See auth-merge contract invariant #2.
  const principals = new Map<WebSocket, TokenPayload | null>();
  // Principal-filtered session ids currently projected to each browser. Needed
  // so a later session_removed can clear a row after the manager binding is gone.
  const visibleSessionIds = new Map<WebSocket, Set<string>>();
  // Track which sessions are mid-replay per WebSocket (suppress live events)
  const replayingSessions = new Map<WebSocket, Set<string>>();
  // Per-browser delivery dedupe. Persisted entry ids are immutable, so one
  // result per (session, entry) is sufficient even when replay batches overlap.
  const translationDeliveries = new WeakMap<WebSocket, Set<string>>();
  // Stage-1 gate: one enabled session per browser. Missing entry = OFF.
  const translationEnabledSessions = new WeakMap<WebSocket, string>();

  // Track headless child processes with sessionId linkage
  const headlessPidRegistry = createHeadlessPidRegistry();

  // Track which browser is viewing which session (for unread state machine).
  // See change: session-card-unread-stripes.
  const viewedSessionTracker = createViewedSessionTracker();

  // SURFACE B: per-PRINCIPAL presence (dedup tabs by sub) for presence-of-two.
  // Separate from viewedSessionTracker (which is per-WebSocket + anonymous) to
  // keep the unread/push contract unpolluted. See session-presence-tracker.ts.
  const sessionPresenceTracker = createSessionPresenceTracker();

  /**
   * Build the additive `presence_update` payload for a session: distinct human
   * co-drivers (deduped per principal) + any agent participant from the
   * greenfield NO-OP interface (`getAgentPresence` → null today).
   */
  function buildPresenceParticipants(sessionId: string) {
    const humans = sessionPresenceTracker.humansOf(sessionId);
    const agent = getAgentPresence(sessionId);
    return agent ? [...humans, agent] : humans;
  }

  /** Emit `presence_update` to a session's subscribers (additive, on change). */
  function emitPresenceUpdate(sessionId: string) {
    const participants = buildPresenceParticipants(sessionId);
    for (const ws of getSubscribers(sessionId)) {
      sendTo(ws, { type: "presence_update", sessionId, participants });
    }
  }

  // Track pending interactive UI requests per session for replay on reconnect
  const pendingUiRequests = new Map<string, Map<string, { requestId: string; method: string; params: Record<string, unknown> }>>();

  // Track pending PromptBus requests per session for replay on browser refresh
  const pendingPromptRequests = new Map<string, Map<string, Record<string, unknown>>>();

  // Track pending auto-resume prompts for ended sessions
  const pendingResumeRegistry = createPendingResumeRegistry({
    onTimeout(oldSessionId) {
      // Clear resuming flag when resume times out
      sessionManager.update(oldSessionId, { resuming: false });
      broadcast({ type: "session_updated", sessionId: oldSessionId, updates: { resuming: false } });
    },
  });

  /** Send any pending interactive UI requests to a specific browser socket */
  function replayPendingUiRequests(ws: WebSocket, sessionId: string) {
    const sessionPending = pendingUiRequests.get(sessionId);
    if (sessionPending) {
      for (const req of sessionPending.values()) {
        sendTo(ws, {
          type: "extension_ui_request",
          sessionId,
          requestId: req.requestId,
          method: req.method,
          params: req.params,
        });
      }
    }
    // Also replay pending PromptBus requests
    const sessionPrompts = pendingPromptRequests.get(sessionId);
    if (sessionPrompts) {
      for (const msg of sessionPrompts.values()) {
        sendTo(ws, msg as any);
      }
    }
  }

  function trackUiRequest(sessionId: string, requestId: string, method: string, params: Record<string, unknown>): boolean | void {
    let sessionMap = pendingUiRequests.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      pendingUiRequests.set(sessionId, sessionMap);
    }
    const title = params.title;
    if (title !== undefined) {
      for (const existing of sessionMap.values()) {
        if (existing.method === method && existing.params.title === title) {
          return false;
        }
      }
    }
    sessionMap.set(requestId, { requestId, method, params });
    return true;
  }

  function trackPromptRequest(sessionId: string, msg: Record<string, unknown>): void {
    let sessionMap = pendingPromptRequests.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      pendingPromptRequests.set(sessionId, sessionMap);
    }
    const promptId = msg.promptId as string;
    if (promptId) {
      // Server-stamp arrival once so the cross-session surface can render an
      // accurate countdown to the server-enforced ask-user timeout.
      // See NOS cell cross-session-askuser-surface.
      if (typeof msg._xsFirstSeenAt !== "number") msg._xsFirstSeenAt = Date.now();
      sessionMap.set(promptId, msg);
      broadcastPendingOperatorInputs();
    }
  }

  function clearPromptRequest(sessionId: string, promptId: string): void {
    const sessionMap = pendingPromptRequests.get(sessionId);
    if (sessionMap) {
      sessionMap.delete(promptId);
      if (sessionMap.size === 0) pendingPromptRequests.delete(sessionId);
      // Broadcast-on-clear so the cross-session pointer clears across ALL
      // browsers immediately (on resolve OR default-fire), not just subscribers.
      broadcastPendingOperatorInputs();
    }
  }

  // ── Cross-session operator-input surface (NOS cross-session-askuser-surface) ──
  // Read-only POINTER set built from the live pendingPromptRequests registry —
  // covers BOTH the real ask_user tool and every ctx.ui extension capsule (both
  // travel as prompt_request). Off by default; the actual prompt still resolves
  // in its origin session (no double-fire).
  function buildPendingOperatorInputs(timeoutSec: number): PendingOperatorInput[] {
    const items: PendingOperatorInput[] = [];
    for (const [sid, prompts] of pendingPromptRequests) {
      const sessionName = sessionManager.get(sid)?.name || sid;
      for (const [promptId, msg] of prompts) {
        const prompt = (msg.prompt ?? {}) as { question?: unknown; options?: unknown };
        const question = typeof prompt.question === "string" ? prompt.question : "";
        const firstLine = question.split("\n", 1)[0] ?? "";
        const questionPreview = firstLine.length > 140 ? firstLine.slice(0, 139) + "\u2026" : firstLine;
        const options = Array.isArray(prompt.options)
          ? (prompt.options as unknown[]).filter((o): o is string => typeof o === "string")
          : [];
        const defaultLabel = options.find((o) => o.includes("[DEFAULT"));
        const firstSeenAt = typeof msg._xsFirstSeenAt === "number" ? (msg._xsFirstSeenAt as number) : Date.now();
        const deadlineAt = timeoutSec > 0 ? firstSeenAt + timeoutSec * 1000 : undefined;
        items.push({
          sessionId: sid,
          sessionName,
          promptId,
          questionPreview,
          ...(defaultLabel ? { defaultLabel } : {}),
          firstSeenAt,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        });
      }
    }
    // Soonest-deadline-first; entries without a deadline sort last.
    items.sort((a, b) => (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity));
    return items;
  }

  /**
   * True iff this socket's authenticated principal has the "operator" (admin)
   * role. When cell-access control is disabled (single-operator dashboard),
   * every socket is the operator. Multi-op: guests / anonymous are NOT operators.
   * Consumes the deployed authz (cell-access `roleForPrincipal`); does not modify it.
   */
  function isOperatorSocket(ws: WebSocket): boolean {
    if (!cellAccess?.enabled) return true;
    return cellAccess.roleForPrincipal(principals.get(ws) ?? null) === "operator";
  }

  /**
   * Broadcast the pending-operator-input snapshot ONLY to operator-role (admin)
   * browsers. In a multi-operator dashboard, guests / anonymous NEVER receive it
   * (the snapshot carries cross-operator session names + question previews — an
   * information leak if delivered to a non-admin). No-op when the feature flag is off.
   */
  function broadcastPendingOperatorInputs(): void {
    const cfg = loadConfig();
    if (!cfg.crossSessionOperatorInput?.enabled) return;
    const msg: ServerToBrowserMessage = { type: "pending_operator_inputs", items: buildPendingOperatorInputs(cfg.askUserPromptTimeoutSeconds) };
    for (const [ws] of subscriptions) {
      if (isOperatorSocket(ws)) sendTo(ws, msg);
    }
  }

  function getSubscribers(sessionId: string): WebSocket[] {
    const result: WebSocket[] = [];
    for (const [ws, subs] of subscriptions) {
      if (subs.has(sessionId) && ws.readyState === WebSocket.OPEN) {
        result.push(ws);
      }
    }
    return result;
  }

  /** Max buffered bytes per browser WebSocket before dropping messages (0 = no limit) */
  const MAX_WS_BUFFER = maxWsBufferBytes ?? 4 * 1024 * 1024; // 4MB default

  // FIX-C2 #2 (preserve-projection-after-authz): the principal filter re-fetches
  // canonical rows via getSession for security (never trusting the raw candidate).
  // Project that canonical row so bridgeConnected + endedAt-norm survive the guest/
  // cellAccess snapshot too. Annotate-only: the filter still decides visibility, so
  // this never widens a principal's visible set (the cell-access filter is untouched).
  const projectedGetSession = (id: string): DashboardSession | undefined => {
    const s = sessionManager.get(id);
    return s ? projectSession(s, (sid) => piGateway.isSessionConnected(sid)) : undefined;
  };

  function clearTranslationDeliveries(ws: WebSocket, sessionId: string): void {
    const delivered = translationDeliveries.get(ws);
    if (!delivered) return;
    for (const key of delivered) {
      if (key.startsWith(`${sessionId}:`)) delivered.delete(key);
    }
  }

  function scheduleTranslationEvents(ws: WebSocket, sessionId: string, events: DashboardEvent[]): void {
    if (!translator || translationEnabledSessions.get(ws) !== sessionId) return;
    let delivered = translationDeliveries.get(ws);
    if (!delivered) {
      delivered = new Set<string>();
      translationDeliveries.set(ws, delivered);
    }
    for (const event of events) {
      const request = extractTranslationRequest(sessionId, event);
      if (!request) continue;
      const deliveryKey = `${request.sessionId}:${request.entryId}`;
      if (delivered.has(deliveryKey)) continue;
      delivered.add(deliveryKey);
      void translator.translate(request).then((result) => {
        if (translationEnabledSessions.get(ws) !== request.sessionId) return;
        sendTo(ws, { type: "translation_result", sessionId: request.sessionId, ...result });
      }).catch((error) => {
        console.error(
          `[browser-gw] translator failed outside result contract (session=${request.sessionId} entry=${request.entryId}):`,
          error,
        );
      });
    }
  }

  function scheduleTranslations(ws: WebSocket, msg: ServerToBrowserMessage): void {
    if (msg.type === "event") {
      scheduleTranslationEvents(ws, msg.sessionId, [msg.event]);
    } else if (msg.type === "event_replay") {
      scheduleTranslationEvents(ws, msg.sessionId, msg.events.map(({ event }) => event).reverse());
    }
  }

  function sendTo(ws: WebSocket, msg: ServerToBrowserMessage, origin: "core" | "plugin" = "core") {
    if (ws.readyState !== WebSocket.OPEN) return;
    let outgoing = msg;
    if (cellAccess?.enabled) {
      let visible = visibleSessionIds.get(ws);
      if (!visible) {
        visible = new Set<string>();
        visibleSessionIds.set(ws, visible);
      }
      const filtered = filterServerMessageForPrincipal(
        msg,
        principals.get(ws) ?? null,
        cellAccess,
        projectedGetSession,
        visible,
        origin,
      );
      if (!filtered) return;
      outgoing = filtered;
    }
    // Drop messages if the send buffer is full (browser not consuming)
    if (MAX_WS_BUFFER > 0 && ws.bufferedAmount > MAX_WS_BUFFER) return;
    // Guard against V8's hard string-length cap (~512MB on 64-bit) and
    // structuredClone-style cycles, both of which throw from JSON.stringify.
    // Prior to this guard, an oversized `event_replay` payload (e.g. catch-up
    // batch for a multi-MB session) would throw `RangeError: Invalid string
    // length`. The throw escaped sendTo, was swallowed by the dashboard's
    // [crash-safety] uncaughtException handler, but left the per-WS replay
    // bookkeeping in a half-cleared state — the next subscribe re-issued the
    // same oversized replay, throwing again, in a tight reconnect loop that
    // manifested to the operator as the sidebar "reloading history forever".
    // We now drop the message + log a structured diagnostic so the operator
    // can identify the offending session for downstream pagination work.
    let payload: string;
    try {
      payload = JSON.stringify(outgoing);
    } catch (err) {
      const msgType = (outgoing as { type?: unknown } | null | undefined)?.type;
      const sessionId = (outgoing as { sessionId?: unknown } | null | undefined)?.sessionId;
      console.error(
        `[browser-gw] sendTo: JSON.stringify failed (type=${String(msgType)} sessionId=${String(sessionId)}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    ws.send(payload);
    // Original event is already on the socket before any model work starts.
    // Translation returns later as a sibling carrier and cannot delay rendering.
    scheduleTranslations(ws, outgoing);
  }

  function broadcast(msg: ServerToBrowserMessage) {
    for (const [ws] of subscriptions) {
      sendTo(ws, msg);
    }
  }

  function sendSessionsSnapshot(ws: WebSocket): void {
    const sessionsSnapshot = sessionManager
      .listAll()
      .map((s) => projectSession(s, (id) => piGateway.isSessionConnected(id)));
    const orders: Record<string, string[]> = {};
    if (sessionOrderManager) {
      for (const [cwd, sessionIds] of Object.entries(sessionOrderManager.getAllOrders())) {
        if (sessionIds.length > 0) orders[cwd] = sessionIds;
      }
    }
    sendTo(ws, { type: "sessions_snapshot", sessions: sessionsSnapshot, orders });
  }

  // Per-seam boundary (Fault B / open-risk #8): isolate + LOUD-log a browser
  // WebSocketServer-level error so it can never bubble to an uncaught exception
  // that crashes the whole server. The browser gateway is `noServer` (shares
  // fastify's port), so this is a server-fault channel, not a bind seam.
  wss.on("error", (err: Error) => {
    console.error(`[browser-gw] server error (isolated, non-fatal): ${err.message}`);
  });

  wss.on("connection", (ws, req) => {
    const remoteAddr = req?.socket?.remoteAddress ?? 'unknown';
    const origin = req?.headers?.origin ?? 'no-origin';
    const ua = req?.headers?.['user-agent'] ?? 'no-ua';
    console.error(`[browser-gw] browser client connected from ${remoteAddr} origin=${origin} ua=${ua.slice(0, 80)} (total: ${subscriptions.size + 1})`);
    const subs = new Set<string>();
    subscriptions.set(ws, subs);
    // Build 0: bind the principal captured at the `/ws` upgrade (stashed on the
    // request as `wsPrincipal`) to this socket. `undefined` (no auth secret /
    // single-operator) is normalized to `null`.
    const boundPrincipal = (req as { wsPrincipal?: TokenPayload | null } | undefined)?.wsPrincipal ?? null;
    principals.set(ws, boundPrincipal);
    visibleSessionIds.set(ws, new Set());

    // Per-socket isolation: handle 'error' so a single browser socket fault
    // (reset / abrupt close) can NEVER bubble to an uncaught exception. Tear
    // THIS socket down; every other browser client + the server survive.
    ws.on("error", (err: Error) => {
      console.error(`[browser-gw] socket error (isolated): ${err.message}`);
      try { ws.terminate(); } catch { /* already closing */ }
    });

    // Atomic snapshot of the full session registry + per-cwd orders.
    // Replaces the legacy per-session `session_added` loop and per-cwd
    // `sessions_reordered` loop. Client REPLACES (not merges) its
    // `sessions` Map and `sessionOrderMap` on receipt so stale ids from a
    // previous server lifetime are dropped atomically.
    // See change: fix-stale-sessions-on-reconnect.
    sendSessionsSnapshot(ws);

    // Send the current cross-session pending-operator-input snapshot to the
    // newly-connected browser — ONLY if it's an operator-role (admin) socket
    // (off by default). See NOS cross-session-askuser-surface.
    {
      const xsCfg = loadConfig();
      if (xsCfg.crossSessionOperatorInput?.enabled && isOperatorSocket(ws)) {
        sendTo(ws, { type: "pending_operator_inputs", items: buildPendingOperatorInputs(xsCfg.askUserPromptTimeoutSeconds) });
      }
    }

    // Send pinned directories on connect
    if (preferencesStore) {
      sendTo(ws, { type: "pinned_dirs_updated", paths: preferencesStore.getPinnedDirectories() });
    }

    // Send OpenSpec data for every known directory — exactly one
    // `openspec_update` per cwd, never silently omit.
    // See change: fix-cold-boot-openspec-protocol.
    if (directoryService) {
      for (const msg of buildOpenSpecConnectSnapshot(directoryService, hasOpenSpecDir)) {
        sendTo(ws, msg);
      }
    }

    // Send active terminals on connect
    if (terminalManager) {
      for (const terminal of terminalManager.list()) {
        sendTo(ws, { type: "terminal_added", terminal });
      }
    }

    // Notify server of new connection (for mDNS peer list etc.)
    if (gateway.onConnect) {
      gateway.onConnect(ws);
    }


    ws.on("message", async (raw) => {
      // Malformed (non-JSON) frames are silently dropped. Only frame-parse
      // errors are swallowed here — handler exceptions are logged below so
      // real bugs (e.g. node-pty spawn failures) are not silently hidden.
      let msg: BrowserToServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as BrowserToServerMessage;
      } catch {
        return;
      }
      try {
        const ctx: BrowserHandlerContext = {
          ws, sessionManager, eventStore, piGateway,
          pendingForkRegistry, sessionOrderManager, preferencesStore,
          directoryService, terminalManager,
          headlessPidRegistry, pendingResumeRegistry, pendingDashboardSpawns,
          pendingAttachRegistry,
          pendingResumeIntents,
          pendingClientCorrelations,
          pushPrefsMap,
          getPushDefaults,
          // Build 0 (PRINCIPAL-CAPTURE): the verified principal bound to THIS
          // socket + the multi-operator gate flag. Handlers derive the actor
          // from `ctx.principal` (never the message body). See auth-merge
          // contract invariants #1, #2.
          principal: principals.get(ws) ?? null,
          requireBrowserAuth,
          ...(operatorUsers ? { operatorUsers } : {}),
          ...(operatorSet ? { operatorSet } : {}),
          ...(cellAccess ? { cellAccess } : {}),
          sendTo, broadcast, getSubscribers, replayPendingUiRequests,
          trackUiRequest: trackUiRequest,
          markReplaying(targetWs, sessionId) {
            let set = replayingSessions.get(targetWs);
            if (!set) { set = new Set(); replayingSessions.set(targetWs, set); }
            set.add(sessionId);
          },
          clearReplaying(targetWs, sessionId, lastReplayedSeq) {
            const set = replayingSessions.get(targetWs);
            if (set) {
              set.delete(sessionId);
              if (set.size === 0) replayingSessions.delete(targetWs);
            }
            // Send catch-up: any events after lastReplayedSeq
            if (lastReplayedSeq > 0) {
              const catchUp = eventStore.getEvents(sessionId, lastReplayedSeq + 1);
              if (catchUp.length > 0) {
                sendTo(targetWs, {
                  type: "event_replay",
                  sessionId,
                  events: catchUp.map((e) => ({ seq: e.seq, event: e.event })),
                  isLast: true,
                });
              }
            }
          },
        };

        // ── Direct guest→cell ingress boundary ──────────────────────────────
        // Runs before D admission/action classification so outside and missing
        // session ids have one observable result and never reach a handler.
        if (cellAccess?.enabled) {
          const boundary = authorizeGuestBrowserMessage(
            msg,
            ctx.principal,
            cellAccess,
            projectedGetSession,
          );
          if (!boundary.allowed) {
            console.error(
              `[browser-gw] browser message refused by cell boundary ` +
                `(type=${String((msg as any).type)}, reason=${boundary.reason})`,
            );
            // Make a refused send_prompt OBSERVABLE instead of a silent drop: the
            // operator otherwise gets zero signal why the send died (a hung
            // optimistic card) — the real defect. Emit a typed send_prompt_failed
            // carrying the boundary reason so the client can react (no-principal →
            // re-auth; session-unavailable/operator-only → a clear failed card)
            // rather than a silent strand. Only send_prompt carries a queue card.
            if ((msg as { type?: string }).type === "send_prompt") {
              const failSessionId = (msg as { sessionId?: string }).sessionId ?? "";
              const failNonce = (msg as { queueNonce?: string }).queueNonce;
              sendTo(ws, {
                type: "send_prompt_failed",
                sessionId: failSessionId,
                ...(failNonce ? { queueNonce: failNonce } : {}),
                reason: boundary.reason ?? "unauthorized",
              } as ServerToBrowserMessage);
            }
            return;
          }
        }

        // ── Build-1b WS-closure: the CENTRAL session-write gate ─────────────
        // Every browser message passes through the ONE `authorizeSessionAction`
        // chokepoint BEFORE dispatch. For a non-session-write (pass-through) or
        // when the multi-operator flag is OFF, this is a no-op and the switch
        // below runs unchanged (byte-unchanged). For a gated session-write that
        // an unauthorized actor attempted (op-2 on an operator-only action, a
        // principal-less human when the flag is ON), we REFUSE here — emit a
        // best-effort typed failure (for the message-types that carry a result
        // channel) and RETURN so the handler NEVER runs = no side effect. The
        // actor derives from the connection-bound principal, never the body
        // (anti-spoof). `send_prompt` keeps its own in-handler gate (Build 0).
        {
          const gate = authorizeWsMessage(msg, ctx);
          if (!gate.passThrough && !gate.allowed) {
            const sessionId = (msg as { sessionId?: string }).sessionId;
            console.error(
              `[browser-gw] WS ${(msg as { type?: string }).type} refused by auth gate` +
                ` (action=${gate.action}, reason=${gate.reason}` +
                (sessionId ? `, session=${sessionId}` : "") + ")",
            );
            // Best-effort typed failure on the message-types that have a result
            // channel; the load-bearing invariant is the suppressed side effect,
            // the notification is secondary.
            const requestId = (msg as { requestId?: string }).requestId;
            switch ((msg as { type?: string }).type) {
              case "resume_session":
                sendTo(ws, { type: "resume_result", sessionId: sessionId ?? "", success: false, message: "unauthorized", ...(requestId ? { requestId } : {}) } as any);
                break;
              case "spawn_session":
                sendTo(ws, { type: "spawn_result", cwd: (msg as { cwd?: string }).cwd ?? "", success: false, message: "unauthorized", ...(requestId ? { requestId } : {}) } as any);
                break;
              case "force_kill":
                sendTo(ws, { type: "force_kill_result", sessionId: sessionId ?? "", success: false, message: "unauthorized" } as any);
                break;
              default:
                // shutdown / abort / flow_control / kill_process / rename /
                // hide / unhide / attach- / detach-proposal / set_model /
                // set_thinking_level / role_set / flow_management /
                // role_preset_save|delete|load have no result channel — refusal
                // is silent-but-logged; the side effect is suppressed.
                break;
            }
            return;
          }
        }

        switch (msg.type) {
          case "ping":
            // Client keep-alive ping (added 2026-05-30 for iOS Safari background-tab
            // WebSocket idle-kill mitigation; iOS Safari closes idle WS after
            // ~30-60s without traffic, regardless of TCP-level keepalive).
            // Server responds with pong; client tracks pong receipt as liveness
            // signal. Sister-shape to pi-gateway.ts WS_PING_INTERVAL discipline
            // (cell→server tier) extended to browser→server tier.
            sendTo(ws, { type: "pong" } as any);
            break;
          case "subscribe":
            handleSubscribe(msg, subs, ctx);
            break;
          case "unsubscribe":
            subs.delete(msg.sessionId);
            if (translationEnabledSessions.get(ws) === msg.sessionId) {
              translationEnabledSessions.delete(ws);
              clearTranslationDeliveries(ws, msg.sessionId);
            }
            break;
          case "set_session_translation": {
            if (!subs.has(msg.sessionId)) break;
            const current = translationEnabledSessions.get(ws);
            if (msg.enabled) {
              if (current && current !== msg.sessionId) clearTranslationDeliveries(ws, current);
              translationEnabledSessions.set(ws, msg.sessionId);
              if (current !== msg.sessionId) clearTranslationDeliveries(ws, msg.sessionId);
              const events = eventStore.getEvents(msg.sessionId, 1).map(({ event }) => event).reverse();
              scheduleTranslationEvents(ws, msg.sessionId, events);
            } else if (current === msg.sessionId) {
              translationEnabledSessions.delete(ws);
              clearTranslationDeliveries(ws, msg.sessionId);
            }
            break;
          }
          case "send_prompt":
            await handleSendPrompt(msg, ctx);
            break;
          case "abort":
            handleAbort(msg, ctx);
            break;
          case "force_kill":
            await handleForceKill(msg, ctx);
            break;
          case "flow_control":
            handleFlowControl(msg, ctx);
            break;
          case "kill_process":
            handleKillProcess(msg, ctx);
            break;
          case "shutdown":
            handleShutdown(msg, ctx);
            break;
          case "rename_session":
            handleRenameSession(msg, ctx);
            break;
          case "hide_session":
            handleHideSession(msg, ctx);
            break;
          case "unhide_session":
            handleUnhideSession(msg, ctx);
            break;
          case "attach_proposal":
            handleAttachProposal(msg, ctx);
            break;
          case "detach_proposal":
            handleDetachProposal(msg, ctx);
            break;
          case "fetch_content":
            handleFetchContent(msg, ctx);
            break;
          case "list_sessions":
            handleListSessions(msg, ctx);
            break;
          case "resume_session":
            await handleResumeSession(msg, ctx);
            break;
          case "spawn_session":
            await handleSpawnSession(msg, ctx);
            break;
          case "reorder_sessions":
            handleReorderSessions(msg, ctx);
            break;
          case "pin_directory":
            handlePinDirectory(msg, ctx);
            break;
          case "unpin_directory":
            handleUnpinDirectory(msg, ctx);
            break;
          case "reorder_pinned_dirs":
            handleReorderPinnedDirs(msg, ctx);
            break;
          case "openspec_refresh":
            handleOpenSpecRefresh(msg, ctx);
            break;
          case "openspec_bulk_archive":
            handleOpenSpecBulkArchive(msg, ctx);
            break;
          case "extension_ui_response": {
            // Clear pending UI request tracking
            const sessionMap = pendingUiRequests.get(msg.sessionId);
            if (sessionMap) {
              sessionMap.delete(msg.requestId);
              if (sessionMap.size === 0) pendingUiRequests.delete(msg.sessionId);
            }
            handleExtensionUiResponse(msg, ctx);
            break;
          }

          case "prompt_response": {
            // Route PromptBus response from browser to extension.
            // BA-2 COVER (multi-operator, Surface A): reconstruct the forwarded
            // object FIELD-BY-FIELD — never a wholesale `msg as any` spread (the
            // anti-spoof hole: a spread would let a client-forged `author`/
            // identity field ride through to the extension). The pure helper
            // preserves the functional PromptBus round-trip fields (sessionId,
            // promptId, answer, cancelled, source — consumed by
            // promptBus.respond) and stamps the `author` SERVER-SIDE from the
            // connection-bound principal (`principals.get(ws)`), NEVER from the
            // message body. Delivery is unaffected: the answer still reaches
            // PromptBus.respond.
            // The forwarded value is an OBJECT LITERAL with a static
            // `type: "prompt_response"` (spreading the field-by-field helper) so
            // the Build-1b WS-coverage AST classifies this carrier by its static
            // channel — it never forwards a browser-chosen/dynamic payload type.
            const pr = msg as import("@blackbelt-technology/pi-dashboard-shared/browser-protocol.js").PromptResponseBrowserMessage;
            ctx.piGateway.sendToSession(pr.sessionId, {
              ...buildPromptResponseForward(pr, principals.get(ws) ?? null, operatorUsers),
              type: "prompt_response",
            });
            break;
          }

          case "prompt_rendered": {
            // A1 render-lifecycle ACK browser→extension (Pete dl-13358 B2).
            // Operator-only: the central gate above already refused a guest /
            // no-principal, so reaching here means an authenticated operator.
            // Field-by-field static forward (static `type` for the WS-coverage
            // AST) + the SERVER-STAMPED operator author (from ctx.principal,
            // NEVER the message body). The bridge calls markRendered only for an
            // authored ACK and threads the author into receipt.renderedBy (the
            // RENDERER identity — distinct from receipt.author, the responder).
            const rr = msg as import("@blackbelt-technology/pi-dashboard-shared/browser-protocol.js").PromptRenderedBrowserMessage;
            const renderedAuthor = deriveAuthor(principals.get(ws) ?? null, operatorUsers);
            ctx.piGateway.sendToSession(rr.sessionId, {
              type: "prompt_rendered",
              sessionId: rr.sessionId,
              promptId: rr.promptId,
              ...(renderedAuthor ? { author: renderedAuthor } : {}),
            });
            break;
          }

          case "flow_management": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "flow_management",
              sessionId: msg.sessionId,
              action: msg.action,
              flowName: msg.flowName,
              task: msg.task,
              description: msg.description,
            });
            break;
          }
          case "architect_prompt_response": {
            // Legacy: now handled by prompt_response via PromptBus.
            // Keep case to avoid "unhandled message" warnings from old clients.
            break;
          }
          case "role_set": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "role_set",
              sessionId: msg.sessionId,
              role: (msg as any).role,
              modelId: (msg as any).modelId,
            });
            break;
          }
          case "role_preset_load": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "role_preset_load",
              sessionId: msg.sessionId,
              presetName: (msg as any).presetName,
            });
            break;
          }
          case "role_preset_save": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "role_preset_save",
              sessionId: msg.sessionId,
              presetName: (msg as any).presetName,
            });
            break;
          }
          case "role_preset_delete": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "role_preset_delete",
              sessionId: msg.sessionId,
              presetName: (msg as any).presetName,
            });
            break;
          }
          case "request_roles": {
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "request_roles",
              sessionId: msg.sessionId,
            });
            break;
          }
          case "ui_management": {
            // Extension UI System (Phase 1): forward browser action / data
            // request to the bridge unchanged. The bridge re-emits on
            // pi.events; the extension replies via ui_data_list (round-trip
            // handled in event-wiring).
            // See change: add-extension-ui-modal.
            ctx.piGateway.sendToSession(msg.sessionId, {
              type: "ui_management",
              sessionId: msg.sessionId,
              action: msg.action,
              event: msg.event,
              params: msg.params,
            });
            break;
          }
          case "create_terminal":
            handleCreateTerminal(msg, ctx);
            break;
          case "kill_terminal":
            handleKillTerminal(msg, ctx);
            break;
          case "rename_terminal":
            handleRenameTerminal(msg, ctx);
            break;
          case "session_view": {
            // Browser declares it is currently displaying this session.
            // Track the (sessionId, ws) pair AND clear `unread` if set.
            // See change: session-card-unread-stripes.
            viewedSessionTracker.view(msg.sessionId, ws);
            // SURFACE B: record per-principal presence. Always send the
            // current set to the entering socket (so a freshly-opened tab is
            // initialized), and broadcast to the OTHER subscribers only when a
            // NEW distinct human appeared (dedup same-human tabs → no spam).
            const viewer = principals.get(ws) ?? null;
            const presencePrincipal = viewer
              ? { sub: viewer.sub, display: deriveAuthor(viewer, operatorUsers)?.display ?? viewer.sub }
              : null;
            const distinctChanged = sessionPresenceTracker.enter(msg.sessionId, ws, presencePrincipal);
            sendTo(ws, {
              type: "presence_update",
              sessionId: msg.sessionId,
              participants: buildPresenceParticipants(msg.sessionId),
            });
            if (distinctChanged) {
              for (const other of getSubscribers(msg.sessionId)) {
                if (other !== ws) {
                  sendTo(other, {
                    type: "presence_update",
                    sessionId: msg.sessionId,
                    participants: buildPresenceParticipants(msg.sessionId),
                  });
                }
              }
            }
            const session = sessionManager.get(msg.sessionId);
            if (session?.unread) {
              sessionManager.update(msg.sessionId, { unread: false });
              broadcast({
                type: "session_updated",
                sessionId: msg.sessionId,
                updates: { unread: false },
              });
            }
            // Clear the unseen-server-error fleet bit on view: the operator is
            // now looking at the session (the transcript still shows the error,
            // but the fleet no longer needs to escalate it). Independent of
            // `unread` — an error can outlive an acknowledged unread and vice
            // versa. See change: build-2-dashboard-v3.
            if (session?.unseenServerError) {
              sessionManager.update(msg.sessionId, { unseenServerError: false });
              broadcast({
                type: "session_updated",
                sessionId: msg.sessionId,
                updates: { unseenServerError: false },
              });
            }
            break;
          }
          case "session_unview": {
            viewedSessionTracker.unview(msg.sessionId, ws);
            // SURFACE B: drop this socket from presence; emit on real change.
            // Stream-2 D (fix-1 MAJOR-1): un-VIEWing does NOT free the operator
            // slot — admission is WRITE-based, not view-based. A human who
            // navigates away but keeps a socket open can still co-drive (another
            // tab / REST), so releasing on unview would let a 3rd human bump a
            // still-connected co-driver. The slot frees on LAST-socket-close
            // (see `ws.on("close")`), not on view-change. Presence (view-based
            // by design) still updates here.
            if (sessionPresenceTracker.leave(msg.sessionId, ws)) {
              emitPresenceUpdate(msg.sessionId);
            }
            break;
          }
          case "set_push_prefs": {
            if (pushPrefsMap && msg.prefs?.notifyCompletion && ["off", "on", "auto"].includes(msg.prefs.notifyCompletion)) {
              pushPrefsMap.set(msg.sessionId, { notifyCompletion: msg.prefs.notifyCompletion as "off" | "on" | "auto" });
              broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { pushPrefs: pushPrefsMap.get(msg.sessionId) } } as any);
            }
            break;
          }
          default:
            // Forward simple pi-gateway commands
            handlePiGatewayForward(msg, ctx);
            break;
        }
      } catch (err) {
        const type = (msg as { type?: string } | undefined)?.type ?? "unknown";
        console.error(
          `[browser-gw] handler error type=${type}:`,
          err,
        );
        // Connection intentionally remains open so subsequent messages are still processed.
      }
    });

    ws.on("close", () => {
      console.error(`[browser-gw] browser client disconnected (remaining: ${subscriptions.size - 1})`);
      subscriptions.delete(ws);
      replayingSessions.delete(ws);
      visibleSessionIds.delete(ws);
      // Stream-2 D: capture this socket's `sub` BEFORE dropping the principal, so
      // the operator-cell release below (keyed by `sub`) can free the slot.
      const closingSub = principals.get(ws)?.sub;
      // Build 0: drop the bound principal so a closed socket holds no identity.
      principals.delete(ws);
      // Drop this ws from every viewed-session entry so disconnected browsers
      // don't hold sessions in the viewed state. See change: session-card-unread-stripes.
      viewedSessionTracker.unviewAll(ws);
      // SURFACE B: drop this socket from per-principal presence; emit
      // presence_update to remaining subscribers for each session whose
      // distinct-human set changed (this human's LAST tab just closed).
      for (const sessionId of sessionPresenceTracker.removeSocket(ws)) {
        emitPresenceUpdate(sessionId);
      }
      // Stream-2 D (fix-1 MAJOR-1): free the operator-cell slot on LAST-socket
      // close, INDEPENDENT of the presence-view path. A human admitted by a WRITE
      // (send_prompt / abort) without ever `session_view`-ing is invisible to the
      // presence tracker, so releasing off `removeSocket` alone leaks the slot and
      // a departed co-driver permanently locks out a legitimate 2nd operator.
      // Guard on last-socket (scan the remaining principals for another live tab
      // of the SAME `sub`) so one of two tabs closing does NOT free the slot; then
      // release from EVERY session this `sub` is admitted to. The pure-REST-only
      // admit (no socket ever) has no close event → still covered by the
      // `broadcastSessionRemoved`→`clearSession` leak-guard (documented residual).
      if (operatorSet && closingSub) {
        let hasOtherSocket = false;
        for (const p of principals.values()) {
          if (p?.sub === closingSub) { hasOtherSocket = true; break; }
        }
        if (!hasOtherSocket) {
          for (const sessionId of operatorSet.sessionsAdmitted(closingSub)) {
            operatorSet.release(sessionId, closingSub);
          }
        }
      }
    });
  });

  const gateway: BrowserGateway = {
    wss,

    sendToClient(ws: WebSocket, msg: ServerToBrowserMessage) {
      sendTo(ws, msg);
    },

    broadcast(msg: ServerToBrowserMessage) {
      broadcast(msg);
    },

    broadcastPluginMessage(msg: unknown) {
      for (const [ws] of subscriptions) sendTo(ws, msg as ServerToBrowserMessage, "plugin");
    },

    refreshAccessSnapshots() {
      for (const [ws] of subscriptions) sendSessionsSnapshot(ws);
    },

    broadcastEvent(sessionId: string, seq: number, event: any) {
      const subscribers = getSubscribers(sessionId);
      const msg: ServerToBrowserMessage = {
        type: "event",
        sessionId,
        seq,
        event,
      };
      for (const ws of subscribers) {
        // Skip WebSockets that are mid-replay for this session
        const replaying = replayingSessions.get(ws);
        if (replaying?.has(sessionId)) continue;
        sendTo(ws, msg);
      }
    },

    broadcastSessionAdded(session: any, opts?: { spawnRequestId?: string }) {
      // Carry the originating client `requestId` (when known) so the
      // browser can auto-select / dismiss its placeholder by exact
      // correlation. See change: spawn-correlation-token.
      broadcast({
        type: "session_added",
        session: projectSession(session, (id) => piGateway.isSessionConnected(id)),
        ...(opts?.spawnRequestId ? { spawnRequestId: opts.spawnRequestId } : {}),
      });
    },

    broadcastSessionUpdated(sessionId: string, updates: any) {
      // FIX-C2/C3 on the live-update path: carry the current bridgeConnected
      // oracle (ordered — isSessionConnected reflects the post-mutation connection
      // map) + normalize endedAt ⟹ ended so a close that stamps endedAt can never
      // leave the client rendering the row active.
      const endedAt = updates.endedAt !== undefined ? updates.endedAt : sessionManager.get(sessionId)?.endedAt;
      const projected = {
        ...updates,
        bridgeConnected: piGateway.isSessionConnected(sessionId),
        ...(endedAt != null ? { status: "ended" } : {}),
      };
      broadcast({ type: "session_updated", sessionId, updates: projected });
    },

    broadcastSessionRemoved(sessionId: string) {
      // Stream-2 D: leak guard — drop the whole bounded cell on session removal
      // so a REST-only admit (no persistent socket, never freed by socket-leave)
      // cannot permanently hold a slot on an ended session.
      operatorSet?.clearSession(sessionId);
      broadcast({ type: "session_removed", sessionId });
    },

    broadcastSessionStateReset(sessionId: string) {
      const subscribers = getSubscribers(sessionId);
      const msg: ServerToBrowserMessage = { type: "session_state_reset", sessionId };
      for (const ws of subscribers) {
        sendTo(ws, msg);
      }
    },

    sendToSubscribers(sessionId: string, msg: ServerToBrowserMessage) {
      const subscribers = getSubscribers(sessionId);
      for (const ws of subscribers) {
        sendTo(ws, msg);
      }
    },

    broadcastToAll(msg: ServerToBrowserMessage) {
      broadcast(msg);
    },

    getSubscriberCount(sessionId: string): number {
      return getSubscribers(sessionId).length;
    },

    trackUiRequest,

    clearUiRequest(sessionId: string, requestId: string) {
      const sessionMap = pendingUiRequests.get(sessionId);
      if (sessionMap) {
        sessionMap.delete(requestId);
        if (sessionMap.size === 0) {
          pendingUiRequests.delete(sessionId);
        }
      }
    },

    trackPromptRequest,
    clearPromptRequest,

    shutdownHeadlessProcesses() {
      headlessPidRegistry.killAll();
    },

    headlessPidRegistry,

    pendingResumeRegistry,

    viewedSessionTracker,
  };

  return gateway;
}
