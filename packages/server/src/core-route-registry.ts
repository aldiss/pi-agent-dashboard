import { cellHttpRouteKey } from "./cell-access-http.js";

/**
 * Ownership ledger for reserved/core HTTP route names.
 *
 * The HTTP cell gate trusts a route as "core-owned" (and therefore eligible to
 * be safe-public / health / service-only) only when core registration proves it
 * owns the exact method+path. Plugins load AFTER core, so a route observed after
 * {@link CoreRouteRegistry.freezeCore} is plugin-owned. A plugin that registers
 * the SAME method+path as a core route (Fastify permits this via differing
 * route constraints) must NOT inherit core ownership by colliding on the
 * forgeable method+path key — such a collision revokes the core claim.
 */
export interface CoreRouteRegistry {
  /** Observe a registered route (called from a Fastify `onRoute` hook). */
  observe(method: string, url: string): void;
  /** Close the core window. Subsequent {@link observe} calls are plugin routes. */
  freezeCore(): void;
  /** True only when the exact method+route is core-owned and uncontested. */
  isCoreRoute(method: string, route: string): boolean;
}

export function createCoreRouteRegistry(): CoreRouteRegistry {
  const core = new Set<string>();
  const contested = new Set<string>();
  let frozen = false;

  return {
    observe(method, url) {
      const key = cellHttpRouteKey(String(method), url);
      if (!frozen) {
        core.add(key);
      } else if (core.has(key)) {
        // A plugin registering a core method+path after the window collides on
        // the forgeable key. Revoke the core claim so the gate fails closed.
        contested.add(key);
      }
    },
    freezeCore() {
      frozen = true;
    },
    isCoreRoute(method, route) {
      const key = cellHttpRouteKey(method, route);
      return core.has(key) && !contested.has(key);
    },
  };
}
