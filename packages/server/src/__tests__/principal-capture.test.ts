/**
 * Build 0 (PRINCIPAL-CAPTURE) red-arm tests.
 *
 * Two invariants, each proven to RED-ARM (plant the violation → watch it fail →
 * fix → pass). See the build report for the captured failing/passing runs.
 *
 *  (a) principal-required — with the multi-operator gate ON, a browser `/ws`
 *      connection with NO valid `pi_dash_token` is REFUSED even from
 *      loopback / trusted-net. The verified principal (not a bare boolean) is
 *      returned so it can bind to the connection.
 *
 *  (b) anti-spoof — a `send_prompt` carrying a client-supplied `author` /
 *      `principal` field does NOT become the trusted principal. The server
 *      derives the actor only from the connection-bound principal, and the
 *      object forwarded to the bridge is reconstructed field-by-field (never
 *      `...msg`-spread), so no client-claimed identity rides through.
 */
import { describe, it, expect, vi } from "vitest";
import { validateWsUpgrade } from "../auth-plugin.js";
import { signToken, COOKIE_NAME, type TokenPayload } from "../auth.js";
import { authorizeSessionAction } from "../session-authz.js";
import { handleSendPrompt } from "../browser-handlers/session-action-handler.js";
import type { BrowserHandlerContext } from "../browser-handlers/handler-context.js";

const SECRET = "test-secret-for-principal-capture";
const TAILNET_IP = "100.101.102.103"; // inside 100.64.0.0/10 (tailnet CGNAT)
const TRUSTED = ["100.64.0.0/10", "10.0.0.0/8"];

function validCookie(sub = "op1@example.com"): string {
  const token = signToken({ sub, name: "Op One", username: "op1", provider: "github" }, SECRET);
  return `${COOKIE_NAME}=${token}`;
}

// ───────────────────────────────────────────────────────────────────────────
// (a) principal-required — the /ws upgrade gate
// ───────────────────────────────────────────────────────────────────────────

