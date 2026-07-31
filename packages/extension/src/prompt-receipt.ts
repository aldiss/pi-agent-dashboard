/**
 * deriveReceipt — pure helper that turns a PromptBus `PromptResponse`
 * discriminator (`source` + `cancelled` + `answer`) into a verifiable
 * receipt the `ask_user` tool can report to the agent.
 *
 * The bridge collapses `ctx.ui.*` to `Promise<string | undefined>` (a
 * blast-radius constraint — many callers depend on that return type), which
 * DISCARDS the `source` + cancel reason. That collapse makes `undefined`
 * ambiguous: the agent cannot tell a real dismiss from a timeout from a
 * never-rendered prompt. The receipt restores that distinction out-of-band.
 *
 * Response → receipt partition (mutually exclusive answered/dismissed/timedOut):
 *   • !cancelled                         → answered  (source = adapter, e.g. "dashboard"/"tui")
 *   • cancelled, source ≠ "__bus__"      → dismissed (an adapter cancelled — operator dismissed the UI)
 *   • cancelled, source = "__bus__"      → timedOut  (bus timer fired — never answered / never rendered)
 *
 * `delivered` = an adapter engaged (answered OR dismissed) = source ≠ "__bus__".
 * A bus-fired timeout is the only "not delivered" state, so `delivered`
 * distinguishes never-rendered from a real operator interaction.
 *
 * Kept separate from bridge.ts / ask-user-tool.ts so it can be unit-tested
 * without instantiating a live PromptBus or session context.
 */

/** Sentinel `source` the PromptBus stamps on a timeout/never-rendered cancel. */
export const BUS_TIMEOUT_SOURCE = "__bus__";

/** Minimal structural shape of a PromptBus response needed to build a receipt. */
export interface ReceiptSource {
  answer?: string;
  cancelled?: boolean;
  source: string;
}

export interface PromptReceipt {
  /** An adapter engaged with the operator (answered or dismissed) — not a bus timeout. */
  delivered: boolean;
  /** A real answer came back (distinct from a dismiss or timeout). */
  answered: boolean;
  /** The operator dismissed the prompt without answering. */
  dismissed: boolean;
  /** The bus timer fired — never answered / never rendered. */
  timedOut: boolean;
  /** The response source: the answering/dismissing adapter, or "__bus__" on timeout. */
  source: string;
}

export function deriveReceipt(response: ReceiptSource): PromptReceipt {
  const source = response.source;
  const cancelled = response.cancelled === true;
  const timedOut = cancelled && source === BUS_TIMEOUT_SOURCE;
  const dismissed = cancelled && source !== BUS_TIMEOUT_SOURCE;
  const answered = !cancelled;
  const delivered = source !== BUS_TIMEOUT_SOURCE;
  return { delivered, answered, dismissed, timedOut, source };
}

/**
 * Fallback receipt for environments where no PromptResponse was stashed
 * (e.g. running outside the bridge, or a caller that bypassed the bus patch).
 * Best-effort from the collapsed value only: `source: "unknown"` marks the
 * receipt as degraded so the agent knows the discriminator was unavailable.
 *
 * `confirm` has no undefined path (it always resolves to a boolean), so a
 * missing stash there is treated as answered; every other method treats a
 * `undefined` collapsed value as no-answer.
 */
export function fallbackReceipt(method: string, hasResult: boolean): PromptReceipt {
  const answered = method === "confirm" ? true : hasResult;
  return {
    delivered: answered,
    answered,
    dismissed: false,
    timedOut: false,
    source: "unknown",
  };
}
