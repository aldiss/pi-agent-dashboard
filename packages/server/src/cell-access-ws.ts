import type {
  BrowserToServerMessage,
  ServerToBrowserMessage,
} from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TokenPayload } from "./auth.js";
import type { CellAccessController } from "./cell-access.js";

export interface BrowserCellDecision {
  allowed: boolean;
  reason?: "session-unavailable" | "operator-only" | "no-principal";
}

const GUEST_SESSION_MESSAGE_TYPES = new Set<string>([
  "subscribe",
  "unsubscribe",
  "send_prompt",
  "abort",
  "fetch_content",
  "extension_ui_response",
  "prompt_response",
  "prompt_rendered",
  "architect_prompt_response",
  "request_commands",
  "request_models",
  "request_providers",
  "request_roles",
  "ui_management",
  "session_view",
  "session_unview",
]);

const GUEST_SERVER_SESSION_TYPES = new Set<string>([
  "session_updated",
  "session_removed",
  "presence_update",
  "event",
  "event_replay",
  "commands_list",
  "flows_list",
  "extension_ui_request",
  "ui_dismiss",
  "models_list",
  "roles_list",
  "session_state_reset",
  "send_prompt_failed",
  "prompt_request",
  "prompt_dismiss",
  "prompt_cancel",
  "ui_modules_list",
  "ui_data_list",
  "ext_ui_decorator",
  "asset_register",
  "push_prefs_update",
  "process_list_update",
]);

export function authorizeGuestBrowserMessage(
  msg: BrowserToServerMessage,
  principal: TokenPayload | null,
  cellAccess: CellAccessController,
  getSession: (id: string) => DashboardSession | undefined,
): BrowserCellDecision {
  if (!cellAccess.enabled) return { allowed: true };
  if (!principal) return { allowed: false, reason: "no-principal" };
  if (!cellAccess.isPrincipalAdmitted(principal)) {
    return { allowed: false, reason: "no-principal" };
  }
  if (cellAccess.roleForPrincipal(principal) === "operator") return { allowed: true };
  const type = (msg as { type?: unknown }).type;
  if (type === "ping") return { allowed: true };
  if (typeof type !== "string" || !GUEST_SESSION_MESSAGE_TYPES.has(type)) {
    return { allowed: false, reason: "operator-only" };
  }
  const sessionId = (msg as { sessionId?: unknown }).sessionId;
  if (
    typeof sessionId !== "string"
    || !cellAccess.canViewSession(principal, getSession(sessionId))
  ) {
    return { allowed: false, reason: "session-unavailable" };
  }
  return { allowed: true };
}

function filterOrders(
  orders: Record<string, string[]>,
  visible: Set<string>,
  sessions: DashboardSession[],
): Record<string, string[]> {
  const filtered: Record<string, string[]> = {};
  const allowedCwds = new Set<string>();
  for (const session of sessions) {
    allowedCwds.add(session.cwd);
    if (session.groupCwd) allowedCwds.add(session.groupCwd);
  }
  for (const [cwd, ids] of Object.entries(orders)) {
    if (!allowedCwds.has(cwd)) continue;
    const kept = ids.filter((id) => visible.has(id));
    if (kept.length > 0) filtered[cwd] = kept;
  }
  return filtered;
}

/**
 * Final server→browser egress policy. Unknown/unscoped messages are
 * operator-only by default. Safe globals are reconstructed field-by-field.
 */
export function filterServerMessageForPrincipal(
  msg: ServerToBrowserMessage,
  principal: TokenPayload | null,
  cellAccess: CellAccessController,
  getSession: (id: string) => DashboardSession | undefined,
  visibleSessionIds: Set<string>,
  origin: "core" | "plugin" = "core",
): ServerToBrowserMessage | null {
  if (!cellAccess.enabled) return msg;
  if (!principal) return null;
  if (!cellAccess.isPrincipalAdmitted(principal)) {
    if ((msg as any)?.type === "sessions_snapshot") {
      visibleSessionIds.clear();
      return { type: "sessions_snapshot", sessions: [], orders: {} } as ServerToBrowserMessage;
    }
    return null;
  }
  if (cellAccess.roleForPrincipal(principal) === "operator") return msg;
  // Current plugin broadcast API declares no session scope. Treat every plugin
  // carrier as operator-only even if it spoofs a core type/sessionId.
  if (origin === "plugin") return null;
  const raw = msg as any;
  const type = raw?.type;

  if (type === "pong") return { type: "pong" } as ServerToBrowserMessage;

  if (type === "sessions_snapshot") {
    const canonical: DashboardSession[] = [];
    for (const candidate of Array.isArray(raw.sessions) ? raw.sessions : []) {
      const id = candidate?.id;
      const session = typeof id === "string" ? getSession(id) : undefined;
      if (session && !canonical.some((item) => item.id === session.id)) canonical.push(session);
    }
    const sessions = cellAccess.filterSessions(principal, canonical);
    visibleSessionIds.clear();
    for (const session of sessions) visibleSessionIds.add(session.id);
    return {
      type: "sessions_snapshot",
      sessions,
      orders: filterOrders(
        raw.orders && typeof raw.orders === "object" ? raw.orders : {},
        visibleSessionIds,
        sessions,
      ),
    } as ServerToBrowserMessage;
  }

  if (type === "session_added") {
    const id = raw.session?.id;
    const canonical = typeof id === "string" ? getSession(id) : undefined;
    if (!canonical || !cellAccess.canViewSession(principal, canonical)) return null;
    visibleSessionIds.add(canonical.id);
    return {
      type: "session_added",
      session: canonical,
      ...(typeof raw.spawnRequestId === "string" ? { spawnRequestId: raw.spawnRequestId } : {}),
    } as ServerToBrowserMessage;
  }

  if (type === "sessions_reordered") {
    const ids = Array.isArray(raw.sessionIds)
      ? raw.sessionIds.filter((id: unknown) => typeof id === "string" && visibleSessionIds.has(id))
      : [];
    if (ids.length === 0 || typeof raw.cwd !== "string") return null;
    const cwdAllowed = ids.some((id: string) => {
      const session = getSession(id);
      return session?.cwd === raw.cwd || session?.groupCwd === raw.cwd;
    });
    if (!cwdAllowed) return null;
    return { type: "sessions_reordered", cwd: raw.cwd, sessionIds: ids } as ServerToBrowserMessage;
  }

  const sessionId = raw?.sessionId;
  if (typeof type === "string" && GUEST_SERVER_SESSION_TYPES.has(type) && typeof sessionId === "string" && sessionId) {
    if (type === "session_removed" && visibleSessionIds.has(sessionId)) {
      visibleSessionIds.delete(sessionId);
      return { type: "session_removed", sessionId } as ServerToBrowserMessage;
    }
    if (!cellAccess.canViewSession(principal, getSession(sessionId))) return null;
    visibleSessionIds.add(sessionId);
    return msg;
  }

  // No declared session scope and not an exact safe-global carrier.
  return null;
}
