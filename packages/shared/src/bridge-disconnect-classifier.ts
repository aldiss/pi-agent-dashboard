/**
 * W1b — bridge-disconnect-reason classifier (ROOT-CAUSE Gap #4).
 *
 * The dashboard recorded "no bridge" (502) but never WHY. This pure classifier
 * turns the signals available at the `ws.on("close")` disconnect origin into a
 * first-class {@link BridgeDisconnectReason}, so the liveness/status display can
 * stop lying (the Cartographer "down" / Joan `:9999=0` / UnendFinisher "stuck"
 * flap — an undiscriminated app-registration blip vs a TCP-stable busy bridge).
 *
 * Pure + injectable (no I/O) so every disconnect class is unit-testable against
 * in-memory signals. The I/O (WS close code, ping-miss count, pid kill-0,
 * cross-wire displacement flag) is gathered by the caller in pi-gateway.
 *
 * Precedence (first match wins) — strongest, least-ambiguous signal first:
 *   1. cross-wire        — a second registration displaced this WS (two bridges,
 *                          one session). Explicit displacement beats every other
 *                          signal: the disconnect was CAUSED by the takeover.
 *   2. clean-shutdown    — a normal WS close code (1000 / 1001). An orderly close
 *                          is authoritative over a coincidental heartbeat gap.
 *   3. heartbeat-timeout — ping/pong misses exceeded threshold (busy/hung bridge)
 *                          on a non-clean close.
 *   4. process-gone      — the pid is known-dead (kill-0 miss). Checked AFTER
 *                          heartbeat so a hung-then-killed pi still reads as the
 *                          proximate cause (process-gone) only when no heartbeat
 *                          signal fired.
 *   5. unknown           — none of the above. MANDATORY + fail-loud: never blank.
 *
 * See change: bridge-disconnect-reason.
 */
import type { BridgeDisconnectReason } from "./types.js";

/** Signals gathered at the disconnect origin. All optional — absent = unknown-safe. */
export interface DisconnectSignals {
  /**
   * The WebSocket close code (RFC 6455). 1000 (normal) / 1001 (going away) =
   * clean shutdown. Undefined when the close event carried no code.
   */
  closeCode?: number;
  /**
   * True iff this WS's ping/pong miss counter had reached the kill threshold
   * before close (the bridge stopped answering pings — busy or hung).
   */
  heartbeatMissed?: boolean;
  /**
   * The session's pid liveness AT close, when a pid is known. `false` = kill-0
   * miss (process gone). `undefined` = no pid to check (do not infer).
   */
  pidAlive?: boolean;
  /** True iff a newer registration displaced this WS for the same session id. */
  crossWire?: boolean;
}

/**
 * WS close codes that mean an orderly shutdown. 1000 = normal closure,
 * 1001 = going away (endpoint navigating away / server shutting down).
 */
const CLEAN_CLOSE_CODES = new Set<number>([1000, 1001]);

/**
 * Classify a bridge disconnect into a first-class reason. Never returns blank —
 * the fall-through is the explicit `"unknown"` sentinel (fail-loud contract).
 */
export function classifyBridgeDisconnect(signals: DisconnectSignals): BridgeDisconnectReason {
  // 1. Cross-wire displacement is the strongest signal — the disconnect was
  //    CAUSED by a second bridge taking the session id.
  if (signals.crossWire === true) return "cross-wire";

  // 2. A normal WS close code is an orderly shutdown, authoritative over a
  //    coincidental heartbeat gap.
  if (typeof signals.closeCode === "number" && CLEAN_CLOSE_CODES.has(signals.closeCode)) {
    return "clean-shutdown";
  }

  // 3. Non-clean close + heartbeat misses = the bridge stopped answering.
  if (signals.heartbeatMissed === true) return "heartbeat-timeout";

  // 4. Pid known-dead (kill-0 miss). Only when a pid was actually checked.
  if (signals.pidAlive === false) return "process-gone";

  // 5. Fall-through — MANDATORY unknown (never blank).
  return "unknown";
}
