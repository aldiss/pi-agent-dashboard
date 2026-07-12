/**
 * Deterministic-spawn WIRING tests (design §9): A2 (readiness = register-event,
 * not sleep) + A10 (pendingResumeRegistry SURVIVES — the additive-safety gate) +
 * the flag-OFF zero-behavior-change gate.
 *
 * These drive the REAL `wireEvents` `session_register` path with real in-memory
 * registries (pendingResumeRegistry + pendingSpawnIntent siblings) and stubbed
 * gateways, so the deliver-on-register hook is exercised exactly as in prod —
 * NOT re-implemented here. The token intent and the cwd auto-resume must not
 * cross-consume.
 *
 * See change: deterministic-spawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemorySessionManager, type SessionManager } from "../memory-session-manager.js";
import { createMemoryEventStore, type EventStore } from "../memory-event-store.js";
import { createSessionOrderManager } from "../session-order-manager.js";
import { createPendingForkRegistry } from "../pending-fork-registry.js";
import { createHeadlessPidRegistry } from "../headless-pid-registry.js";
import { createPendingResumeRegistry, type PendingResumeRegistry } from "../pending-resume-registry.js";
import { createPendingSpawnIntentRegistry, type PendingSpawnIntentRegistry } from "../pending-spawn-intent-registry.js";
import { wireEvents } from "../event-wiring.js";
import type { SendPromptToExtensionMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

interface DeliveredPrompt {
  sessionId: string;
  text: string;
  images?: unknown;
}

/** Build a full PendingResumeEntry (all required fields) from just its text. */
function resumeEntry(text: string, oldSessionId = "old-sess") {
  return { text, oldSessionId, sessionFile: `/tmp/${oldSessionId}.jsonl` };
}

interface Harness {
  fireRegister: (opts: { sessionId: string; cwd: string; spawnToken?: string }) => void;
  delivered: DeliveredPrompt[];
  sessionManager: SessionManager;
  eventStore: EventStore;
  pendingResumeRegistry: PendingResumeRegistry;
  pendingSpawnIntent: PendingSpawnIntentRegistry;
}

/**
 * Build a real `wireEvents` over stubbed gateways. `deterministicEnabled`
 * drives the injected flag getter; `delivered` records every `send_prompt`.
 */
function makeHarness(deterministicEnabled: boolean): Harness {
  const sessionManager = createMemorySessionManager();
  const eventStore = createMemoryEventStore(() => true);
  const preferencesStore = { getPinnedDirectories: () => [], getSessionOrder: () => undefined, setSessionOrder: () => {} } as any;
  const sessionOrderManager = createSessionOrderManager(preferencesStore);
  const pendingForkRegistry = createPendingForkRegistry();
  const headlessPidRegistry = createHeadlessPidRegistry();
  const pendingResumeRegistry = createPendingResumeRegistry();
  const pendingSpawnIntent = createPendingSpawnIntentRegistry();

  const delivered: DeliveredPrompt[] = [];

  const piGateway = {
    sendToSession: (sessionId: string, msg: { type: string } & Record<string, unknown>) => {
      if (msg.type === "send_prompt") {
        const p = msg as unknown as SendPromptToExtensionMessage;
        delivered.push({ sessionId: p.sessionId, text: p.text, images: p.images });
      }
      return true;
    },
    isSessionConnected: () => false,
    getConnectedSessionIds: () => [],
  } as any;

  const browserGateway = {
    headlessPidRegistry,
    pendingResumeRegistry,
    pendingSpawnIntent,
    broadcastSessionAdded: () => {},
    broadcastSessionUpdated: () => {},
    broadcastSessionRemoved: () => {},
    broadcastSessionStateReset: () => {},
    broadcastToAll: () => {},
    sendToSubscribers: () => {},
  } as any;

  const directoryService = {
    knownDirectories: () => [],
    getOpenSpecData: () => undefined,
    // Register path calls this only for a brand-new cwd; resolve empty.
    onDirectoryAdded: () => Promise.resolve({ sessions: [], openspecData: { initialized: false, pending: false, changes: [] } }),
  } as any;

  wireEvents({
    sessionManager,
    eventStore,
    piGateway,
    browserGateway,
    sessionOrderManager,
    pendingForkRegistry,
    directoryService,
    knownSessionIds: new Set<string>(),
    pendingDashboardSpawns: new Map<string, number>(),
    getDeterministicSpawnEnabled: () => deterministicEnabled,
  });

  function fireRegister(opts: { sessionId: string; cwd: string; spawnToken?: string }): void {
    // Pre-register so the handler's sessionManager lookups resolve.
    sessionManager.register({ id: opts.sessionId, cwd: opts.cwd, source: "tui" });
    piGateway.onEvent(opts.sessionId, {
      type: "session_register",
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      source: "tui",
      ...(opts.spawnToken ? { spawnToken: opts.spawnToken } : {}),
    });
  }

  return { fireRegister, delivered, sessionManager, eventStore, pendingResumeRegistry, pendingSpawnIntent };
}

