/**
 * Post-respawn VERIFY gate (build-gate item 2; design-pass §3-B, §4a).
 *
 * The #1 lesson of the v1 incident: the case-2 respawn "succeeded" (HTTP 200)
 * while the pi process was dead — the endpoint spawned-and-hoped. v2 replaces
 * the unknowable headless-crash root-cause with an OBSERVABLE post-condition:
 * after respawn, the endpoint asserts the session is FULLY interactable before
 * returning success, and on failure retries once then surfaces a loud,
 * actionable error (never a silent false-green).
 *
 * Five assertions, each backed by a REAL oracle (NOT an HTTP status):
 *   1. process-alive     — `kill -0` the registered pid (or a live bridge,
 *                          which itself proves a live process).
 *   2. bridge-connected  — the `:9999` WebSocket is OPEN (polled up to T).
 *   3. controllable      — the session row exists and is not `ended`.
 *   4. writable          — a probe bridge-send SUCCEEDS (the `sendToSession`
 *                          boolean, NOT an HTTP 200 — design-pass §3-B/4).
 *   5. model-changeable  — a `set_model` to a DIFFERENT model produces an
 *                          OBSERVED `session.model` change within T (the
 *                          `model_update`→`sessionManager.update` oracle), then
 *                          restores the original. NOT the blind
 *                          `POST /api/session/:id/model` HTTP 200 (Alice note 2,
 *                          §4a item 1 — the load-bearing one). `model-tracker`
 *                          emits `model_update` ONLY on a real change, so a
 *                          no-op same-model probe would be a false-green; the
 *                          gate must toggle to observe.
 *
 * FALSIFIABILITY (Bert d20 crux): the gate is the load-bearing assertion, so it
 * must be adversarially falsifiable, not green-only. The probes are injectable
 * (`ResurrectionProbes`) so the RED-arm test (resurrection-verify.test.ts)
 * supplies a deliberately-broken probe per assertion and proves the gate REJECTS
 * each (→ retry → loud-surface), NOT silently-always-green.
 *
 * See change: unend-mechanism-v2.
 */
import type { PiGateway } from "./pi-gateway.js";
import { pidAlive } from "./driver-liveness.js";
import { getModelsForSession } from "./session-models-cache.js";

// ── Assertion taxonomy ──────────────────────────────────────────────────────

export type AssertionId =
  | "process-alive"
  | "bridge-connected"
  | "controllable"
  | "writable"
  | "model-changeable";

/**
 * The five injectable probes — one per assertion. Each resolves truthy iff its
 * post-condition holds. Production wires real oracles via `createProductionProbes`;
 * the RED-arm test injects deliberately-broken probes.
 *
 * `isBridgeConnected` and `isModelChangeable` are polled/awaited by the gate;
 * all are allowed to be async.
 */
export interface ResurrectionProbes {
  /** Assertion 1: the respawned pi process is alive. */
  isProcessAlive(): boolean | Promise<boolean>;
  /** Assertion 2: the `:9999` bridge WebSocket is connected. Polled. */
  isBridgeConnected(): boolean | Promise<boolean>;
  /** Assertion 3: the session row is controllable (exists, not ended). */
  isControllable(): boolean | Promise<boolean>;
  /** Assertion 4: a probe bridge-send succeeds (writable). */
  isWritable(): boolean | Promise<boolean>;
  /** Assertion 5: a real model-change is OBSERVED (toggle → observe → restore). */
  isModelChangeable(): boolean | Promise<boolean>;
}

export interface VerifyResult {
  ok: boolean;
  /** The first assertion that failed (only on `ok:false`). */
  failedAssertion?: AssertionId;
  /** Human-actionable detail for the loud-surface error. */
  detail?: string;
  /** True iff the gate ran a second attempt (i.e. the first failed). */
  retried: boolean;
  /** Number of full attempts run (1 or 2). */
  attempts: number;
}

