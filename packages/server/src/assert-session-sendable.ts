/**
 * assert-session-sendable — the WI-1 empirical sendability probe (PART 2).
 *
 * THE PROBLEM IT SOLVES (verified own-hand by Perf): SENDABILITY cannot be
 * inferred from any static property. A session can have a present `:9999`
 * socket, accept TCP, be young, be spawned by any mechanism — and STILL 502
 * ("no bridge connection") on a real send, because the only ground-truth is
 * whether the gateway holds an OPEN ws for that exact sessionId at send time.
 * So this probe does the ONE thing that tells the truth: a REAL round-trip
 * through the canonical send path, and classifies the HTTP result.
 *
 *   POST /api/session/:id/prompt  →  200/2xx  ⇒ SENDABLE (bridge OPEN, sent)
 *                                 →  502       ⇒ NOT sendable ("no bridge connection")
 *                                 →  404       ⇒ NOT sendable (session unknown)
 *                                 →  4xx/5xx   ⇒ NOT sendable (reason surfaced)
 *
 * The 200-vs-502 split is decided server-side by `piGateway.sendToSession()`
 * returning whether an OPEN ws exists (`session-api.ts` prompt route →
 * `pi-gateway.ts:400`). This module never re-implements that judgement; it
 * observes it over a real HTTP round-trip.
 *
 * REUSE (the reason it is a standalone primitive, not inlined):
 *   - Steward's S7 sendability-gate calls it post-spawn to REFUSE-REAP an
 *     unsendable successor (no-sendable = not-done = don't-reap; contract I3).
 *   - Pete's acceptance test calls it (spawn-fresh → probe → expect sendable).
 *
 * ⚠ SIDE-EFFECT (honest): the canonical send path INJECTS the probe text into
 * the live session as a real user turn. That is inherent to an empirical probe
 * — there is no non-mutating "is the bridge there" round-trip on the wire (a
 * present socket is not sendability). Callers therefore pass a clearly-marked
 * sentinel `text` (default below) so the injected turn is unambiguous in the
 * transcript, and only probe sessions where a benign turn is acceptable
 * (fresh post-spawn successors, gate checks). For a session you must not
 * perturb, do not probe it — read the last known verdict instead.
 *
 * See brief: "## WI-1 PROBE PRIMITIVE — assert-session-sendable(id)".
 * See change: handover-reliability-wi1.
 */

/** The default probe turn — a clearly-marked sentinel so the injected user
 *  turn is unambiguous in the session transcript. Override per call site. */
export const DEFAULT_PROBE_TEXT = "[dashboard sendability-probe — ignore]";

export interface AssertSendableOptions {
  /** The user-turn text injected by the round-trip. Default: DEFAULT_PROBE_TEXT. */
  text?: string;
  /** Abort the round-trip after this many ms (a hung POST = not sendable). Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch (Node 22 global by default) — for deterministic tests. */
  fetchImpl?: typeof fetch;
}

export interface SendableResult {
  /** True iff the canonical send path returned 2xx (bridge OPEN, prompt sent). */
  sendable: boolean;
  /** Human-readable cause when NOT sendable (502 body, 404, timeout, network). */
  reason?: string;
  /** The observed HTTP status (absent when the round-trip never completed). */
  status?: number;
}

/**
 * Probe whether `sessionId` is bridge-SENDABLE right now, by a REAL round-trip
 * to `POST {baseUrl}/api/session/:id/prompt`. 2xx ⇒ sendable; anything else ⇒
 * not, with the reason surfaced. Never throws — a network error / timeout is
 * reported as `{sendable:false, reason}` (an unreachable server is, by
 * definition, not sendable).
 *
 * @param baseUrl   dashboard origin, e.g. "http://localhost:8000" (no trailing slash needed)
 * @param sessionId the session UUID to probe
 */
export async function assertSessionSendable(
  baseUrl: string,
  sessionId: string,
  opts: AssertSendableOptions = {},
): Promise<SendableResult> {
  const { text = DEFAULT_PROBE_TEXT, timeoutMs = 5000, fetchImpl = fetch } = opts;
  const url = `${baseUrl.replace(/\/$/, "")}/api/session/${encodeURIComponent(sessionId)}/prompt`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (res.ok) {
      // 2xx — the gateway held an OPEN ws and forwarded the prompt.
      return { sendable: true, status: res.status };
    }

    // Non-2xx — surface the server's own reason (502 "no bridge connection",
    // 404 session unknown, etc). Read the body best-effort for the message.
    let reason = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string" && body.error) reason = body.error;
    } catch {
      // non-JSON body — keep the status-only reason
    }
    return { sendable: false, reason, status: res.status };
  } catch (err: unknown) {
    // Timeout (AbortError) or network failure — unreachable ⇒ not sendable.
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `send round-trip timed out after ${timeoutMs}ms`
        : `send round-trip failed: ${err instanceof Error ? err.message : String(err)}`;
    return { sendable: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
