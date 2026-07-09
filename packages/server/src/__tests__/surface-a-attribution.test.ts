/**
 * Surface A (per-turn author attribution) red-arm tests — server side.
 *
 * Each invariant is PROVEN to red-arm: the build report captures the
 * plant-violation → FAIL → fix → PASS bite. These cover:
 *
 *  #2 BA-2 prompt_response spoof + delivery — the browser-gateway
 *     `prompt_response` COVER reconstructs field-by-field + stamps the author
 *     from the bound principal (never the client body), AND the functional
 *     PromptBus round-trip fields survive (delivery preserved).
 *  #3 BA-2 ended-session replay (locus-2) — the ended-session auto-resume
 *     carries the RECORD-TIME author through `PendingResumeEntry.author`.
 *  #5 BA-5 flag-off byte-unchanged — flag OFF derives no principal → no author
 *     is stamped anywhere (single-operator path identical to today).
 */
import { describe, it, expect, vi } from "vitest";
import type { TokenPayload } from "../auth.js";
import { deriveAuthor } from "../derive-author.js";
import { handleSendPrompt } from "../browser-handlers/session-action-handler.js";
import type { BrowserHandlerContext } from "../browser-handlers/handler-context.js";
import { createPendingResumeRegistry } from "../pending-resume-registry.js";
import { buildPromptResponseForward } from "../prompt-response-forward.js";

function principalOf(sub: string): TokenPayload {
  return { sub, name: "Op One", username: "op1", provider: "github", exp: 0 } as TokenPayload;
}

// ───────────────────────────────────────────────────────────────────────────
// #5 BA-5 flag-off byte-unchanged (derive-author is the single stamp source)
// ───────────────────────────────────────────────────────────────────────────

