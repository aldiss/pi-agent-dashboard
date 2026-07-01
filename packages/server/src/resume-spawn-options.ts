/**
 * Fix-11 — shared §19 interactive-resume options builder.
 *
 * un-end v2 hardened ONLY `/resurrect`'s `doRespawnContinue`. The silent-
 * headless class is broader: every pi-native session-RESUME path that loads an
 * existing `--session <file>` (the large-log crash risk) used to spawn with
 * `config.spawnStrategy` (default headless → `--mode rpc` = the v1 crash-form).
 *
 * This module is the single source of the §19 form for those resume paths, so
 * the REST resume endpoint, the WS resume handler, and prompt-auto-resume all
 * produce the identical hardened shape rather than re-deriving it three times:
 *   - `strategy:"tmux"`         — force the interactive form (override headless default)
 *   - `requireInteractive:true` — compose with Fix-10: fail-loud if tmux can't
 *                                 resolve, NEVER silently degrade to headless rpc
 *   - `pinDashboardUrl`         — pin the respawn's bridge to THIS server's own
 *                                 gateway (anti-cross-wire, the Fix-2a pattern)
 *   - `agentName`               — §19 themed identity when the session has a name
 *
 * A "real session-RESUME" = loads an existing on-disk session file. Fresh spawns
 * (no sessionFile: `spawn_new_session`, fork-degrade, `+ Session`) intentionally
 * do NOT use this — they carry no large log to crash on, so the graceful headless
 * fallback still stands for tmux-less hosts.
 *
 * See change: harden-headless-resume-paths.
 */
import type { SessionOptions } from "./process-manager.js";
import type { PiGateway } from "./pi-gateway.js";

export interface InteractiveResumeParams {
  /** The existing on-disk session file being resumed/forked (the large-log source). */
  sessionFile: string;
  /** `continue` (resume in place) or `fork` (branch). Both replay the large log. */
  mode: "continue" | "fork";
  /** §19 themed identity — the session's display name when known. Omitted → no --name. */
  agentName?: string;
  /** Anti-cross-wire pin to the spawning server's own gateway. Omitted → no pin. */
  pinDashboardUrl?: string;
}

/**
 * Build the §19 interactive-resume `SessionOptions` for a real session-RESUME.
 * Always `strategy:"tmux"` + `requireInteractive:true` (fail-loud, never silent
 * headless). `agentName` / `pinDashboardUrl` included only when provided.
 */
export function buildInteractiveResumeOptions(p: InteractiveResumeParams): SessionOptions {
  return {
    sessionFile: p.sessionFile,
    mode: p.mode,
    strategy: "tmux",
    requireInteractive: true,
    ...(p.agentName ? { agentName: p.agentName } : {}),
    ...(p.pinDashboardUrl ? { pinDashboardUrl: p.pinDashboardUrl } : {}),
  };
}

/**
 * Resolve the anti-cross-wire pin URL for a respawn: the SPAWNING server's own
 * pi-gateway. Prefers the live bound socket (`piGateway.address()`, ground truth
 * even under ephemeral :0), falls back to the configured runtime port. Returns
 * `undefined` when neither is resolvable (→ no pin, no crash).
 *
 * ⚠ Sources the RUNTIME port, never `loadConfig().piPort` — a `--pi-port <N>`
 * override can differ from the config file; pinning to the wrong port re-
 * introduces the cross-wire bug. Same rule as the resurrect endpoint.
 */
export function resolvePinDashboardUrl(
  piGateway: Pick<PiGateway, "address">,
  serverPiPort?: number,
): string | undefined {
  const port = piGateway.address() ?? serverPiPort;
  return typeof port === "number" ? `ws://localhost:${port}` : undefined;
}
