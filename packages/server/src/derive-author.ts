/**
 * Server-side author derivation (multi-operator, Surface A — attribution).
 *
 * Maps the connection-bound principal (`ctx.principal`, Build 0
 * PRINCIPAL-CAPTURE) to the STRUCTURED `MessageAuthor` threaded parallel to the
 * message `text`. This is the ONE place a `send_prompt` acquires its author, and
 * it derives ONLY from the verified principal — NEVER from the client message
 * body (anti-spoof; the gate at `session-authz.ts` is untouched — attribution ⊥
 * authorization, Contract-3).
 *
 * Null principal → undefined author. Single-operator mode (flag off) binds no
 * principal, so `deriveAuthor(null)` returns undefined and every downstream
 * `...(author ? { author } : {})` spread omits the field → byte-unchanged.
 *
 * `display` source (honest-gap §8.4, resolved against the live `TokenPayload`
 * shape `AuthUser { sub (email), name, username, provider }`): prefer the
 * OAuth display `name`, else `username`, else the `sub` — the first non-empty
 * wins. `sub` is always the exact decoded cookie sub (the identity key).
 */
import type { TokenPayload } from "./auth.js";
import { isOperator } from "./session-authz.js";
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

/**
 * Derive the structured author from a verified principal. Returns undefined
 * when there is no bound principal (single-operator, or a principal-less
 * connection the gate already allowed with the flag off).
 *
 * `operatorUsers` (optional) sources the DISPLAY-ONLY `isOperator` bit via
 * `isOperator(principal, operatorUsers)` — the SAME helper the gate uses for
 * enforcement, but here it feeds UI color anchoring ONLY (attribution ⊥
 * authorization, Contract-3). The bit is stamped ONLY when `operatorUsers` is
 * configured (non-empty); when absent/empty it is OMITTED (undefined) so the
 * author object stays BYTE-UNCHANGED vs today (inert single-operator path). This
 * field is stamped + sent to the client only and is NEVER consulted by any
 * enforcement path.
 */
export function deriveAuthor(
  principal: TokenPayload | null | undefined,
  operatorUsers?: string[],
): MessageAuthor | undefined {
  if (!principal) return undefined;
  const sub = principal.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) return undefined;
  const display = firstNonEmpty(principal.name, principal.username, sub) ?? sub;
  const operatorConfigured = !!operatorUsers && operatorUsers.length > 0;
  return {
    sub,
    display,
    ...(operatorConfigured ? { isOperator: isOperator(principal, operatorUsers) } : {}),
  };
}
