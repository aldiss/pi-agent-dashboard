/**
 * Post-respawn VERIFY-gate FALSIFIABILITY suite (build-gate item 3; design-pass
 * §3-B RED-arm, §4a items 2+3).
 *
 * Bert d20 crux: the verify gate is the load-bearing assertion of the whole v2
 * design (it replaced the unknowable headless-crash root-cause with an
 * observable post-condition). A gate that only ever SEES healthy respawns could
 * be silently always-passing — we'd never know until a real bad respawn slips
 * through. So every assertion the gate makes MUST have a broken-variant proving
 * the gate REJECTS it (→ retry → loud-surface), NOT false-greens.
 *
 * Three layers:
 *   A. Gate falsifiability — 5 RED variants 1:1 with the 5 assertions (each
 *      breaks exactly ONE probe; the gate must reject with THAT assertion) +
 *      a GREEN arm (healthy → passes all 5) + retry-rescue + loud-surface.
 *   B. End-to-end via the `forceTakeover({respawn})` injectable seam (the
 *      brief's literal RED-arm shape): a deliberately-broken respawn per variant
 *      lands a broken WORLD; production-shaped probes read it; the takeover+
 *      verify pipeline REJECTS — never a false-green over a dead/blind respawn.
 *   C. Production probes wired to the REAL oracles (createProductionProbes):
 *      sendToSession-boolean = writable; observed session.model change =
 *      model-changeable; isSessionConnected = bridge; kill-0 = alive.
 *
 * See change: unend-mechanism-v2.
 */
import { describe, it, expect, vi } from "vitest";
import {
  verifyResurrection,
  createProductionProbes,
  parseModelString,
  defaultResolveAltModel,
  type ResurrectionProbes,
  type AssertionId,
} from "../resurrection-verify.js";
import {
  setModelsForSession,
  _resetForTests as resetModelsCache,
} from "../session-models-cache.js";
import { forceTakeover } from "../session-api.js";
import type { SpawnResult } from "../process-manager.js";

// Instant sleep + silent log so the suite runs with zero real wall-time.
const noSleep = async (_ms: number) => {};
const fastOpts = { sleep: noSleep, log: () => {}, bridgeConnectTimeoutMs: 50, pollIntervalMs: 10 };

/** A healthy probe-set: all five assertions hold. RED variants override one. */
function healthyProbes(): ResurrectionProbes {
  return {
    isProcessAlive: () => true,
    isBridgeConnected: () => true,
    isControllable: () => true,
    isWritable: () => true,
    isModelChangeable: () => true,
  };
}

