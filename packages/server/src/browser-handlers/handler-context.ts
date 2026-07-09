/**
 * Shared context for browser message handlers.
 * Each handler receives only what it needs via this context.
 */
import type { WebSocket } from "ws";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { SessionManager } from "../memory-session-manager.js";
import type { EventStore } from "../memory-event-store.js";
import type { PiGateway } from "../pi-gateway.js";
import type { PendingForkRegistry } from "../pending-fork-registry.js";
import type { SessionOrderManager } from "../session-order-manager.js";
import type { PreferencesStore } from "../preferences-store.js";
import type { DirectoryService } from "../directory-service.js";
import type { TerminalManager } from "../terminal-manager.js";
import type { HeadlessPidRegistry } from "../headless-pid-registry.js";
import type { PushDefaults } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { PendingResumeRegistry } from "../pending-resume-registry.js";
import type { PendingAttachRegistry } from "../pending-attach-registry.js";
import type { PendingResumeIntentRegistry } from "../pending-resume-intent-registry.js";
import type { PendingClientCorrelations } from "../pending-client-correlations.js";
import type { TokenPayload } from "../auth.js";
import type { OperatorSetTracker } from "../operator-set-tracker.js";

export interface BrowserHandlerContext {
  ws: WebSocket;
  sessionManager: SessionManager;
  eventStore: EventStore;
  piGateway: PiGateway;
  /**
   * Build 0 (PRINCIPAL-CAPTURE): the verified principal (decoded JWT) bound to
   * THIS browser connection at the `/ws` upgrade, or null. Non-null only when a
   * valid `pi_dash_token` cookie was presented. Handlers derive the session
   * actor from this — NEVER from a client-supplied field in the message body
   * (anti-spoof; the send handler reconstructs the forwarded object
   * field-by-field, never `...msg`-spread). See auth-merge contract #1, #2.
   */
  principal: TokenPayload | null;
  /**
   * Build 0 multi-operator gate flag (`auth.requireBrowserAuth`). When true the
   * central `authorizeSessionAction` gate requires a bound `human` principal
   * for session-writes. Default false → gate no-ops (single-operator,
   * byte-unchanged).
   */
  requireBrowserAuth: boolean;
  /**
   * Build 1b WS-closure: the startup-frozen operator identities
   * (`auth.operatorUsers`), threaded onto the socket context so the central WS
   * session-write gate enforces operator-only actions against the connection-
   * bound principal (never the message body). The SAME frozen values the REST +
   * send-seam gates read (no new mutable read, no desync). Unset/empty →
   * operator-only enforcement is INERT (op-1 keeps full control before op-2 is
   * admitted); flag OFF → the gate no-ops entirely.
   */
  operatorUsers?: string[];
  /**
   * Stream-2 D: the shared bounded-cell (N=2) admission tracker. The SAME
   * instance the REST arm reads, so a session is bounded to 2 distinct humans
   * from the ONE `authorizeSessionAction` chokepoint (not per-arm). Threaded
   * onto every socket's context; the WS gate passes it (+ the message's
   * `sessionId`) into the chokepoint for `human` actors. Unset → admission
   * SKIPPED (flag-off / non-multi-operator servers are byte-unchanged).
   */
  operatorSet?: OperatorSetTracker;
  pendingForkRegistry?: PendingForkRegistry;
  sessionOrderManager?: SessionOrderManager;
  preferencesStore?: PreferencesStore;
  directoryService?: DirectoryService;
  terminalManager?: TerminalManager;
  headlessPidRegistry: HeadlessPidRegistry;
  pushPrefsMap?: Map<string, import("../push/push-types.js").PushPrefs>;
  getPushDefaults?: () => PushDefaults | undefined;
  pendingResumeRegistry: PendingResumeRegistry;
  pendingDashboardSpawns?: Map<string, number>;
  /**
   * Optional pending-attach registry for spawn-with-attach flow.
   * See change: add-folder-task-checker-and-spawn-attach.
   */
  pendingAttachRegistry?: PendingAttachRegistry;
  /**
   * Optional pending-resume-intent registry. Tagged when the user clicks
   * Resume / drags-to-resume / hits the REST resume endpoint, consumed by
   * `server.ts`'s `onChange` hook in the ended→alive branch to gate the
   * sessionOrder mutation behind explicit user intent.
   * See change: preserve-session-order-on-reboot.
   */
  pendingResumeIntents?: PendingResumeIntentRegistry;
  /**
   * Optional registry mapping `spawnToken → requestId` for client-side
   * correlation. When set, browser-initiated spawns/resumes that carry a
   * `requestId` are recorded so the eventual `session_added` broadcast
   * carries `spawnRequestId` for auto-select / placeholder dismissal.
   * See change: spawn-correlation-token.
   */
  pendingClientCorrelations?: PendingClientCorrelations;
  /** Send message to a specific WebSocket */
  sendTo(ws: WebSocket, msg: ServerToBrowserMessage): void;
  /** Broadcast to all connected browsers */
  broadcast(msg: ServerToBrowserMessage): void;
  /** Get subscribers for a session */
  getSubscribers(sessionId: string): WebSocket[];
  /** Track UI request */
  trackUiRequest(sessionId: string, requestId: string, method: string, params: Record<string, unknown>): boolean | void;
  /** Replay pending UI requests to a browser */
  replayPendingUiRequests(ws: WebSocket, sessionId: string): void;
  /** Mark a session as mid-replay for a specific WebSocket (suppresses live events) */
  markReplaying(ws: WebSocket, sessionId: string): void;
  /** Clear replay flag and send catch-up events */
  clearReplaying(ws: WebSocket, sessionId: string, lastReplayedSeq: number): void;
}
