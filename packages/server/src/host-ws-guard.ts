/**
 * Host WebSocket (terminal / editor) admission guard + revocation registry.
 *
 * Two properties, both required to close B5 (revoked principal retains a
 * terminal/editor WebSocket):
 *
 *  1. Upgrade-time admission — {@link hostWsUpgradeAllowed}. A terminal/editor
 *     upgrade must consult CURRENT admission (`allowedUsers`), not only the
 *     cookie-derived operator ROLE. `operatorUsers` is frozen at startup, so a
 *     principal removed from `allowedUsers` still classifies as operator-by-role
 *     and would keep upgrading unless admission is checked live.
 *
 *  2. Close-on-revocation — {@link createHostWsRegistry}. Open host sockets are
 *     tracked by their bound principal so that when `allowedUsers` is revoked,
 *     existing sockets whose principal is no longer admitted are actively
 *     destroyed (they do not self-close on a cookie roster change).
 */
import type { TokenPayload } from "./auth.js";

/** Minimal socket surface — the raw upgrade Duplex satisfies this. */
export interface ClosableSocket {
  destroy(): void;
  on?(event: string, cb: () => void): void;
}

export interface HostWsUpgradeInput {
  /** Verified principal bound to the upgrade (null for cookie-less callers). */
  principal: Pick<TokenPayload, "sub" | "username"> | null;
  /** True when the principal's cookie role resolves to operator. */
  isOperatorRole: boolean;
  /** True when the principal is CURRENTLY admitted (live allowedUsers). */
  isAdmitted: boolean;
  /** True for a cookie-less loopback native-tooling caller (locality-admitted). */
  directLocal: boolean;
}

/**
 * Decide whether a terminal/editor WS upgrade is allowed. An operator upgrade
 * requires BOTH the operator role AND current admission; a direct-local
 * (cookie-less loopback) caller is admitted by locality.
 */
export function hostWsUpgradeAllowed(input: HostWsUpgradeInput): boolean {
  // B5: operator admission requires the operator ROLE *and* CURRENT admission.
  // `operatorUsers` is frozen at startup, so a principal removed from
  // `allowedUsers` still resolves to operator-by-role — without the admission
  // conjunct it would keep upgrading with a still-valid cookie.
  const operator = !!input.principal && input.isOperatorRole && input.isAdmitted;
  return operator || input.directLocal;
}

export interface HostWsRegistry {
  /** Track an open host socket bound to a principal. */
  register(socket: ClosableSocket, principal: Pick<TokenPayload, "sub" | "username">): void;
  /**
   * Destroy every tracked socket whose principal is no longer admitted.
   * Returns the number of sockets closed.
   */
  closeRevoked(isAdmitted: (principal: Pick<TokenPayload, "sub" | "username">) => boolean): number;
  /** Count of currently-tracked sockets (test/observability). */
  size(): number;
}

export function createHostWsRegistry(): HostWsRegistry {
  interface Entry { socket: ClosableSocket; principal: Pick<TokenPayload, "sub" | "username">; }
  const entries = new Set<Entry>();

  return {
    register(socket, principal) {
      const entry: Entry = { socket, principal };
      entries.add(entry);
      // Auto-remove when the socket closes so the set never leaks.
      socket.on?.("close", () => entries.delete(entry));
    },
    closeRevoked(isAdmitted) {
      let closed = 0;
      for (const entry of [...entries]) {
        if (!isAdmitted(entry.principal)) {
          entries.delete(entry);
          try { entry.socket.destroy(); } catch { /* already torn down */ }
          closed++;
        }
      }
      return closed;
    },
    size() {
      return entries.size;
    },
  };
}