describe("verify-gate falsifiability — RED arm (5 variants 1:1) + GREEN arm", () => {
  // ── GREEN arm: a healthy respawn passes all five, no retry ───────────────
  it("GREEN: healthy respawn passes all 5 assertions, no retry", async () => {
    const res = await verifyResurrection(healthyProbes(), fastOpts);
    expect(res.ok).toBe(true);
    expect(res.retried).toBe(false);
    expect(res.attempts).toBe(1);
  });

  // ── RED arm: each variant breaks exactly ONE probe ───────────────────────
  // The 1:1 mapping (Bert dl-3539): variant N proves assertion N's guard FIRES.

  it("RED #1 exits-immediately → gate REJECTS on assertion 'process-alive'", async () => {
    const probes = { ...healthyProbes(), isProcessAlive: () => false };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("process-alive");
    expect(res.retried).toBe(true); // tried again, still failed
    expect(res.attempts).toBe(2);
  });

  it("RED #2 never-binds-:9999 → gate REJECTS on assertion 'bridge-connected'", async () => {
    const probes = { ...healthyProbes(), isBridgeConnected: () => false };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("bridge-connected");
    expect(res.attempts).toBe(2);
  });

  it("RED #3 connects-but-not-controllable → gate REJECTS on assertion 'controllable'", async () => {
    // MUST-FIX (Bert/Alice §4a item 3): bridge up, but the row never reaches
    // controllable (e.g. stuck ended). The gate must still reject.
    const probes = { ...healthyProbes(), isControllable: () => false };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("controllable");
    expect(res.attempts).toBe(2);
  });

  it("RED #4 connects-but-send-rejected → gate REJECTS on assertion 'writable'", async () => {
    const probes = { ...healthyProbes(), isWritable: () => false };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("writable");
    expect(res.attempts).toBe(2);
  });

  it("RED #5 writable-but-model-unreachable → gate REJECTS on assertion 'model-changeable'", async () => {
    // The LOAD-BEARING variant (Bert/Alice §4a item 2, design-pass §3-B): the
    // session is writable but a set_model produces NO observed session.model
    // change. Model-change is HALF the operator mandate, so this is what kills
    // the writable-but-not-model-changeable false-green. The gate catches it by
    // OBSERVING the model didn't change — not by trusting an HTTP 200.
    const probes = { ...healthyProbes(), isModelChangeable: () => false };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("model-changeable");
    expect(res.attempts).toBe(2);
  });

  // ── Retry semantics: the gate RETRIES once, and a transient failure is
  //    rescued on the second pass (proves retry isn't cosmetic). ────────────
  it("retry rescues a transient failure (fail once → pass on retry)", async () => {
    let bridgeCalls = 0;
    const probes: ResurrectionProbes = {
      ...healthyProbes(),
      // First full attempt: bridge never connects (all polls false). Second
      // attempt: connects immediately. The poll within attempt 1 runs a few
      // times; we flip only once attempt 1's poll budget is exhausted.
      isBridgeConnected: () => {
        bridgeCalls++;
        // bridgeConnectTimeoutMs/pollIntervalMs = 50/10 → up to ~6 polls in
        // attempt 1. Flip to connected from the 7th call onward (attempt 2).
        return bridgeCalls >= 7;
      },
    };
    const res = await verifyResurrection(probes, fastOpts);
    expect(res.ok).toBe(true);
    expect(res.retried).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it("loud-surface: a persistent failure logs an actionable message (not silent)", async () => {
    const logs: string[] = [];
    const probes = { ...healthyProbes(), isModelChangeable: () => false };
    const res = await verifyResurrection(probes, { ...fastOpts, log: (m) => logs.push(m) });
    expect(res.ok).toBe(false);
    // The loud-surface line names the failed assertion + says NOT interactable.
    const loud = logs.find((l) => l.includes("FAILED after retry"));
    expect(loud).toBeTruthy();
    expect(loud).toMatch(/model-changeable/);
    expect(loud).toMatch(/NOT fully interactable/);
  });
});

// ── Layer B: end-to-end through the forceTakeover({respawn}) injectable seam ─
//
// The brief's literal RED-arm shape: supply a deliberately-broken RESPAWN per
// variant; the respawn lands a broken WORLD; production-shaped probes read it;
// the takeover→verify pipeline must REJECT (not false-green over a dead/blind
// respawn). This is the integration that proves the seam + gate compose.

interface FakeWorld {
  alive: boolean;
  bridge: boolean;
  controllable: boolean;
  writable: boolean;
  modelChanges: boolean;
}

function probesForWorld(w: FakeWorld): ResurrectionProbes {
  return {
    isProcessAlive: () => w.alive,
    isBridgeConnected: () => w.bridge,
    isControllable: () => w.controllable,
    isWritable: () => w.writable,
    isModelChangeable: () => w.modelChanges,
  };
}

/** Run the real `forceTakeover` (double-writer guard) then the verify gate,
 *  exactly as the resurrect endpoint's case-2 does. Returns the gate verdict. */
async function takeoverThenVerify(world: FakeWorld) {
  const okSpawn: SpawnResult = { success: true, message: "spawned", pid: 4321 };
  const takeover = await forceTakeover(9999, {
    killProcess: async () => ({ ok: true, forced: false }),
    isProcessAlive: () => false, // old writer confirmed dead → respawn proceeds
    // The deliberately-broken respawn: it "succeeds" (process started) but
    // leaves `world` in its broken shape — exactly the v1 spawn-and-hope trap.
    respawn: async () => okSpawn,
  });
  expect(takeover.ok).toBe(true); // respawn dispatch succeeded...
  // ...but "started" ≠ "interactable": the gate is the real arbiter.
  return verifyResurrection(probesForWorld(world), fastOpts);
}

describe("end-to-end: forceTakeover seam + verify gate rejects broken respawns", () => {
  it("GREEN: healthy world → takeover + verify both pass", async () => {
    const res = await takeoverThenVerify({
      alive: true, bridge: true, controllable: true, writable: true, modelChanges: true,
    });
    expect(res.ok).toBe(true);
  });

  it("RED #1: respawn exits-immediately (dead world) → verify REJECTS, no false-green", async () => {
    const res = await takeoverThenVerify({
      alive: false, bridge: true, controllable: true, writable: true, modelChanges: true,
    });
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("process-alive");
  });

  it("RED #2: respawn never binds :9999 → verify REJECTS", async () => {
    const res = await takeoverThenVerify({
      alive: true, bridge: false, controllable: true, writable: true, modelChanges: true,
    });
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("bridge-connected");
  });

  it("RED #3: respawn connects but not controllable → verify REJECTS", async () => {
    const res = await takeoverThenVerify({
      alive: true, bridge: true, controllable: false, writable: true, modelChanges: true,
    });
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("controllable");
  });

  it("RED #4: respawn writable-rejected → verify REJECTS", async () => {
    const res = await takeoverThenVerify({
      alive: true, bridge: true, controllable: true, writable: false, modelChanges: true,
    });
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("writable");
  });

  it("RED #5: respawn writable-but-model-unreachable → verify REJECTS (load-bearing)", async () => {
    const res = await takeoverThenVerify({
      alive: true, bridge: true, controllable: true, writable: true, modelChanges: false,
    });
    expect(res.ok).toBe(false);
    expect(res.failedAssertion).toBe<AssertionId>("model-changeable");
  });
});

// ── Layer C: production probes wired to the REAL oracles ─────────────────────
//
// Prove createProductionProbes maps each assertion to its real oracle — NOT an
// HTTP status. This is what makes the gate "able to SEE the failure" (§4a item 1).

type FakeSession = { id: string; status: string; pid?: number; model?: string };

function makeStubs(initial: FakeSession) {
  const session = { ...initial };
  const sent: Array<{ type: string; provider?: string; modelId?: string }> = [];
  const sessionManager = {
    get: (_id: string) => ({ ...session }),
  };
  return { session, sent, sessionManager };
}

describe("production probes map to real oracles (not HTTP status)", () => {
  it("parseModelString splits provider/id (id may contain '/')", () => {
    expect(parseModelString("anthropic/claude-sonnet-4")).toEqual({
      provider: "anthropic", modelId: "claude-sonnet-4",
    });
    expect(parseModelString("openrouter/meta/llama-3")).toEqual({
      provider: "openrouter", modelId: "meta/llama-3",
    });
    expect(parseModelString(undefined)).toBeNull();
    expect(parseModelString("noslash")).toBeNull();
  });

  it("isWritable = the sendToSession BOOLEAN (bridge-send oracle), not HTTP 200", async () => {
    const { sessionManager } = makeStubs({ id: "s1", status: "idle", pid: 10 });
    // Connected gateway whose send SUCCEEDS → writable true.
    const okGateway = {
      isSessionConnected: () => true,
      sendToSession: vi.fn(() => true),
    };
    const probesOk = createProductionProbes({ sessionId: "s1", sessionManager, piGateway: okGateway });
    expect(await probesOk.isWritable()).toBe(true);
    expect(okGateway.sendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({ type: "request_state_sync" }));

    // Gateway whose send is REJECTED (bridge gone) → writable false. This is
    // the oracle: a blind HTTP 200 could never see this.
    const deadGateway = {
      isSessionConnected: () => true,
      sendToSession: vi.fn(() => false),
    };
    const probesDead = createProductionProbes({ sessionId: "s1", sessionManager, piGateway: deadGateway });
    expect(await probesDead.isWritable()).toBe(false);
  });

  it("isProcessAlive = kill-0 on registered pid OR a live bridge", async () => {
    const { sessionManager } = makeStubs({ id: "s2", status: "idle", pid: 77 });
    const gateway = { isSessionConnected: () => false, sendToSession: () => true };
    // pid 77 alive → true (bridge not needed).
    const aliveProbes = createProductionProbes({
      sessionId: "s2", sessionManager, piGateway: gateway, pidAlive: (p) => p === 77,
    });
    expect(await aliveProbes.isProcessAlive()).toBe(true);
    // pid dead AND bridge down → false.
    const deadProbes = createProductionProbes({
      sessionId: "s2", sessionManager, piGateway: gateway, pidAlive: () => false,
    });
    expect(await deadProbes.isProcessAlive()).toBe(false);
  });

  it("isControllable = session exists and is not 'ended'", async () => {
    const gateway = { isSessionConnected: () => true, sendToSession: () => true };
    const liveSm = { get: () => ({ id: "s3", status: "idle" }) };
    const liveProbes = createProductionProbes({ sessionId: "s3", sessionManager: liveSm, piGateway: gateway });
    expect(await liveProbes.isControllable()).toBe(true);

    const endedSm = { get: () => ({ id: "s3", status: "ended" }) };
    const endedProbes = createProductionProbes({ sessionId: "s3", sessionManager: endedSm, piGateway: gateway });
    expect(await endedProbes.isControllable()).toBe(false);

    const goneSm = { get: () => undefined };
    const goneProbes = createProductionProbes({ sessionId: "s3", sessionManager: goneSm as any, piGateway: gateway });
    expect(await goneProbes.isControllable()).toBe(false);
  });

  it("isModelChangeable: OBSERVES a real session.model change (toggle→observe→restore)", async () => {
    // The bridge model_update→sessionManager.update oracle, simulated: a
    // successful set_model send flips the live session.model. The probe must
    // observe THAT change (not trust the send).
    let model = "anthropic/claude-sonnet-4";
    const sessionManager = {
      get: () => ({ id: "s4", status: "idle", pid: 1, model }),
    };
    const sendToSession = vi.fn((_id: string, msg: any) => {
      // Simulate the bridge applying set_model + echoing model_update → update.
      if (msg.type === "set_model") model = `${msg.provider}/${msg.modelId}`;
      return true;
    });
    const gateway = { isSessionConnected: () => true, sendToSession };
    const probes = createProductionProbes({
      sessionId: "s4",
      sessionManager,
      piGateway: gateway,
      resolveAltModel: async () => ({ provider: "openai", modelId: "gpt-5" }),
      sleep: noSleep,
      modelObserveTimeoutMs: 50,
      modelPollIntervalMs: 10,
    });
    expect(await probes.isModelChangeable()).toBe(true);
    // It toggled to the alt AND restored the original (net-zero).
    expect(model).toBe("anthropic/claude-sonnet-4");
    const setModelSends = sendToSession.mock.calls.filter((c) => c[1].type === "set_model");
    expect(setModelSends.length).toBe(2); // toggle + restore
  });

  it("isModelChangeable: model-unreachable (send no-ops, model never changes) → false", async () => {
    // set_model "succeeds" at the transport (returns true) but the bridge
    // silently no-ops — session.model never changes. The oracle catches it by
    // OBSERVING no change within T. This is exactly RED #5 at the real-probe
    // layer: an HTTP-200-blind gate would false-green here.
    const sessionManager = {
      get: () => ({ id: "s5", status: "idle", pid: 1, model: "anthropic/claude-sonnet-4" }),
    };
    const sendToSession = vi.fn(() => true); // transport ok, but model never moves
    const gateway = { isSessionConnected: () => true, sendToSession };
    const probes = createProductionProbes({
      sessionId: "s5",
      sessionManager,
      piGateway: gateway,
      resolveAltModel: async () => ({ provider: "openai", modelId: "gpt-5" }),
      sleep: noSleep,
      modelObserveTimeoutMs: 50,
      modelPollIntervalMs: 10,
    });
    expect(await probes.isModelChangeable()).toBe(false);
  });

  it("isModelChangeable: no alternate model available → false (fail-closed, not false-green)", async () => {
    const sessionManager = {
      get: () => ({ id: "s6", status: "idle", pid: 1, model: "anthropic/claude-sonnet-4" }),
    };
    const gateway = { isSessionConnected: () => true, sendToSession: vi.fn(() => true) };
    const probes = createProductionProbes({
      sessionId: "s6",
      sessionManager,
      piGateway: gateway,
      resolveAltModel: async () => null, // single-model host
      sleep: noSleep,
    });
    expect(await probes.isModelChangeable()).toBe(false);
    // Never even attempted a set_model (nothing to toggle to).
    expect(gateway.sendToSession).not.toHaveBeenCalled();
  });
});

// ── Layer D: the REAL defaultResolveAltModel against the session-models-cache ─
//
// Regression guard for the harness-gap that the real-dashboard e2e exposed
// (dl-3547): EVERY production probe test above injects a stub `resolveAltModel`,
// so NONE exercised the real default resolver. The shipped default used to read
// the pi-ai-backed server registry (`getModelRegistry()`), which THROWS on a
// real machine (pi-ai nested under managed pi-coding-agent, top-level strategies
// miss it) → null → assertion 5 failed → resurrect 503'd on every real session.
// The fix reads the session's own bridge-pushed `models_list` catalogue instead
// (session-models-cache). These tests run the REAL resolver against that cache —
// NO stub — so this path can never silently regress again.
// See change: unend-mechanism-v2.
describe("defaultResolveAltModel reads the session-models-cache (real resolver, no stub)", () => {
  it("returns an alt != current when the cache holds >=2 distinct models", async () => {
    resetModelsCache();
    setModelsForSession("real-1", [
      { provider: "github-copilot", id: "gpt-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4" },
    ]);
    const alt = await defaultResolveAltModel("github-copilot/gpt-5.5", "real-1");
    // First model whose provider/id differs from current.
    expect(alt).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
    resetModelsCache();
  });

  it("returns null when the cache holds only the current model (single-model session)", async () => {
    resetModelsCache();
    setModelsForSession("real-2", [{ provider: "github-copilot", id: "gpt-5.5" }]);
    const alt = await defaultResolveAltModel("github-copilot/gpt-5.5", "real-2");
    expect(alt).toBeNull();
    resetModelsCache();
  });

  it("returns null when the session has no cached catalogue (fail-closed, not a pi-ai throw)", async () => {
    resetModelsCache();
    const alt = await defaultResolveAltModel("github-copilot/gpt-5.5", "never-pushed");
    expect(alt).toBeNull();
  });
});
