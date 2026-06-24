/**
 * Pure in-memory session registry.
 * Replaces SQLite-backed session-manager.ts.
 */
import type { DashboardSession, SessionSource, SessionStatus } from "@blackbelt-technology/pi-dashboard-shared/types.js";

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

/**
 * Outcome of a guarded `restore()` call. `applied` is false only when the
 * guard refused to overwrite a live/active row. `reason` records which arm
 * of invariant I5 fired so a runtime rescan can emit the §4 step-event
 * (`row_merged{absent|existing-ended}` vs `row_skipped{live-active-guard}`).
 * See change: handover-reliability-wi1 (invariant I5).
 */
export interface RestoreResult {
  applied: boolean;
  reason: "absent" | "existing-ended" | "live-active-guard";
}

export interface SessionManager {
  register(params: RegisterSessionParams): DashboardSession;
  /**
   * Guarded-merge restore of a previously persisted/scanned session.
   * Does not trigger onChange.
   *
   * Invariant I5 (load-bearing): restores into the map ONLY IF the id is
   * ABSENT or the existing row is already `ended`. A live/active row is
   * NEVER overwritten — the scanned snapshot is always staler than the live
   * bridge-fed row, so clobbering it would regress active/name/order/hidden/
   * unread state. This makes acceptance-#4 (no-regression) structurally safe,
   * not merely tested-safe. At boot the map is empty so every restore applies
   * (no behavior change); the guard only bites on the post-boot rescan path.
   * See change: handover-reliability-wi1.
   */
  restore(session: DashboardSession): RestoreResult;
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

export function createMemorySessionManager(): SessionManager {
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

    restore(session: DashboardSession): RestoreResult {
      // Invariant I5 — guarded merge. Never clobber a live/active row with a
      // staler scanned snapshot. Restore only when the id is absent or the
      // existing row is already ended. See change: handover-reliability-wi1.
      const existing = sessions.get(session.id);
      if (existing && existing.status !== "ended") {
        return { applied: false, reason: "live-active-guard" };
      }
      sessions.set(session.id, session);
      return { applied: true, reason: existing ? "existing-ended" : "absent" };
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