describe("deterministic-spawn wiring — A2 (readiness = register event)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("a POST-intent then a matching session_register resolves ok + delivers the directive ONCE", () => {
    const h = makeHarness(true);
    // Simulate POST /api/spawn/intent having recorded the intent.
    h.pendingSpawnIntent.record({
      spawnToken: "tok-a2",
      name: "Driver-A2",
      cwd: "/orch",
      flavor: "new",
      directive: { text: "kickoff: read your brief" },
    });

    h.fireRegister({ sessionId: "sess-a2", cwd: "/orch", spawnToken: "tok-a2" });

    // Delivered exactly once, with the directive text, to the registered session.
    const kickoffs = h.delivered.filter((d) => d.text === "kickoff: read your brief");
    expect(kickoffs).toHaveLength(1);
    expect(kickoffs[0]!.sessionId).toBe("sess-a2");
    // Intent resolved ok, carrying the sessionId.
    expect(h.pendingSpawnIntent.get("tok-a2")).toMatchObject({ status: "ok", sessionId: "sess-a2" });
  });

  it("boots-but-never-registers stays pending — NEVER resolves ok (the RED arm)", () => {
    const h = makeHarness(true);
    h.pendingSpawnIntent.record({
      spawnToken: "tok-noreg",
      name: "Driver-NoReg",
      cwd: "/orch",
      flavor: "new",
      directive: { text: "never delivered" },
    });

    // No session_register fires for tok-noreg.
    expect(h.pendingSpawnIntent.get("tok-noreg")).toMatchObject({ status: "pending" });
    expect(h.delivered.filter((d) => d.text === "never delivered")).toHaveLength(0);
  });

  it("a register with NO spawnToken is a clean no-op (non-spawn register)", () => {
    const h = makeHarness(true);
    h.fireRegister({ sessionId: "sess-plain", cwd: "/orch" });
    expect(h.delivered).toHaveLength(0);
  });
});

describe("deterministic-spawn wiring — flag OFF (zero behavior-change)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("with the flag OFF, a matching register does NOT deliver + leaves the intent pending", () => {
    const h = makeHarness(false);
    h.pendingSpawnIntent.record({
      spawnToken: "tok-off",
      name: "Driver-Off",
      cwd: "/orch",
      flavor: "new",
      directive: { text: "should not deliver" },
    });

    h.fireRegister({ sessionId: "sess-off", cwd: "/orch", spawnToken: "tok-off" });

    expect(h.delivered.filter((d) => d.text === "should not deliver")).toHaveLength(0);
    // Intent untouched — still pending (the hook was skipped entirely).
    expect(h.pendingSpawnIntent.get("tok-off")).toMatchObject({ status: "pending" });
  });
});

