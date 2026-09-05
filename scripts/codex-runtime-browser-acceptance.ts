/**
 * UI-only (default): node_modules/.bin/tsx scripts/codex-runtime-browser-acceptance.ts --check-ui
 * Real model turns: node_modules/.bin/tsx scripts/codex-runtime-browser-acceptance.ts --live
 * Browser install: PLAYWRIGHT_BROWSERS_PATH=/tmp/codex-runtime-playwright node_modules/.bin/playwright install chromium
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import type { BrowserContext, Page } from "playwright";
import { discoverPlugins } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import { spawnNodeScript } from "@blackbelt-technology/pi-dashboard-shared/platform/node-spawn.js";
import { isProcessAlive, killProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { spawnSync, type ChildProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Use --check-ui (default, zero model turns) or --live (four real model turns). Artifacts stay under /tmp.");
  process.exit(0);
}
assert(args.every(arg => arg === "--live" || arg === "--check-ui"), "Unknown acceptance flag");
assert(!(args.includes("--live") && args.includes("--check-ui")), "Choose one mode");
const live = args.includes("--live");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert(fs.existsSync(path.join(repo, "packages", "client", "dist", "index.html")), "Build client with npm run build first");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/tmp/codex-runtime-playwright";
const { chromium } = await import("playwright");
assert(fs.existsSync(chromium.executablePath()), "Matching Chromium missing; run the scoped browser install command above");

const home = fs.mkdtempSync("/tmp/codex-runtime-browser-");
const workspace = path.join(home, "workspace");
fs.mkdirSync(workspace);
const cwd = fs.realpathSync(workspace);
const dashboardDir = path.join(home, ".pi", "dashboard");
const registryDir = path.join(home, ".pi", "agent", "messenger", "registry");
fs.mkdirSync(dashboardDir, { recursive: true });
fs.mkdirSync(registryDir, { recursive: true });
fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
const registryFile = path.join(home, "empty-cell-registry.json");
fs.writeFileSync(registryFile, JSON.stringify({ drivers: {} }), { mode: 0o600 });
const secret = randomBytes(32).toString("hex");
const username = "browser-acceptance";
const cookie = jwt.sign({ sub: username, username, name: "Browser acceptance", provider: "github" }, secret, { expiresIn: "1h" });
fs.writeFileSync(path.join(dashboardDir, "config.json"), JSON.stringify({
  autoStart: false, spawnStrategy: "headless", piHost: "127.0.0.1", bridge: { requireToken: false },
  auth: { secret, providers: { github: { clientId: "fixture", clientSecret: "fixture" } }, allowedUsers: [username], operatorUsers: [username], requireBrowserAuth: true, localBridgeOperator: null },
  runtimes: { codex: { enabled: live, model: "gpt-6-astra", baseUrl: "http://127.0.0.1:4143/v1", envKey: "OPENAI_API_KEY" } },
  plugins: Object.fromEntries(discoverPlugins(repo).map(({ manifest }) => [manifest.id, { enabled: false }])),
}), { mode: 0o600 });
fs.writeFileSync(path.join(dashboardDir, "preferences.json"), JSON.stringify({ pinnedDirectories: [cwd], sessionOrder: {} }), { mode: 0o600 });

type RunningServer = { child: ChildProcess; pid: number; httpPort: number; piPort: number; base: string };
type Frame = { at: number; direction: "received" | "sent"; message: any };
const frames: Frame[] = [];
const evidence: Record<string, any> = { mode: live ? "live" : "ui-only", result: "RUNNING", artifactDir: home, cwd, steps: [], dashboardPids: [], pageErrors: [], blockedRequests: [] };
let currentServer: RunningServer | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let serverGeneration = 0;

function record(step: string, data: Record<string, unknown> = {}) {
  evidence.steps.push({ step, at: new Date().toISOString(), ...data });
  fs.writeFileSync(path.join(home, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ step, artifactDir: home, ...data }));
}

async function poll<T>(probe: () => T | undefined | Promise<T | undefined>, label: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await probe();
    if (value !== undefined && value !== false && value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function startServer(ports?: { httpPort: number; piPort: number }): Promise<RunningServer> {
  const log = path.join(home, `dashboard-${++serverGeneration}.log`);
  const fd = fs.openSync(log, "w", 0o600);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    PI_DASHBOARD_FIXTURE_MODE: "1", PI_DASHBOARD_NO_RECLAIM: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_MESSENGER_REGISTRY_DIR: registryDir, PI_CELL_DRIVER_REGISTRY_FILE: registryFile };
  delete env.NODE_OPTIONS;
  delete env.PI_DASHBOARD_URL;
  const child = spawnNodeScript({ entry: path.join(repo, "scripts", "codex-runtime-browser-server.ts"), loader: import.meta.resolve("tsx"),
    args: [String(ports?.httpPort ?? 0), String(ports?.piPort ?? 0)],
    spawnOptions: { cwd: repo, env, stdio: ["ignore", fd, fd, "ipc"], detached: false, shell: false } });
  fs.closeSync(fd);
  assert(child.pid, "Dashboard child has no PID");
  const server: RunningServer = { child, pid: child.pid, httpPort: 0, piPort: 0, base: "" };
  currentServer = server;
  let ready: any;
  child.on("message", message => { if ((message as any)?.type === "ready") ready = message; });
  await poll(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dashboard exited before ready; inspect ${log}`);
    return ready;
  }, "dashboard child ready");
  assert.equal(ready.pid, child.pid);
  assert(ready.httpPort > 0 && ready.piPort > 0 && ready.httpPort !== ready.piPort);
  server.httpPort = ready.httpPort; server.piPort = ready.piPort; server.base = `http://127.0.0.1:${ready.httpPort}`;
  evidence.dashboardPids.push(server.pid);
  record("dashboard-ready", { pid: server.pid, httpPort: server.httpPort, piPort: server.piPort });
  return server;
}

async function stopServer() {
  const server = currentServer;
  if (!server) return;
  try {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.send?.({ type: "stop" });
      await poll(() => server.child.exitCode !== null || server.child.signalCode !== null || undefined, "owned dashboard exit", 20_000);
    }
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) await killProcess(server.pid, { timeoutMs: 3000 });
    currentServer = undefined;
  }
  record("dashboard-stopped", { pid: server.pid });
}

async function sessions(): Promise<DashboardSession[]> {
  const response = await context!.request.get(`${currentServer!.base}/api/sessions`);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
}
async function session(id: string): Promise<DashboardSession> {
  const row = (await sessions()).find(row => row.id === id);
  assert(row, "Codex session missing from dashboard API");
  return row;
}
function nativeProcess(row: DashboardSession) {
  assert(Number.isInteger(row.pid) && row.pid! > 0, "Codex PID missing");
  const result = spawnSync<string>("ps", ["-p", String(row.pid), "-o", "command="], { encoding: "utf8", shell: false, timeout: 3000 });
  assert.equal(result.status, 0, "Unable to inspect owned Codex PID");
  const command = result.stdout.trim();
  assert(command.includes("app-server") && !/(?:^|\s)tmux(?:\s|$)/.test(command), "Codex must run app-server without tmux");
  const tree = spawnSync<string>("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", shell: false, timeout: 3000 });
  assert.equal(tree.status, 0, "Unable to inspect owned Codex descendants");
  const processes = tree.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([row.pid!]);
  for (const parent of owned) {
    for (const [pid, ppid] of processes) if (ppid === parent) owned.add(pid);
  }
  return { pid: row.pid!, command, descendantPids: [...owned].filter(pid => pid !== row.pid) };
}
function eventsSince(index: number, id: string) {
  return frames.slice(index).filter(frame => frame.direction === "received" && frame.message.type === "event" && frame.message.sessionId === id);
}
function assistantText(events: Frame[]) {
  return events.filter(frame => frame.message.event.eventType === "message_end" && frame.message.event.data.message?.role === "assistant")
    .flatMap(frame => frame.message.event.data.message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
}
async function screenshot(name: string) {
  const file = path.join(home, `${name}.png`);
  await page!.screenshot({ path: file, fullPage: true });
  return file;
}
async function sendPrompt(id: string, text: string) {
  const index = frames.length;
  const input = page!.locator("textarea[placeholder='Message Codex...']");
  await input.fill(text);
  await page!.getByTestId("send-button").click();
  await poll(() => frames.slice(index).find(frame => frame.direction === "sent" && frame.message.type === "send_prompt" && frame.message.sessionId === id), "UI send_prompt");
  return index;
}
async function turnEnd(index: number, id: string, timeout = 180_000) {
  const end = await poll(() => eventsSince(index, id).find(frame => frame.message.event.eventType === "agent_end"), "Codex agent_end", timeout);
  assert(!end.message.event.data.messages?.some((message: any) => message.stopReason === "error"), "Codex turn ended with an error; inspect UI screenshot");
  return eventsSince(index, id);
}

try {
  const firstServer = await startServer();
  context = await chromium.launchPersistentContext(path.join(home, "browser-profile"), {
    headless: true, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block",
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: "/tmp" },
  });
  evidence.browser = context.browser()?.version();
  context.setDefaultTimeout(30_000);
  await context.addCookies([{ name: "pi_dash_token", value: cookie, url: firstServer.base, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === firstServer.base) return route.continue();
    evidence.blockedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort();
  });
  await context.routeWebSocket(url => url.origin !== firstServer.base.replace("http:", "ws:"), route => {
    const url = new URL(route.url());
    evidence.blockedRequests.push(`${url.origin}${url.pathname}`);
    route.close();
  });
  page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", error => { evidence.pageErrors.push(error.message.slice(0, 400)); });
  page.on("websocket", socket => {
    for (const [event, direction] of [["framereceived", "received"], ["framesent", "sent"]] as const) {
      socket.on(event, frame => {
        try {
          const message = JSON.parse(String(frame.payload));
          if (["event", "sessions_snapshot", "session_added", "session_updated", "spawn_result", "send_prompt", "abort", "resume_session"].includes(message.type)) frames.push({ at: Date.now(), direction, message });
        } catch { /* Only protocol JSON matters. */ }
      });
    }
  });
  await page.goto(firstServer.base, { waitUntil: "domcontentloaded" });
  const selector = page.getByRole("combobox", { name: "Session runtime" }).first();
  await selector.waitFor({ state: "visible" });
  await poll(() => frames.find(frame => frame.direction === "received" && frame.message.type === "sessions_snapshot"), "native browser WebSocket snapshot");
  assert.equal(await selector.inputValue(), "pi");
  await selector.selectOption("codex");
  assert.equal((await sessions()).length, 0, "UI-only startup must not create any session");
  record("ui-ready", { screenshot: await screenshot("00-runtime-selector"), liveTurnsAllowed: live, snapshotReceived: true });

  if (live) {
    await page.getByTestId("spawn-session-btn").first().click();
    const added = await poll(() => frames.find(frame => frame.direction === "received" && frame.message.type === "session_added" && frame.message.session.runtime === "codex"), "UI-created Codex session", 60_000);
    const id: string = added.message.session.id;
    await page.waitForURL(`**/session/${id}`);
    await page.locator(`[data-session-id="${id}"]`).waitFor({ state: "visible" });
    let row = await session(id);
    assert.equal(row.runtime, "codex"); assert(row.codexThreadId);
    const initialNative = nativeProcess(row);
    evidence.sessionId = id; evidence.threadId = row.codexThreadId;
    record("codex-launched", { sessionId: id, threadId: row.codexThreadId, ...initialNative });

    await page.evaluate(id => localStorage.setItem(`dashboard:messageFilter:${id}`, JSON.stringify({
      tierA: true, tierB: true, tierC: true, meshChatter: true, toolCalls: true, systemNotifications: true,
    })), id);
    await page.reload({ waitUntil: "domcontentloaded" });
    const word = `cedar-${randomBytes(6).toString("hex")}`;
    evidence.verificationWord = word;
    const first = await sendPrompt(id, `Run only the benign command pwd in this workspace, then remember the verification word ${word}. Reply DONE, the working directory, and two short sentences explaining what pwd reported. Do not edit files or run other commands.`);
    await poll(() => eventsSince(first, id).find(frame => frame.message.event.eventType === "message_update" && frame.message.event.data.message?.role === "assistant"), "first streamed assistant update", 180_000);
    const firstEvents = await turnEnd(first, id);
    let previousText = "";
    let streamedGrowth = false;
    for (const frame of firstEvents) {
      const event = frame.message.event;
      if (event.eventType === "message_start" && event.data.message?.role === "assistant") previousText = "";
      if (event.eventType === "message_update" && event.data.message?.role === "assistant") {
        const text = event.data.message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
        if (previousText && text.startsWith(previousText) && text.length > previousText.length) streamedGrowth = true;
        previousText = text;
      }
    }
    assert(streamedGrowth, "No observable incremental assistant streaming within one message");
    const pwd = firstEvents.find(frame => frame.message.event.eventType === "tool_execution_start" && /\bpwd\b/.test(String(frame.message.event.data.args?.command ?? "")));
    assert(pwd, "First turn must actually execute pwd");
    const pwdResult = firstEvents.find(frame => frame.message.event.eventType === "tool_execution_end" && frame.message.event.data.toolCallId === pwd.message.event.data.toolCallId);
    assert(pwdResult && !pwdResult.message.event.data.isError && String(pwdResult.message.event.data.result).includes(cwd), "pwd tool must report the fixture workspace");
    await page.getByRole("button", { name: /^\$ .*pwd/ }).first().waitFor({ state: "visible" });
    record("first-turn", { streamed: true, pwdCommand: pwd.message.event.data.args.command, screenshot: await screenshot("01-first-turn") });

    const secondPrompt = "What is the verification word I asked you to remember earlier? Reply with only that word. Do not run commands.";
    assert(!secondPrompt.includes(word));
    const second = await sendPrompt(id, secondPrompt);
    assert(assistantText(await turnEnd(second, id)).includes(word), "Second turn did not retain the verification word");
    await page.getByText(word, { exact: true }).last().waitFor({ state: "visible" });
    assert.equal(await page.getByText(word, { exact: true }).count(), 1, "Second-turn assistant reply rendered more than once");
    record("second-turn-context", { retainedWord: true, promptRepeatedWord: false, singleReply: true, screenshot: await screenshot("02-context-retained") });

    const abort = await sendPrompt(id, "Run only the benign command sleep 20 now. After it finishes reply COMPLETED. Do not edit files or run other commands.");
    const sleeping = await poll(() => eventsSince(abort, id).find(frame => frame.message.event.eventType === "tool_execution_start" && /\bsleep\s+20\b/.test(String(frame.message.event.data.args?.command ?? ""))), "sleep 20 starts", 120_000);
    assert.equal((await session(id)).status, "streaming");
    assert(!eventsSince(abort, id).some(frame => frame.message.event.eventType === "tool_execution_end" && frame.message.event.data.toolCallId === sleeping.message.event.data.toolCallId), "Sleep tool ended before Stop was clicked");
    await page.getByTestId("stop-button").click();
    await poll(() => frames.slice(abort).find(frame => frame.direction === "sent" && frame.message.type === "abort" && frame.message.sessionId === id), "UI abort");
    const abortedEvents = await turnEnd(abort, id, 15_000);
    const startedTools = new Set(abortedEvents.filter(frame => frame.message.event.eventType === "tool_execution_start").map(frame => frame.message.event.data.toolCallId));
    for (const toolCallId of startedTools) {
      assert(abortedEvents.some(frame => frame.message.event.eventType === "tool_execution_end" && frame.message.event.data.toolCallId === toolCallId), "Aborted turn left an open tool card");
    }
    const elapsed = Date.now() - sleeping.at;
    assert(elapsed < 20_000, "Abort arrived after normal sleep completion");
    row = await session(id);
    assert.equal(row.status, "idle"); assert.equal(row.pid, initialNative.pid); assert(isProcessAlive(initialNative.pid));
    record("midflight-abort", { elapsedMs: elapsed, nativePidPreserved: true, allToolsClosed: true, screenshot: await screenshot("03-aborted") });

    await stopServer();
    assert([initialNative.pid, ...initialNative.descendantPids].every(pid => !isProcessAlive(pid)), "Old Codex process or descendant survived dashboard shutdown");
    const secondServer = await startServer(firstServer);
    assert.notEqual(secondServer.pid, firstServer.pid);
    row = await session(id);
    assert.equal(row.status, "ended"); assert.equal(row.codexThreadId, evidence.threadId); assert(!row.pid);
    await page.goto(`${secondServer.base}/session/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByText(word, { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByText(word, { exact: true }).count(), 1, "Restart replay changed the retained-context reply count");
    await page.getByTestId("header-resume-button").click();
    row = await poll(async () => { const current = await session(id); return current.status === "idle" && current.pid ? current : undefined; }, "native thread resume", 60_000);
    assert.equal(row.codexThreadId, evidence.threadId);
    const resumedNative = nativeProcess(row);
    assert.notEqual(resumedNative.pid, initialNative.pid);
    await page.locator(`[data-session-id="${id}"]`).waitFor({ state: "visible" });
    record("resumed-after-os-process-restart", { threadId: row.codexThreadId, historyReplayed: true, visibleInSessionList: true, ...resumedNative, screenshot: await screenshot("04-resumed") });

    const resumedPrompt = "What verification word did I ask you to remember before the dashboard restarted? Reply with only that word. Do not run commands.";
    assert(!resumedPrompt.includes(word));
    const resumed = await sendPrompt(id, resumedPrompt);
    assert(assistantText(await turnEnd(resumed, id)).includes(word), "Resumed native thread lost the verification word");
    record("resumed-context", { retainedWord: true, promptRepeatedWord: false, screenshot: await screenshot("05-resumed-context") });
  } else {
    await stopServer();
    const restarted = await startServer(firstServer);
    assert.notEqual(restarted.pid, firstServer.pid);
    await page.goto(restarted.base, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox", { name: "Session runtime" }).first().waitFor({ state: "visible" });
    assert.equal((await sessions()).length, 0);
    record("ui-restarted-without-model-turns", { screenshot: await screenshot("01-ui-restarted") });
  }
  assert.equal(evidence.pageErrors.length, 0, "Browser page errors recorded");
  // Keep optional webfonts blocked; system fonts suffice for functional acceptance.
  assert(evidence.blockedRequests.every((url: string) => url === "https://fonts.googleapis.com/css2"), "Browser attempted an out-of-scope API or WebSocket request");
  evidence.result = "PASS";
  record("complete", { mode: evidence.mode, result: "PASS" });
} catch (error) {
  evidence.result = "FAIL";
  evidence.failure = error instanceof Error ? error.message : "Acceptance failed";
  if (page) { try { evidence.failureScreenshot = await screenshot("failure"); } catch { /* Browser may already be closed. */ } }
  record("failed", { result: "FAIL", reason: evidence.failure });
  process.exitCode = 1;
} finally {
  try { await context?.close(); } finally { await stopServer(); }
  const nativePids = evidence.steps.filter((step: any) => step.step === "codex-launched" || step.step === "resumed-after-os-process-restart").flatMap((step: any) => [step.pid, ...(step.descendantPids ?? [])]);
  const remainingPids = [...evidence.dashboardPids, ...nativePids].filter(pid => isProcessAlive(pid));
  evidence.allOwnedProcessesExited = remainingPids.length === 0;
  if (remainingPids.length) {
    evidence.result = "FAIL";
    evidence.failure = "Owned dashboard or Codex process survived final cleanup";
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(home, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