export interface VerifyOptions {
  /** Max wait for the bridge to connect (assertion 2), ms. Default 15000. */
  bridgeConnectTimeoutMs?: number;
  /** Poll interval for the bridge-connect wait, ms. Default 250. */
  pollIntervalMs?: number;
  /** Injectable sleep — tests pass a no-op to run instantly. Default real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable logger — tests capture; production = console.error. */
  log?: (msg: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the five assertions once, in production order: poll bridge-connected
 * (the gating signal) first, then the rest. Returns the FIRST failure, or
 * `{ok:true}` when all five hold.
 *
 * Note on ordering vs. labelling: assertions are reported by IDENTITY
 * (`failedAssertion`), not by check order — so a RED-arm variant that breaks
 * exactly one probe always surfaces THAT assertion regardless of order.
 */
async function runAssertionsOnce(
  probes: ResurrectionProbes,
  opts: Required<Pick<VerifyOptions, "bridgeConnectTimeoutMs" | "pollIntervalMs" | "sleep" | "log">>,
): Promise<{ ok: true } | { ok: false; failedAssertion: AssertionId; detail: string }> {
  // Assertion 2: bridge-connected — poll up to the timeout. This is the
  // gating signal: the bridge registers (carrying its pid) only once the
  // respawned pi has loaded the dashboard extension and opened :9999.
  const deadline = opts.bridgeConnectTimeoutMs;
  let waited = 0;
  let bridgeUp = await probes.isBridgeConnected();
  while (!bridgeUp && waited < deadline) {
    await opts.sleep(opts.pollIntervalMs);
    waited += opts.pollIntervalMs;
    bridgeUp = await probes.isBridgeConnected();
  }
  if (!bridgeUp) {
    return {
      ok: false,
      failedAssertion: "bridge-connected",
      detail: `bridge :9999 did not connect within ${deadline}ms after respawn`,
    };
  }

  // Assertion 1: process-alive.
  if (!(await probes.isProcessAlive())) {
    return {
      ok: false,
      failedAssertion: "process-alive",
      detail: "respawned pi process is not alive (kill -0 failed and no live bridge)",
    };
  }

  // Assertion 3: controllable.
  if (!(await probes.isControllable())) {
    return {
      ok: false,
      failedAssertion: "controllable",
      detail: "session row is not controllable (missing or still ended) after respawn",
    };
  }

  // Assertion 4: writable — the probe bridge-send must SUCCEED (boolean),
  // not merely return an HTTP 200.
  if (!(await probes.isWritable())) {
    return {
      ok: false,
      failedAssertion: "writable",
      detail: "probe send was rejected by the bridge (not writable)",
    };
  }

  // Assertion 5: model-changeable — a real, OBSERVED model change (toggle →
  // observe session.model change → restore). The load-bearing half of the
  // operator mandate; an HTTP-200-blind check here would be a false-green.
  if (!(await probes.isModelChangeable())) {
    return {
      ok: false,
      failedAssertion: "model-changeable",
      detail: "set_model produced no observed session.model change (model-unreachable)",
    };
  }

  return { ok: true };
}

/**
 * The verify gate: run the five assertions; on failure retry ONCE, then return
 * a loud, actionable failure (the caller surfaces it — never silent success).
 * Returns `{ok:true}` only when the session is verified FULLY interactable.
 */
export async function verifyResurrection(
  probes: ResurrectionProbes,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const opts = {
    bridgeConnectTimeoutMs: options.bridgeConnectTimeoutMs ?? 15_000,
    pollIntervalMs: options.pollIntervalMs ?? 250,
    sleep: options.sleep ?? realSleep,
    log: options.log ?? ((m: string) => console.error(m)),
  };

  const first = await runAssertionsOnce(probes, opts);
  if (first.ok) {
    return { ok: true, retried: false, attempts: 1 };
  }

  // Retry once — a slow boot / transient bridge flap may clear on a second
  // pass. We do NOT re-respawn (that risks a double writer); we re-assert.
  opts.log(
    `[resurrect-verify] assertion "${first.failedAssertion}" failed (${first.detail}) — retrying verify once`,
  );

  const second = await runAssertionsOnce(probes, opts);
  if (second.ok) {
    opts.log(`[resurrect-verify] retry passed — session verified interactable`);
    return { ok: true, retried: true, attempts: 2 };
  }

  // Loud, actionable surface — the operator/Lazarus needs to know EXACTLY
  // which interactability post-condition the respawn failed to restore.
  opts.log(
    `[resurrect-verify] FAILED after retry: assertion "${second.failedAssertion}" — ${second.detail}. ` +
      `The respawned session is NOT fully interactable; refusing to report success.`,
  );
  return {
    ok: false,
    failedAssertion: second.failedAssertion,
    detail: second.detail,
    retried: true,
    attempts: 2,
  };
}

// ── Production probe wiring (the real oracles) ──────────────────────────────

/**
 * Least-privilege view of a session for the probes. They read ONLY these three
 * fields — narrowing the dep (rather than the full `SessionManager`) keeps the
 * contract honest and lets tests pass minimal stubs.
 */
export interface VerifySessionView {
  status: string;
  pid?: number;
  model?: string;
}

export interface ProductionProbeDeps {
  sessionId: string;
  sessionManager: { get(id: string): VerifySessionView | undefined };
  piGateway: Pick<PiGateway, "isSessionConnected" | "sendToSession">;
  /** `kill -0` liveness. Default: driver-liveness.pidAlive. Injectable for tests. */
  pidAlive?: (pid: number) => boolean;
  /**
   * Resolve a model DIFFERENT from `current` (a `provider/id` string) for the
   * given session to toggle to. Returns null when none is available
   * (single-model session) — the gate then fails assertion 5 LOUD rather than
   * false-greening. Default: the session's bridge-pushed model catalogue
   * (`session-models-cache.ts`). Injectable for tests (stubs ignore args).
   */
  resolveAltModel?: (
    current: string | undefined,
    sessionId: string,
  ) => Promise<{ provider: string; modelId: string } | null>;
  /** Injectable sleep for the model-observe poll. Default real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable logger. Default console.error. */
  log?: (msg: string) => void;
  /** Max wait to observe the model change, ms. Default 4000. */
  modelObserveTimeoutMs?: number;
  /** Poll interval for the model-observe wait, ms. Default 200. */
  modelPollIntervalMs?: number;
}

/** Parse a `provider/id` model string into its parts (id may contain "/"). */
export function parseModelString(
  model: string | undefined,
): { provider: string; modelId: string } | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * Default alt-model resolver: read the SESSION's own bridge-pushed model
 * catalogue (the `models_list` channel cached in `session-models-cache.ts` —
 * the same source the dashboard model-picker uses), return the first model whose
 * `provider/id` differs from `current`. Null when the session has pushed fewer
 * than two distinct models.
 *
 * This deliberately does NOT read the pi-ai-backed server model registry: on a
 * real machine pi-ai is nested under managed `pi-coding-agent` and the
 * tool-registry's top-level strategies miss it, so `getModelRegistry()` throws —
 * which previously made assertion 5 fail (503) on EVERY real session. The
 * session catalogue is the faithful source (the models the session can actually
 * switch to) and has no pi-ai dependency. Pure cache reader: connect-timing
 * (empty cache right after respawn) is handled by the caller, which nudges
 * `request_models` and polls before resolving. See change: unend-mechanism-v2.
 */
export async function defaultResolveAltModel(
  current: string | undefined,
  sessionId: string,
): Promise<{ provider: string; modelId: string } | null> {
  const models = getModelsForSession(sessionId);
  for (const m of models) {
    if (!m?.provider || !m?.id) continue;
    const tag = `${m.provider}/${m.id}`;
    if (tag !== current) return { provider: m.provider, modelId: m.id };
  }
  return null;
}

/**
 * Wire the five real oracles for production. The model probe (assertion 5)
 * toggles to a different model, OBSERVES the `session.model` change (the
 * `model_update`→`sessionManager.update` oracle), then restores the original
 * best-effort. This is the only honest way to satisfy §4a item 1
 * ("observe a real model change, NOT HTTP-200"), since `model-tracker` emits
 * `model_update` solely on an ACTUAL change.
 */
export function createProductionProbes(deps: ProductionProbeDeps): ResurrectionProbes {
  const {
    sessionId,
    sessionManager,
    piGateway,
    pidAlive: isAlive = pidAlive,
    resolveAltModel = defaultResolveAltModel,
    sleep = realSleep,
    log = (m: string) => console.error(m),
    modelObserveTimeoutMs = 4000,
    modelPollIntervalMs = 200,
  } = deps;

  return {
    isProcessAlive() {
      const s = sessionManager.get(sessionId);
      // A live bridge is itself proof of a live process; otherwise kill-0 the
      // registered pid.
      if (s && typeof s.pid === "number" && isAlive(s.pid)) return true;
      return piGateway.isSessionConnected(sessionId);
    },

    isBridgeConnected() {
      return piGateway.isSessionConnected(sessionId);
    },

    isControllable() {
      const s = sessionManager.get(sessionId);
      return !!s && s.status !== "ended";
    },

    isWritable() {
      // `request_state_sync` is a benign no-op the bridge accepts (it just
      // re-syncs state) — a non-destructive writable probe whose
      // `sendToSession` boolean IS the bridge-send oracle.
      return piGateway.sendToSession(sessionId, {
        type: "request_state_sync",
        sessionId,
      });
    },

    async isModelChangeable() {
      const s = sessionManager.get(sessionId);
      const original = s?.model;

      // Connect-timing robustness: the bridge pushes `models_list` on connect,
      // but this gate may run just after a respawn — before the cache is warm.
      // When using the default (cache-reading) resolver and the session's
      // catalogue is still empty, nudge the bridge with `request_models` and
      // poll the cache up to the observe timeout before resolving. (Injected
      // resolvers — the tests — don't read the cache, so we skip the nudge to
      // keep their oracles pure.) Fail-closed: if still empty after the wait,
      // `defaultResolveAltModel` returns null below and assertion 5 fails loud.
      if (
        resolveAltModel === defaultResolveAltModel &&
        getModelsForSession(sessionId).length === 0
      ) {
        piGateway.sendToSession(sessionId, { type: "request_models", sessionId });
        let warmed = 0;
        while (getModelsForSession(sessionId).length === 0 && warmed < modelObserveTimeoutMs) {
          await sleep(modelPollIntervalMs);
          warmed += modelPollIntervalMs;
        }
      }

      const alt = await resolveAltModel(original, sessionId);
      if (!alt) {
        log(
          `[resurrect-verify] model-changeable: no alternate model available to toggle ` +
            `(current="${original ?? "?"}") — cannot OBSERVE a real model change; failing assertion 5`,
        );
        return false;
      }

      // Send the toggle. The boolean is the bridge-send oracle (writable for
      // set_model specifically).
      const sendOk = piGateway.sendToSession(sessionId, {
        type: "set_model",
        sessionId,
        provider: alt.provider,
        modelId: alt.modelId,
      });
      if (!sendOk) {
        log(`[resurrect-verify] model-changeable: set_model bridge-send was rejected`);
        return false;
      }

      // Observe the REAL change: poll session.model until it reflects the alt
      // (the model_update→sessionManager.update oracle), within T.
      const altTag = `${alt.provider}/${alt.modelId}`;
      let waited = 0;
      let observed = sessionManager.get(sessionId)?.model === altTag;
      while (!observed && waited < modelObserveTimeoutMs) {
        await sleep(modelPollIntervalMs);
        waited += modelPollIntervalMs;
        observed = sessionManager.get(sessionId)?.model === altTag;
      }

      if (!observed) {
        log(
          `[resurrect-verify] model-changeable: set_model sent but session.model never ` +
            `changed to "${altTag}" within ${modelObserveTimeoutMs}ms — model-unreachable`,
        );
        return false;
      }

      // Restore the original best-effort (the change is the proof; restore is
      // courtesy so the operator's model is unchanged net-net).
      const restore = parseModelString(original);
      if (restore) {
        const restoreOk = piGateway.sendToSession(sessionId, {
          type: "set_model",
          sessionId,
          provider: restore.provider,
          modelId: restore.modelId,
        });
        if (!restoreOk) {
          log(
            `[resurrect-verify] model-changeable: change OBSERVED but restore send failed; ` +
              `session left on "${altTag}" (non-fatal)`,
          );
        }
      }
      return true;
    },
  };
}