describe("deterministic-spawn wiring — A10 (pendingResumeRegistry SURVIVES)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("(a) existing cwd-keyed auto-resume still fires on register", () => {
    const h = makeHarness(true);
    h.pendingResumeRegistry.record("/orch", resumeEntry("resume-me"));
    h.fireRegister({ sessionId: "sess-resume", cwd: "/orch" });
    expect(h.delivered.filter((d) => d.text === "resume-me")).toHaveLength(1);
  });

  it("(b) a token-keyed spawn-intent does NOT consume a cwd resume entry", () => {
    const h = makeHarness(true);
    // Both a cwd resume AND a token spawn intent live for the SAME cwd.
    h.pendingResumeRegistry.record("/shared", resumeEntry("cwd-resume"));
    h.pendingSpawnIntent.record({
      spawnToken: "tok-b", name: "B", cwd: "/shared", flavor: "new",
      directive: { text: "token-directive" },
    });

    // Register WITH the token: both deliver (token intent + cwd resume), and the
    // cwd resume entry is consumed by the cwd path — not by the token path.
    h.fireRegister({ sessionId: "sess-b", cwd: "/shared", spawnToken: "tok-b" });

    expect(h.delivered.filter((d) => d.text === "token-directive")).toHaveLength(1);
    expect(h.delivered.filter((d) => d.text === "cwd-resume")).toHaveLength(1);
    // cwd resume entry is now consumed (a second register delivers nothing new).
    expect(h.pendingResumeRegistry.consume("/shared")).toBeUndefined();
    // token intent resolved ok.
    expect(h.pendingSpawnIntent.get("tok-b")).toMatchObject({ status: "ok" });
  });

  it("(c) a cwd resume does NOT consume a token intent (register WITHOUT token)", () => {
    const h = makeHarness(true);
    h.pendingResumeRegistry.record("/shared2", resumeEntry("cwd-only"));
    h.pendingSpawnIntent.record({
      spawnToken: "tok-c", name: "C", cwd: "/shared2", flavor: "new",
      directive: { text: "token-untouched" },
    });

    // A plain register (no token) fires the cwd resume but leaves the token intent PENDING.
    h.fireRegister({ sessionId: "sess-c", cwd: "/shared2" });

    expect(h.delivered.filter((d) => d.text === "cwd-only")).toHaveLength(1);
    expect(h.delivered.filter((d) => d.text === "token-untouched")).toHaveLength(0);
    expect(h.pendingSpawnIntent.get("tok-c")).toMatchObject({ status: "pending" });
  });

  it("(d) two same-cwd spawns with DIFFERENT tokens each deliver their OWN directive", () => {
    const h = makeHarness(true);
    h.pendingSpawnIntent.record({
      spawnToken: "tok-d1", name: "D1", cwd: "/shared3", flavor: "new",
      directive: { text: "for-D1" },
    });
    h.pendingSpawnIntent.record({
      spawnToken: "tok-d2", name: "D2", cwd: "/shared3", flavor: "context-rotation",
      directive: { text: "for-D2" },
    });

    h.fireRegister({ sessionId: "sess-d1", cwd: "/shared3", spawnToken: "tok-d1" });
    h.fireRegister({ sessionId: "sess-d2", cwd: "/shared3", spawnToken: "tok-d2" });

    expect(h.delivered.filter((d) => d.text === "for-D1")).toHaveLength(1);
    expect(h.delivered.filter((d) => d.text === "for-D2")).toHaveLength(1);
    expect(h.pendingSpawnIntent.get("tok-d1")).toMatchObject({ status: "ok", sessionId: "sess-d1" });
    expect(h.pendingSpawnIntent.get("tok-d2")).toMatchObject({ status: "ok", sessionId: "sess-d2" });
  });

  it("(e) token-expiry clears ONLY the token intent, not the cwd resume", () => {
    // Independent key spaces + independent TTLs: the cwd resume registry has a
    // hardcoded 30s TTL; the token intent registry a 180s TTL. Expiring the
    // token intent (here via a short injected TTL) must not perturb the cwd
    // resume. Real setTimeout runs under the describe-block's fake timers, so
    // the cwd resume's 30s timer has NOT fired at the point we assert.
    let t = 1_000;
    const spawnReg = createPendingSpawnIntentRegistry({ now: () => t, ttlMs: 1_000 });
    const resumeReg = createPendingResumeRegistry();

    spawnReg.record({ spawnToken: "tok-e", name: "E", cwd: "/e", flavor: "new", directive: { text: "x" } });
    resumeReg.record("/e", resumeEntry("cwd-survives"));

    // Advance the token registry's injected clock past its 1s TTL (real wall
    // clock / fake timers only advanced a hair — well under the resume's 30s).
    t += 1_500;
    expect(spawnReg.get("tok-e")).toBeNull(); // token intent swept
    expect(resumeReg.consume("/e")).toMatchObject({ text: "cwd-survives" }); // cwd resume survives
    resumeReg.dispose();
  });
});
