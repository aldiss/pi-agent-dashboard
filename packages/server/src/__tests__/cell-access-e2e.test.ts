import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

const SECRET = "cell-e2e-test-secret";
const authConfig: AuthConfig = {
  secret: SECRET,
  providers: { github: { clientId: "test-client", clientSecret: "test-secret" } },
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};

function token(username: "op" | "guest") {
  return signToken({
    sub: `${username}@example.com`,
    username,
    name: username,
    provider: "github",
  }, SECRET);
}

function openBridge(url: string, registration: Record<string, unknown>) {
  const messages: any[] = [];
  const ws = new WebSocket(url);
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "session_register", ...registration }));
      resolve();
    });
    ws.once("error", reject);
  });
  return { ws, messages, opened };
}

function openBrowser(url: string, jwt: string) {
  const messages: any[] = [];
  const ws = new WebSocket(url, { headers: { Cookie: `${COOKIE_NAME}=${jwt}` } });
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages, opened };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("direct dashboard cell boundary — assembled REST + WS loop", () => {
  let handle: TestServerHandle | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try { ws.terminate(); } catch { /* noop */ }
    }
    if (handle) await handle.stop();
    handle = undefined;
  });

  it("guest sees/co-drives cell A only; operator sees all; outside probes match missing; background state is untouched", async () => {
    const home = process.env.HOME!;
    const registryPath = path.join(home, ".pi", "orchestration-state", "cell-driver-registry.json");
    const messengerDir = path.join(home, ".pi", "agent", "messenger", "registry");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.mkdirSync(messengerDir, { recursive: true });
    const configPath = path.join(home, ".pi", "dashboard", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ auth: authConfig }));
    fs.writeFileSync(registryPath, JSON.stringify({ drivers: {
      Alpha: { real_name: "Alpha", cell: "cell-a", pid: 111 },
      Beta: { real_name: "Beta", cell: "cell-b", pid: 222 },
    } }));
    fs.writeFileSync(path.join(messengerDir, "Alpha.json"), JSON.stringify({ name: "Alpha", sessionId: "sid-a", pid: 111 }));
    fs.writeFileSync(path.join(messengerDir, "Beta.json"), JSON.stringify({ name: "Beta", sessionId: "sid-b", pid: 222 }));

    handle = await createTestServer({ authConfig, resolvedTrustedNetworks: ["100.64.0.0/10"] });
    const bridgeUrl = `ws://127.0.0.1:${handle.piPort}`;
    const bridgeA = openBridge(bridgeUrl, { sessionId: "sid-a", cwd: "/shared", name: "Alpha", source: "tui", pid: 111 });
    const bridgeB = openBridge(bridgeUrl, { sessionId: "sid-b", cwd: "/shared", name: "Beta", source: "tui", pid: 222 });
    sockets.push(bridgeA.ws, bridgeB.ws);
    await Promise.all([bridgeA.opened, bridgeB.opened]);
    await waitFor(() => !!handle!.server.sessionManager.get("sid-a") && !!handle!.server.sessionManager.get("sid-b"));
    const seqA = handle.server.eventStore.insertEvent("sid-a", { eventType: "message_update", timestamp: 1, data: { text: "A" } } as any);
    const seqB = handle.server.eventStore.insertEvent("sid-b", { eventType: "message_update", timestamp: 1, data: { text: "B" } } as any);

    const wsUrl = `ws://127.0.0.1:${handle.httpPort}/ws`;
    const guest = openBrowser(wsUrl, token("guest"));
    const op = openBrowser(wsUrl, token("op"));
    sockets.push(guest.ws, op.ws);
    await Promise.all([guest.opened, op.opened]);
    await waitFor(() => guest.messages.some((m) => m.type === "sessions_snapshot") && op.messages.some((m) => m.type === "sessions_snapshot"));

    const guestSnapshot = guest.messages.find((m) => m.type === "sessions_snapshot");
    const opSnapshot = op.messages.find((m) => m.type === "sessions_snapshot");
    expect(guestSnapshot.sessions.map((s: any) => s.id)).toEqual(["sid-a"]);
    expect(guestSnapshot.orders["/shared"] ?? []).not.toContain("sid-b");
    expect(opSnapshot.sessions.map((s: any) => s.id)).toEqual(expect.arrayContaining(["sid-a", "sid-b"]));

    // Inside co-drive reaches the allowed bridge; outside and command-form do not.
    guest.ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sid-a", text: "inside raw" }));
    guest.ws.send(JSON.stringify({ type: "abort", sessionId: "sid-a" }));
    await waitFor(() => bridgeA.messages.some((m) => m.type === "send_prompt" && m.text === "inside raw"));
    await waitFor(() => bridgeA.messages.some((m) => m.type === "abort"));
    const beforeOutside = bridgeB.messages.length;
    guest.ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sid-b", text: "outside raw" }));
    guest.ws.send(JSON.stringify({ type: "abort", sessionId: "sid-b" }));
    guest.ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sid-a", text: "/reload" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bridgeB.messages).toHaveLength(beforeOutside);
    expect(bridgeA.messages.some((m) => m.type === "send_prompt" && m.text === "/reload")).toBe(false);

    // Operator remains dashboard-wide.
    op.ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sid-b", text: "operator raw" }));
    await waitFor(() => bridgeB.messages.some((m) => m.type === "send_prompt" && m.text === "operator raw"));

    const terminalStatus = await new Promise<number>((resolve) => {
      const terminal = new WebSocket(`ws://127.0.0.1:${handle!.httpPort}/ws/terminal/guessed`, {
        headers: { Cookie: `${COOKIE_NAME}=${token("guest")}`, "X-Forwarded-For": "203.0.113.40" },
      });
      terminal.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      terminal.on("error", () => {});
    });
    expect(terminalStatus).toBe(403);

    guest.ws.send(JSON.stringify({ type: "subscribe", sessionId: "sid-a", lastSeq: seqA }));
    guest.ws.send(JSON.stringify({ type: "subscribe", sessionId: "sid-b", lastSeq: seqB }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    handle.server.browserGateway.broadcastEvent("sid-a", seqA + 1, { eventType: "message_update", timestamp: 2, data: { text: "A2" } });
    handle.server.browserGateway.broadcastEvent("sid-b", seqB + 1, { eventType: "message_update", timestamp: 2, data: { text: "B2" } });
    handle.server.browserGateway.broadcastToAll({ type: "planted_unknown", cwd: "/outside" } as any);
    handle.server.browserGateway.broadcastPluginMessage({
      type: "event",
      sessionId: "sid-a",
      seq: 99,
      event: { data: { outsideSessionId: "sid-b", outsideCwd: "/outside" } },
    });
    await waitFor(() => guest.messages.some((m) => m.type === "event" && m.sessionId === "sid-a"));
    await waitFor(() => op.messages.some((m) => m.type === "planted_unknown"));
    await waitFor(() => op.messages.some((m) => m.seq === 99));
    expect(guest.messages.some((m) => m.sessionId === "sid-b")).toBe(false);
    expect(guest.messages.some((m) => m.type === "planted_unknown")).toBe(false);
    expect(guest.messages.some((m) => m.seq === 99)).toBe(false);

    const base = `http://127.0.0.1:${handle.httpPort}`;
    const headers = {
      Cookie: `${COOKIE_NAME}=${token("guest")}`,
      "X-Forwarded-For": "203.0.113.50",
    };
    const guestSessions = await fetch(`${base}/api/sessions`, { headers }).then((r) => r.json());
    expect(guestSessions.data.map((s: any) => s.id)).toEqual(["sid-a"]);
    const deepLink = await fetch(`${base}/session/sid-a`, { headers });
    expect(deepLink.status).not.toBe(403); // SPA fallback may be 404 in API-only fixture mode.

    const allowedEvent = await fetch(`${base}/api/events/sid-a/${seqA}`, { headers });
    expect(allowedEvent.status).toBe(200);
    const outsideEvent = await fetch(`${base}/api/events/sid-b/${seqB}`, { headers });
    const missingEvent = await fetch(`${base}/api/events/missing/${seqB}`, { headers });
    expect(outsideEvent.status).toBe(404);
    expect(missingEvent.status).toBe(404);
    expect(await outsideEvent.text()).toBe(await missingEvent.text());

    const outsidePrompt = await fetch(`${base}/api/session/sid-b/prompt`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    const missingPrompt = await fetch(`${base}/api/session/missing/prompt`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(outsidePrompt.status).toBe(404);
    expect(missingPrompt.status).toBe(404);
    expect(await outsidePrompt.text()).toBe(await missingPrompt.text());

    const insideFile = await fetch(`${base}/api/session-file?sessionId=sid-a&path=README.md`, { headers });
    expect(insideFile.status).toBe(403);

    // Verified service/background path remains outside guest projection.
    const servicePrompt = await fetch(`${base}/api/session/sid-b/prompt`, {
      method: "POST",
      headers: {
        "X-Forwarded-For": "203.0.113.60",
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "background service" }),
    });
    expect(servicePrompt.status).toBe(200);
    await waitFor(() => bridgeB.messages.some((m) => m.type === "send_prompt" && m.text === "background service"));

    // Live allowedUsers revocation closes an existing guest cookie and pushes an
    // empty replacement snapshot without requiring a restart.
    const snapshotsBeforeRevoke = guest.messages.filter((m) => m.type === "sessions_snapshot").length;
    const revoke = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: {
        Cookie: `${COOKIE_NAME}=${token("op")}`,
        "X-Forwarded-For": "203.0.113.70",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auth: { allowedUsers: ["op"] } }),
    });
    expect(revoke.status).toBe(200);
    expect((await revoke.json()).restartRequired).toBe(false);
    await waitFor(() => guest.messages.filter((m) => m.type === "sessions_snapshot").length > snapshotsBeforeRevoke);
    const lastGuestSnapshot = guest.messages.filter((m) => m.type === "sessions_snapshot").at(-1);
    expect(lastGuestSnapshot).toMatchObject({ sessions: [], orders: {} });
    const bridgeACount = bridgeA.messages.length;
    guest.ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sid-a", text: "after revoke" }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bridgeA.messages).toHaveLength(bridgeACount);

    // Direct guest probes changed no outside/background session state.
    expect(handle.server.sessionManager.get("sid-b")).toMatchObject({ status: "active", hidden: false });
  }, 25_000);
});