describe("Surface A #5 — flag-off byte-unchanged (deriveAuthor)", () => {
  it("null principal (single-operator) → NO author derived", () => {
    expect(deriveAuthor(null)).toBeUndefined();
    expect(deriveAuthor(undefined)).toBeUndefined();
  });

  it("bound principal (multi-operator) → structured author derived", () => {
    expect(deriveAuthor(principalOf("op1@example.com"))).toEqual({
      sub: "op1@example.com",
      display: "Op One",
    });
  });

  it("display fallback chain: name → username → sub", () => {
    expect(deriveAuthor({ sub: "s", name: "", username: "uname", provider: "github", exp: 0 } as TokenPayload))
      .toEqual({ sub: "s", display: "uname" });
    expect(deriveAuthor({ sub: "only-sub", name: "", username: "", provider: "github", exp: 0 } as TokenPayload))
      .toEqual({ sub: "only-sub", display: "only-sub" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #3 BA-2 ended-session replay (locus-2) carries record-time author
// ───────────────────────────────────────────────────────────────────────────

/** Minimal ctx whose session is ENDED → handleSendPrompt records a pending resume. */
function makeEndedCtx(principal: TokenPayload | null, requireBrowserAuth: boolean) {
  const recorded: Array<{ cwd: string; entry: any }> = [];
  const pendingResumeRegistry = {
    record: vi.fn((cwd: string, entry: any) => { recorded.push({ cwd, entry }); }),
    consume: vi.fn(),
    dispose: vi.fn(),
  };
  const sessionManager = {
    get: vi.fn(() => ({ sessionId: "s1", status: "ended", cwd: "/tmp/w", sessionFile: "/tmp/w/s1.jsonl", resuming: false })),
    update: vi.fn(),
  };
  const ctx = {
    ws: { readyState: 1, OPEN: 1, bufferedAmount: 0 } as any,
    sessionManager: sessionManager as any,
    eventStore: {} as any,
    piGateway: { sendToSession: vi.fn(() => true) } as any,
    headlessPidRegistry: { getPid: vi.fn(() => undefined) } as any,
    pendingResumeRegistry: pendingResumeRegistry as any,
    pendingResumeIntents: { record: vi.fn() } as any,
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
  return { ctx, recorded };
}

describe("Surface A #3 — ended-session replay carries record-time author (locus-2)", () => {
  it("records the server-derived author at record-time when multi-op", async () => {
    const nonceSub = `op-${Math.floor(performance.now() * 1000)}@example.com`;
    const { ctx, recorded } = makeEndedCtx(principalOf(nonceSub), /* multi-op */ true);
    // Spawn is attempted after record; it will fail (no real process manager) but
    // the record happens first — that is what we assert.
    await handleSendPrompt({ type: "send_prompt", sessionId: "s1", text: "resume me", author: "forged@evil" } as any, ctx).catch(() => {});
    expect(recorded).toHaveLength(1);
    // The record-time author is the SERVER-DERIVED one (nonce sub), never the
    // forged client field.
    expect(recorded[0].entry.author).toEqual({ sub: nonceSub, display: "Op One" });
    expect(recorded[0].entry.author.sub).not.toBe("forged@evil");
  });

  it("flag OFF → no author recorded (byte-unchanged)", async () => {
    const { ctx, recorded } = makeEndedCtx(/* principal */ null, /* single-op */ false);
    await handleSendPrompt({ type: "send_prompt", sessionId: "s1", text: "resume me" } as any, ctx).catch(() => {});
    expect(recorded).toHaveLength(1);
    expect(recorded[0].entry).not.toHaveProperty("author");
  });

  it("registry carries the author through record → consume (server-side-only)", () => {
    const reg = createPendingResumeRegistry();
    const author = { sub: "op1@example.com", display: "Op One" };
    reg.record("/tmp/w", { text: "hi", oldSessionId: "s1", sessionFile: "/tmp/w/s1.jsonl", author });
    const consumed = reg.consume("/tmp/w");
    expect(consumed?.author).toEqual(author);
    reg.dispose();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #2 BA-2 prompt_response spoof + delivery (browser-gateway COVER)
// ───────────────────────────────────────────────────────────────────────────

describe("Surface A #2 — prompt_response COVER: spoof-proof + delivery-preserving", () => {
  it("stamps the SERVER-DERIVED author, drops a forged one, preserves delivery fields", () => {
    const nonceSub = `op-${Math.floor(performance.now() * 1000)}@example.com`;
    const forged = {
      type: "prompt_response",
      sessionId: "s1",
      promptId: "p-42",
      answer: "yes, proceed",
      source: "dashboard-default",
      // forged identity fields an attacker might inject:
      author: "president@whitehouse.gov",
      principal: { sub: "president@whitehouse.gov" },
    } as any;

    const forward = buildPromptResponseForward(forged, principalOf(nonceSub)) as any;

    // Author is server-derived from the bound principal — NOT the forged string.
    expect(forward.author).toEqual({ sub: nonceSub, display: "Op One" });
    expect(forward.author.sub).not.toBe("president@whitehouse.gov");
    // The forged top-level `principal` field never rides through (field-by-field).
    expect(forward).not.toHaveProperty("principal");

    // DELIVERY preserved: the functional PromptBus round-trip fields survive
    // verbatim so the answer still reaches PromptBus.respond.
    expect(forward.type).toBe("prompt_response");
    expect(forward.sessionId).toBe("s1");
    expect(forward.promptId).toBe("p-42");
    expect(forward.answer).toBe("yes, proceed");
    expect(forward.source).toBe("dashboard-default");
    // Only the reconstructed fields (no forged extras).
    expect(Object.keys(forward).sort()).toEqual(
      ["answer", "author", "promptId", "sessionId", "source", "type"].sort(),
    );
  });

  it("cancelled round-trip is preserved; flag OFF (null principal) → no author", () => {
    const cancel = {
      type: "prompt_response",
      sessionId: "s1",
      promptId: "p-7",
      cancelled: true,
      source: "tui",
    } as any;
    const forward = buildPromptResponseForward(cancel, /* single-op */ null) as any;
    expect(forward.cancelled).toBe(true);
    expect(forward.source).toBe("tui");
    // Flag OFF → no author key at all (byte-unchanged delivery).
    expect(forward).not.toHaveProperty("author");
  });
});