describe("Build 0 (a) principal-required — validateWsUpgrade multi-operator gate", () => {
  it("multi-op ON: REFUSES loopback with no cookie (no bypass for own device)", () => {
    const decision = validateWsUpgrade(undefined, "127.0.0.1", SECRET, TRUSTED, /* requireBrowserAuth */ true);
    expect(decision.allowed).toBe(false);
    expect(decision.principal).toBeNull();
  });

  it("multi-op ON: REFUSES a trusted-network peer with no cookie", () => {
    const decision = validateWsUpgrade(undefined, TAILNET_IP, SECRET, TRUSTED, true);
    expect(decision.allowed).toBe(false);
    expect(decision.principal).toBeNull();
  });

  it("multi-op ON: REFUSES loopback with an invalid cookie", () => {
    const decision = validateWsUpgrade(`${COOKIE_NAME}=garbage`, "127.0.0.1", SECRET, TRUSTED, true);
    expect(decision.allowed).toBe(false);
  });

  it("multi-op ON: ADMITS a valid cookie and RETURNS the decoded principal (even from a trusted device)", () => {
    const decision = validateWsUpgrade(validCookie("op1@example.com"), TAILNET_IP, SECRET, TRUSTED, true);
    expect(decision.allowed).toBe(true);
    expect(decision.principal).not.toBeNull();
    expect(decision.principal?.sub).toBe("op1@example.com");
  });

  it("single-op OFF (default): loopback/trusted-net STILL bypass with no cookie (byte-unchanged)", () => {
    // This is the invariant that proves the flag is OFF-safe: with
    // requireBrowserAuth omitted the decision matches today's boolean gate.
    expect(validateWsUpgrade(undefined, "127.0.0.1", SECRET, TRUSTED).allowed).toBe(true);
    expect(validateWsUpgrade(undefined, TAILNET_IP, SECRET, TRUSTED).allowed).toBe(true);
    expect(validateWsUpgrade(undefined, "1.2.3.4", SECRET, TRUSTED).allowed).toBe(false);
  });

  it("central gate: multi-op ON refuses a human actor with a null principal at the send seam", () => {
    // Defense-in-depth: the send-seam gate also refuses a principal-less human
    // when the flag is on (the upgrade gate already refused the connection).
    const denied = authorizeSessionAction({
      actor: { kind: "human", principal: null },
      action: "send_prompt",
      requireBrowserAuth: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("no-principal");

    // …and ADMITS a human actor that carries a bound principal.
    const principal = { sub: "op1@example.com", name: "Op One", username: "op1", provider: "github", exp: 0 } as TokenPayload;
    const allowed = authorizeSessionAction({
      actor: { kind: "human", principal },
      action: "send_prompt",
      requireBrowserAuth: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it("central gate: single-op OFF allows a null-principal human (byte-unchanged)", () => {
    const decision = authorizeSessionAction({
      actor: { kind: "human", principal: null },
      action: "send_prompt",
      requireBrowserAuth: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) anti-spoof — send_prompt never adopts a client-supplied author/principal
// ───────────────────────────────────────────────────────────────────────────

/** Build a minimal ctx whose piGateway.sendToSession captures the forwarded object. */
function makeSpoofCtx(principal: TokenPayload | null, requireBrowserAuth: boolean) {
  const forwarded: Array<Record<string, unknown>> = [];
  const sessionManager = {
    // A live (streaming) session → handleSendPrompt takes the forward-to-bridge
    // branch (not the ended→auto-resume branch).
    get: vi.fn(() => ({ sessionId: "s1", status: "streaming", cwd: "/tmp", sessionFile: "/tmp/s1.jsonl" })),
    update: vi.fn(),
  };
  const piGateway = {
    sendToSession: vi.fn((_sid: string, obj: Record<string, unknown>) => {
      forwarded.push(obj);
      return true;
    }),
  };
  const headlessPidRegistry = { getPid: vi.fn(() => undefined) }; // not a headless /reload
  const ctx = {
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0 } as any,
    sessionManager: sessionManager as any,
    eventStore: {} as any,
    piGateway: piGateway as any,
    headlessPidRegistry: headlessPidRegistry as any,
    pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() } as any,
    principal,
    requireBrowserAuth,
    sendTo: vi.fn(),
    broadcast: vi.fn(),
    getSubscribers: () => [],
    trackUiRequest: vi.fn(),
    replayPendingUiRequests: vi.fn(),
    markReplaying: vi.fn(),
    clearReplaying: vi.fn(),
  } as unknown as BrowserHandlerContext;
  return { ctx, forwarded, piGateway };
}

describe("Build 0 (b) anti-spoof — send_prompt does not adopt a client-supplied author", () => {
  it("drops a client-supplied `author`/`principal` field; forwards only the reconstructed fields", async () => {
    const principal = { sub: "op1@example.com", name: "Op One", username: "op1", provider: "github", exp: 0 } as TokenPayload;
    const { ctx, forwarded } = makeSpoofCtx(principal, /* multi-op */ true);

    // Attacker crafts a send carrying a forged author + principal.
    const spoofMsg = {
      type: "send_prompt",
      sessionId: "s1",
      text: "hello",
      author: "president@whitehouse.gov",
      principal: { sub: "president@whitehouse.gov", name: "Not Op", username: "evil", provider: "github" },
    } as any;

    await handleSendPrompt(spoofMsg, ctx);

    // Exactly one forward to the bridge.
    expect(forwarded).toHaveLength(1);
    const obj = forwarded[0];

    // The forged fields MUST NOT ride through — the handler reconstructs the
    // forwarded object field-by-field (never `...msg`-spread).
    expect(obj).not.toHaveProperty("author");
    expect(obj).not.toHaveProperty("principal");

    // Only the expected reconstructed fields are present.
    expect(obj.type).toBe("send_prompt");
    expect(obj.sessionId).toBe("s1");
    expect(obj.text).toBe("hello");
    expect(Object.keys(obj).sort()).toEqual(["images", "sessionId", "text", "type"].sort());
  });

  it("single-op OFF: same anti-spoof holds (forged author never forwarded)", async () => {
    const { ctx, forwarded } = makeSpoofCtx(/* principal */ null, /* multi-op */ false);
    const spoofMsg = {
      type: "send_prompt",
      sessionId: "s1",
      text: "hi",
      author: "evil@example.com",
    } as any;

    await handleSendPrompt(spoofMsg, ctx);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toHaveProperty("author");
  });
});
