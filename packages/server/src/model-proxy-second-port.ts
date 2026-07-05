/**
 * model-proxy second-port bind (Stage-3 X4 — fail-loud).
 *
 * The optional model-proxy `/v1` second port used to bind with a buried soft-fail: on a bind
 * error it logged a warn ("...bind failed, continuing...") and dropped the proxy silently
 * — a SUPPRESSED failure (validation design-delta #4): an operator who ENABLED the proxy
 * got a silently-dead subsystem, the exact anti-pattern the Stage-2 fail-loud law kills.
 *
 * The fix, when modelProxy is enabled + a secondPort is configured:
 *   1. reclaim-on-start the 2nd port (same Stage-2 (a)/(d) reclaim-ports treatment as the
 *      main ports) so a stale orphan holder is reaped before binding;
 *   2. on a GENUINE conflict (reclaim can't free it, or the bind still fails), surface it
 *      LOUD (console.error, never a `console.warn(...continuing without...)`) AND mark the
 *      subsystem DEGRADED on /api/health (`proxySecondPort`), so it is inspectable, not buried.
 *
 * It deliberately does NOT crash the process: the main server + pi gateway + the live fleet
 * are already up, and the 2nd port is an OPTIONAL subsystem — crashing them over it would be
 * disproportionate (and itself a fleet risk). "Loud + clearly-degraded, never a buried warn."
 * When modelProxy is DISABLED the caller's gate skips this entirely (degrade-clean; status
 * stays "disabled").
 */

export type SecondPortStatus =
  | { status: "disabled" }
  | { status: "listening"; port: number }
  | { status: "failed"; port: number; reason: string };

let secondPortStatus: SecondPortStatus = { status: "disabled" };

/** Current 2nd-port status — surfaced on /api/health as `proxySecondPort`. */
export function getModelProxySecondPortStatus(): SecondPortStatus {
  return secondPortStatus;
}

export function setModelProxySecondPortStatus(s: SecondPortStatus): void {
  secondPortStatus = s;
}

export interface StartSecondPortDeps {
  /** Reclaim orphan LISTEN-holders of the given ports (reuse reclaim-ports.ts). Throws if still held. */
  reclaim: (ports: number[]) => Promise<unknown>;
  /** Build + listen the proxy fastify on the 2nd port (may throw on a bind conflict). */
  listen: () => Promise<void>;
  log?: (msg: string) => void;
  errorLog?: (msg: string, err: unknown) => void;
  /** Status sink (default: the module singleton surfaced on /api/health). */
  setStatus?: (s: SecondPortStatus) => void;
}

/**
 * Bind the model-proxy 2nd port with reclaim-on-start + fail-loud-degrade. Returns
 * "listening" | "failed". NEVER throws upward — a failure is surfaced (loud + degraded
 * status), not propagated, so the healthy main server is untouched.
 */
export async function startModelProxySecondPort(
  secondPort: number,
  deps: StartSecondPortDeps,
): Promise<"listening" | "failed"> {
  const setStatus = deps.setStatus ?? setModelProxySecondPortStatus;
  try {
    // Reclaim-on-start the 2nd port too (throws if it stays held after reclaim).
    await deps.reclaim([secondPort]);
    await deps.listen();
    setStatus({ status: "listening", port: secondPort });
    deps.log?.(`Model proxy second port listening at http://127.0.0.1:${secondPort}`);
    return "listening";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    setStatus({ status: "failed", port: secondPort, reason });
    // FAIL-LOUD (design-delta #4): explicit + unmissable, NOT a buried "continuing without".
    deps.errorLog?.(
      `[model-proxy] FAIL-LOUD: second port ${secondPort} could not be bound after reclaim — ` +
        `/v1 proxy is NOT served (DEGRADED, surfaced on /api/health.proxySecondPort), not silently continued.`,
      err,
    );
    return "failed";
  }
}
