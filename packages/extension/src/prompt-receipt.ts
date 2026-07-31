/**
 * deriveReceipt — pure helper that turns a PromptBus `PromptResponse`
 * discriminator (`source` + `cancelled` + `answer` + `rendered`) into a
 * verifiable receipt the `ask_user` tool can report to the agent.
 *
 * The bridge collapses `ctx.ui.*` to `Promise<string | undefined>` (a
 * blast-radius constraint — many callers depend on that return type), which
 * DISCARDS the `source` + cancel reason + answer-presence. That collapse makes
 * `undefined` ambiguous: the agent cannot tell a real dismiss from a timeout
 * from a never-rendered prompt from a malformed response. The receipt restores
 * those distinctions out-of-band.
 *
 * Amendments (Pete dl-13350 + Lane):
 *   A1 — `delivered`/`rendered` derive from an explicit render-lifecycle ACK
 *        (the client signals it displayed the dialog), NOT the `source ===
 *        "__bus__"` heuristic. A prompt that RENDERED then timed out is
 *        truthfully `delivered:true, rendered:true, timedOut:true`; one that
 *        never rendered is `delivered:false, rendered:false, timedOut:true`.
 *   A2 — `answered` derives from actual ANSWER-FIELD PRESENCE, not `!cancelled`.
 *        Empty string "" and "false" (confirm=No) are VALID answers; only
 *        undefined / null / absent / malformed is "no answer".
 *   A3 — a non-cancelled response with no present answer is `invalid` (a
 *        malformed non-decision), never a false "answered".
 *
 * Receipt states are mutually exclusive: exactly one of
 *   answered | dismissed | timedOut | invalid
 * is true for any response.
 *
 * Kept separate from bridge.ts / ask-user-tool.ts so it can be unit-tested
 * without instantiating a live PromptBus or session context.
 */

/** Sentinel `source` the PromptBus stamps on a timeout/never-rendered cancel. */
export const BUS_TIMEOUT_SOURCE = "__bus__";

/**
 * Server-stamped authenticated operator identity (Pete dl-13358 B2). Mirrors
 * `MessageAuthor` from the shared types, kept structural here so prompt-receipt
 * has no cross-package import. Derived server-side from the connection-bound
 * principal — NEVER the client body.
 */
export interface ReceiptAuthor {
  sub: string;
  display: string;
  isOperator?: boolean;
}

/** Minimal structural shape of a PromptBus response needed to build a receipt. */
export interface ReceiptSource {
  answer?: string | null;
  cancelled?: boolean;
  source: string;
  /**
   * A1 render ACK: true when the client signalled it displayed the dialog for
   * this prompt id. Absent/false means no render was acknowledged. An answer
   * or an operator dismiss also proves a render (see `deriveReceipt`).
   */
  rendered?: boolean;
  /**
   * B2 authenticated operator author of the answer/ACK (server-stamped from the
   * connection-bound principal, never the body). A receipt with no author is
   * not proven to be an operator decision.
   */
  author?: ReceiptAuthor;
}

export interface PromptReceipt {
  /** The prompt reached AND was displayed to the operator (render ACK or an answer/dismiss proves it). */
  delivered: boolean;
  /** The prompt dialog was rendered on the operator's surface (A1 lifecycle ACK). */
  rendered: boolean;
  /** A real answer came back — the answer field was present (A2: "" and false count). */
  answered: boolean;
  /** The operator dismissed the prompt without answering. */
  dismissed: boolean;
  /** The bus timer fired without an answer. */
  timedOut: boolean;
  /** A non-cancelled response carried NO present answer — malformed non-decision (A3). */
  invalid: boolean;
  /** The response source: the answering/dismissing adapter, or "__bus__" on timeout. */
  source: string;
  /**
   * B2 authenticated operator identity that answered/ACKed (server-stamped,
   * never the body). Absent single-operator (flag OFF) or when no operator
   * principal was bound — a receipt with no author is not an operator decision.
   */
  author?: ReceiptAuthor;
}

/**
 * A2 answer-presence predicate: the `answer` field EXISTS and is not
 * undefined/null. Empty string "" and the string "false" (confirm=No) are
 * PRESENT — they are valid answers. Only undefined / null / absent is "no
 * answer". (Malformed non-string payloads are also treated as absent.)
 */
export function answerFieldIsPresent(response: ReceiptSource): boolean {
  const a = response.answer;
  return typeof a === "string";
}

export function deriveReceipt(response: ReceiptSource): PromptReceipt {
  const source = response.source;
  const cancelled = response.cancelled === true;
  const answerPresent = answerFieldIsPresent(response);

  // A1: a render ACK, an answer, or an operator dismiss (adapter-sourced
  // cancel) all prove the prompt was displayed. A bus-fired timeout with no
  // prior ACK is the only never-rendered state.
  const dismissed = cancelled && source !== BUS_TIMEOUT_SOURCE;
  const rendered =
    response.rendered === true || answerPresent || dismissed;
  const delivered = rendered;

  // A2/A3: answered iff not cancelled AND the answer field is present.
  const answered = !cancelled && answerPresent;
  // A non-cancelled response with no present answer is malformed → invalid.
  const invalid = !cancelled && !answerPresent;
  const timedOut = cancelled && source === BUS_TIMEOUT_SOURCE;

  // B2: thread the server-stamped operator author when present. Omit the key
  // entirely single-operator (author absent) so the receipt stays byte-unchanged.
  const base: PromptReceipt = { delivered, rendered, answered, dismissed, timedOut, invalid, source };
  if (response.author) base.author = response.author;
  return base;
}

/**
 * Fallback receipt for environments where no PromptResponse was stashed
 * (e.g. running outside the bridge, or a caller that bypassed the bus patch).
 * Best-effort from the collapsed value only: `source: "unknown"` marks the
 * receipt as degraded so the agent knows the discriminator was unavailable.
 *
 * `confirm` has no undefined path (it always resolves to a boolean), so a
 * missing stash there is treated as answered; every other method treats a
 * `undefined` collapsed value as no-answer (→ invalid non-decision).
 */
export function fallbackReceipt(method: string, hasResult: boolean): PromptReceipt {
  const answered = method === "confirm" ? true : hasResult;
  return {
    delivered: answered,
    rendered: answered,
    answered,
    dismissed: false,
    timedOut: false,
    invalid: !answered,
    source: "unknown",
  };
}
