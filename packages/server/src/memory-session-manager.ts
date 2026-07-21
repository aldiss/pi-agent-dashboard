/**
 * Pure in-memory session registry.
 * Replaces SQLite-backed session-manager.ts.
 */
import type { DashboardSession, SessionSource, SessionStatus } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { Audience } from "@blackbelt-technology/pi-dashboard-shared/vendor/operator-voice-audience/audience-core.js";

export interface RegisterSessionParams {
  id: string;
  cwd: string;
  name?: string;
  source: SessionSource;
  model?: string;
  thinkingLevel?: string;
  sessionFile?: string;
  sessionDir?: string;
  firstMessage?: string;
  startedAt?: number;
  pid?: number;
  /**
   * Why the bridge is registering this session. Forwarded from the
   * `session_register` protocol message (see
   * `SessionRegisterMessage.registerReason`). Used by `onChange` to
   * decide whether to apply the configured `reattachPlacement` policy.
   * See change: reattach-move-to-front.
   */
  registerReason?: "spawn" | "reattach";
}

export interface OnChangeContext {
  /**
   * Set when `onChange` is fired from `register(...)` and the inbound
   * params carried a `registerReason`. Undefined for `update`/`unregister`
   * paths and for legacy registers without the field.
   * See change: reattach-move-to-front.
   */
  registerReason?: "spawn" | "reattach";
  /**
   * The session's status BEFORE `register(...)` overwrote it to `"active"`.
   * Captured because `register()` unconditionally sets `status: "active"`,
   * which would otherwise hide a `"streaming"` reattach from policies
   * that gate on streaming. Undefined for first-ever registers and for
   * `update`/`unregister` paths.
   * See change: reattach-move-to-front.
   */
  priorStatus?: SessionStatus;
}

export interface SessionManager {
  register(params: RegisterSessionParams): DashboardSession;
  /** Restore a previously persisted session (e.g. on startup). Does not trigger onChange. */
  restore(session: DashboardSession): void;
  unregister(sessionId: string): void;
  update(sessionId: string, updates: Partial<DashboardSession>): void;
  get(sessionId: string): DashboardSession | undefined;
  listActive(): DashboardSession[];
  listAll(): DashboardSession[];
  /** Called after any mutation (register, unregister, update). Receives the affected session ID and optional context. */
  onChange?: (sessionId: string, ctx?: OnChangeContext) => void;
  /** Called after a session is unregistered (status set to ended). */
  onUnregister?: (sessionId: string) => void;
}

/**
 * Optional dependencies for the session manager. `deriveAudience` (door-3 Item 1)
 * is injected from `audience-registry.ts` so the pure manager stays FS-decoupled
 * while still stamping the server-derived audience at the register/restore
 * choke-point. See change: operator-voice-buffer-hold.
 */
export interface SessionManagerDeps {
  deriveAudience?: (name: string | undefined, source: string | undefined) => Audience;
}

export function createMemorySessionManager(deps: SessionManagerDeps = {}): SessionManager {
  const sessions = new Map<string, DashboardSession>();

  const mgr: SessionManager = {
    register(params: RegisterSessionParams): DashboardSession {
      // Preserve accumulated data (tokens, cost) from a prior session with the
      // same ID (e.g. restored after server restart). Git and openspec data are
      // polled by the bridge extension shortly after reconnect, so they don't
      // need to be carried over.
      const existing = sessions.get(params.id);
      const priorStatus = existing?.status;

      const session: DashboardSession = {
        // Carry over accumulated data from the existing session (e.g. restored after restart)
        ...(existing ? {
          tokensIn: existing.tokensIn,
          tokensOut: existing.tokensOut,
          cacheRead: existing.cacheRead,
          cacheWrite: existing.cacheWrite,
          cost: existing.cost,
          // Preserve user-set openspec assignment (not polled, set via dashboard UI)
          attachedProposal: existing.attachedProposal,
          // Preserve context usage until bridge sends fresh data
          contextTokens: existing.contextTokens,
          contextWindow: existing.contextWindow,
        } : {
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
        }),
        // Apply registration params (always override)
        id: params.id,
        cwd: params.cwd,
        name: params.name ?? existing?.name,
        source: params.source,
        // door-3 (Item 1): stamp the server-derived audience at the register
        // choke-point so LIVE bridge-registered sessions buffer from the first
        // operator turn. See change: operator-voice-buffer-hold.
        audience: deps.deriveAudience?.(params.name ?? existing?.name, params.source),
        status: "active",
        model: params.model,
        thinkingLevel: params.thinkingLevel,
        startedAt: params.startedAt ?? existing?.startedAt ?? Date.now(),
        endedAt: undefined,
        sessionFile: params.sessionFile,
        sessionDir: params.sessionDir,
        hidden: false,
        firstMessage: params.firstMessage ?? existing?.firstMessage,
        dataUnavailable: false,
        pid: params.pid,
      };
      sessions.set(params.id, session);
      mgr.onChange?.(params.id, {
        registerReason: params.registerReason,
        priorStatus,
      });
      return session;
    },

    restore(session: DashboardSession): void {
      // door-3 (Item 1): a reconstructed session built inline (session-bootstrap)
      // carries no audience — derive it here. A scanned session already has it
      // (sessionFromMeta); keep that value. See change: operator-voice-buffer-hold.
      if (session.audience === undefined && deps.deriveAudience) {
        session.audience = deps.deriveAudience(session.name, session.source);
      }
      sessions.set(session.id, session);
    },

    unregister(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) {
        session.status = "ended";
        session.endedAt = Date.now();
        mgr.onChange?.(sessionId);
        mgr.onUnregister?.(sessionId);
      }
    },

    update(sessionId: string, updates: Partial<DashboardSession>): void {
      const session = sessions.get(sessionId);
      if (session) {
        Object.assign(session, updates);
        mgr.onChange?.(sessionId);
      }
    },

    get(sessionId: string): DashboardSession | undefined {
      return sessions.get(sessionId);
    },

    listActive(): DashboardSession[] {
      return Array.from(sessions.values()).filter((s) => s.status !== "ended");
    },

    listAll(): DashboardSession[] {
      return Array.from(sessions.values());
    },
  };

  return mgr;
}
