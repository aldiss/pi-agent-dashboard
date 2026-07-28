import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";

/**
 * Canonical Build-1 healthy ask_user arm.
 *
 * Assertion provenance is intentionally explicit:
 * - dl-11990 `capture.py` (sha256 04b7f1f2...) supplied the critical rule that
 *   every visible assertion is scoped to the pending-input dialog, plus the
 *   exact hidden-question / three-identical-placeholder RED signature.
 * - dl-11991 `arm_runner.py` (sha256 d6d5a14e...) supplied resettable per-index
 *   sessions, pre-prompt socket isolation, ordinal click selection, exact
 *   original-value round trip, and the action-swap/index-reversal/collision/
 *   hidden-action able-to-fail assertions.
 *
 * The Python runners are provenance only. This committed TypeScript spec is the
 * runnable artifact and never shells out to them.
 */

const dashboardUrl = validatedUrl("BUILD1_DASHBOARD_URL", new Set(["http:", "https:"]));
const gatewayUrl = validatedUrl("BUILD1_GATEWAY_URL", new Set(["ws:", "wss:"]));
const baseUrl = dashboardUrl.href.replace(/\/$/u, "");
const bindHost = validatedBindHost(requiredEnv("BUILD1_BIND_HOST"));
const evidenceDir = requiredEnv("BUILD1_EVIDENCE_DIR");
const stateHome = requiredEnv("BUILD1_STATE_HOME");
const workspaceRoot = requiredEnv("BUILD1_WORKSPACE_ROOT");
const manifestPath = requiredEnv("BUILD1_CANDIDATE_MANIFEST");
const productionGatewayPort = validatedPort("BUILD1_PRODUCTION_GATEWAY_PORT");
const testGatewayPort = explicitPort(gatewayUrl, "BUILD1_GATEWAY_URL");

const sourceTitle = "CommsReset: choose the Build-1 next action";
const sourceMessage = "Per §2A, choose one operator action.";
const sourceOptions = [
  "Door-3: deploy the release now",
  "Pattern 87: run one more validation pass",
  "Track-3: cancel and hold the release",
] as const;
const forbiddenInternal = /(?:CommsReset|Door-3|Pattern 87|Track-3|§2A)/iu;
const ordinalPrefix = /^\d+\.\s*/u;

// Exact dl-11990 RED signature, mined from capture.py and immutable evidence.
const hiddenQuestionPlaceholder = "I couldn't translate this question, so its original wording is hidden.";
const hiddenOptionPlaceholder = "Option details could not be translated.";

interface ContentIdentity {
  semantic_role: string;
  absolute_path: string;
  content_sha256: string;
}

interface CompositeManifest {
  schema_version: number;
  producer_identity: {
    merge_base_commit_git_sha1: string;
    merge_base_subtree_git_sha1: string;
    target_integration_base_commit_git_sha1: string;
    target_base_subtree_git_sha1: string;
    source_fix_commit_git_sha1: string;
    source_fix_parent_commit_git_sha1: string;
    source_fix_subtree_git_sha1: string;
    merge_base_to_target_path_diff_exit: number;
    door_git_blob_sha1: string;
    door_content_sha256: string;
    integrated_candidate_commit_git_sha1: string;
    integrated_candidate_tree_git_sha1: string;
    integrated_candidate_subtree_git_sha1: string;
    integrated_candidate_worktree_absolute_path: string;
    target_live_repo_absolute_path: string;
    operator_voice_repo_relative_path: string;
    door_repo_relative_path: string;
    source_is_ancestor_of_target: false;
    target_is_ancestor_of_source: false;
    merge_base_subtree_equals_target_base_subtree: true;
    integrated_candidate_subtree_equals_source_fix_subtree: true;
    target_integration_base_is_live_head_at_freeze: true;
  };
  dashboard_identity: {
    production_base_commit_git_sha1: string;
    comms_reset_input_tip_commit_git_sha1: string;
    integrated_candidate_commit_git_sha1: string;
    integrated_candidate_tree_git_sha1: string;
    integrated_candidate_worktree_absolute_path: string;
  };
  staged_runtime_identity: {
    staged_release_root_absolute_path: string;
    staged_dashboard_entry_absolute_path: string;
    staged_server_workspace_absolute_path: string;
    release_json_absolute_path: string;
    release_json_content_sha256: string;
    operator_reachable_dashboard_http_url: string;
    test_gateway_websocket_url: string;
    supplied_bind_host_ip_literal: string;
    production_gateway_tcp_port: number;
    state_home_absolute_path: string;
    session_workspace_root_absolute_path: string;
    settings_json_absolute_path: string;
    dashboard_extension_package_absolute_path: string;
    operator_voice_package_absolute_path: string;
    bind_guard_absolute_path: string;
    operator_voice_enabled: true;
    browser_headless: false;
    playwright_workers: 1;
    playwright_retries: 0;
    playwright_trace: "on";
    playwright_video: "on";
    playwright_screenshot: "on";
  };
  content_identities: ContentIdentity[];
}

interface BrowserCapture {
  console: unknown[];
  network: unknown[];
  sockets: Array<{ url: string; sent: string[]; received: string[] }>;
}

interface SocketObservation {
  pids: string[];
  output: string;
  has_test_gateway: boolean;
  has_production_gateway: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatedUrl(name: string, protocols: ReadonlySet<string>): URL {
  let value: URL;
  try {
    value = new URL(requiredEnv(name));
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.has(value.protocol)) throw new Error(`${name} uses forbidden protocol ${value.protocol}`);
  explicitPort(value, name);
  return value;
}

function explicitPort(value: URL, name: string): number {
  if (!value.port || !/^\d+$/u.test(value.port)) throw new Error(`${name} must contain an explicit TCP port`);
  const port = Number(value.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${name} has invalid port`);
  return port;
}

function validatedPort(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a TCP port`);
  return value;
}

function validatedBindHost(value: string): string {
  const normalized = value.trim().replace(/^\[|\]$/gu, "");
  const unsafe = new BlockList();
  unsafe.addAddress("0.0.0.0", "ipv4");
  unsafe.addSubnet("127.0.0.0", 8, "ipv4");
  unsafe.addAddress("::", "ipv6");
  unsafe.addAddress("::1", "ipv6");
  unsafe.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  const family = isIP(normalized);
  if (family === 0 || unsafe.check(normalized, family === 6 ? "ipv6" : "ipv4")) {
    throw new Error(`BUILD1_BIND_HOST must be a non-wildcard, non-loopback literal IP; received ${JSON.stringify(value)}`);
  }
  if (gatewayUrl.hostname.replace(/^\[|\]$/gu, "") !== normalized) {
    throw new Error("BUILD1_GATEWAY_URL hostname must equal BUILD1_BIND_HOST");
  }
  return normalized;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function assertGitSha1(value: string, role: string): void {
  expect(value, `${role} must be a full git SHA-1`).toMatch(/^[0-9a-f]{40}$/u);
}

function assertSha256(value: string, role: string): void {
  expect(value, `${role} must be a full SHA-256`).toMatch(/^[0-9a-f]{64}$/u);
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

function diffQuiet(repo: string, from: string, to: string, relativePath: string): number {
  return spawnSync("git", ["-C", repo, "diff", "--quiet", from, to, "--", relativePath]).status ?? -1;
}

function readAndVerifyManifest(): CompositeManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CompositeManifest;
  expect(manifest.schema_version).toBe(1);

  const producer = manifest.producer_identity;
  const dashboard = manifest.dashboard_identity;
  const runtime = manifest.staged_runtime_identity;
  const producerRepo = producer.integrated_candidate_worktree_absolute_path;
  const liveRepo = producer.target_live_repo_absolute_path;
  const dashboardRepo = dashboard.integrated_candidate_worktree_absolute_path;

  for (const [role, value] of Object.entries({
    merge_base_commit_git_sha1: producer.merge_base_commit_git_sha1,
    merge_base_subtree_git_sha1: producer.merge_base_subtree_git_sha1,
    target_integration_base_commit_git_sha1: producer.target_integration_base_commit_git_sha1,
    target_base_subtree_git_sha1: producer.target_base_subtree_git_sha1,
    source_fix_commit_git_sha1: producer.source_fix_commit_git_sha1,
    source_fix_parent_commit_git_sha1: producer.source_fix_parent_commit_git_sha1,
    source_fix_subtree_git_sha1: producer.source_fix_subtree_git_sha1,
    door_git_blob_sha1: producer.door_git_blob_sha1,
    integrated_candidate_commit_git_sha1: producer.integrated_candidate_commit_git_sha1,
    integrated_candidate_tree_git_sha1: producer.integrated_candidate_tree_git_sha1,
    integrated_candidate_subtree_git_sha1: producer.integrated_candidate_subtree_git_sha1,
    dashboard_production_base_commit_git_sha1: dashboard.production_base_commit_git_sha1,
    dashboard_comms_reset_input_tip_commit_git_sha1: dashboard.comms_reset_input_tip_commit_git_sha1,
    dashboard_integrated_candidate_commit_git_sha1: dashboard.integrated_candidate_commit_git_sha1,
    dashboard_integrated_candidate_tree_git_sha1: dashboard.integrated_candidate_tree_git_sha1,
  })) assertGitSha1(value, role);
  assertSha256(producer.door_content_sha256, "door_content_sha256");

  // Pete dl-12760: recompute all five losslessness/freeze assertions; never
  // accept the manifest's booleans as proof of themselves.
  expect(isAncestor(producerRepo, producer.source_fix_commit_git_sha1, producer.target_integration_base_commit_git_sha1)).toBe(false);
  expect(isAncestor(producerRepo, producer.target_integration_base_commit_git_sha1, producer.source_fix_commit_git_sha1)).toBe(false);
  expect(producer.source_is_ancestor_of_target).toBe(false);
  expect(producer.target_is_ancestor_of_source).toBe(false);
  expect(git(producerRepo, ["merge-base", producer.source_fix_commit_git_sha1, producer.target_integration_base_commit_git_sha1])).toBe(producer.merge_base_commit_git_sha1);
  expect(git(producerRepo, ["rev-parse", `${producer.merge_base_commit_git_sha1}:${producer.operator_voice_repo_relative_path}`])).toBe(producer.merge_base_subtree_git_sha1);
  expect(git(producerRepo, ["rev-parse", `${producer.target_integration_base_commit_git_sha1}:${producer.operator_voice_repo_relative_path}`])).toBe(producer.target_base_subtree_git_sha1);
  expect(producer.merge_base_subtree_git_sha1).toBe(producer.target_base_subtree_git_sha1);
  expect(producer.merge_base_subtree_equals_target_base_subtree).toBe(true);
  expect(diffQuiet(producerRepo, producer.merge_base_commit_git_sha1, producer.target_integration_base_commit_git_sha1, producer.operator_voice_repo_relative_path)).toBe(0);
  expect(producer.merge_base_to_target_path_diff_exit).toBe(0);
  expect(git(producerRepo, ["rev-parse", `${producer.source_fix_commit_git_sha1}:${producer.operator_voice_repo_relative_path}`])).toBe(producer.source_fix_subtree_git_sha1);
  expect(git(producerRepo, ["rev-parse", `${producer.source_fix_commit_git_sha1}^`])).toBe(producer.source_fix_parent_commit_git_sha1);
  expect(git(producerRepo, ["rev-parse", "HEAD"])).toBe(producer.integrated_candidate_commit_git_sha1);
  expect(git(producerRepo, ["rev-parse", "HEAD^{tree}"])).toBe(producer.integrated_candidate_tree_git_sha1);
  expect(git(producerRepo, ["rev-parse", `HEAD:${producer.operator_voice_repo_relative_path}`])).toBe(producer.integrated_candidate_subtree_git_sha1);
  expect(producer.integrated_candidate_subtree_git_sha1).toBe(producer.source_fix_subtree_git_sha1);
  expect(producer.integrated_candidate_subtree_equals_source_fix_subtree).toBe(true);
  expect(git(producerRepo, ["rev-parse", `${producer.source_fix_commit_git_sha1}:${producer.door_repo_relative_path}`])).toBe(producer.door_git_blob_sha1);
  expect(sha256File(path.join(producerRepo, producer.door_repo_relative_path))).toBe(producer.door_content_sha256);

  // The live target base is a separately pinned object. Moving HEAD or subtree
  // invalidates this manifest rather than silently retargeting the integration.
  expect(git(liveRepo, ["rev-parse", "HEAD"])).toBe(producer.target_integration_base_commit_git_sha1);
  expect(git(liveRepo, ["rev-parse", `HEAD:${producer.operator_voice_repo_relative_path}`])).toBe(producer.target_base_subtree_git_sha1);
  expect(producer.target_integration_base_is_live_head_at_freeze).toBe(true);

  expect(git(dashboardRepo, ["rev-parse", "HEAD"])).toBe(dashboard.integrated_candidate_commit_git_sha1);
  expect(git(dashboardRepo, ["rev-parse", "HEAD^{tree}"])).toBe(dashboard.integrated_candidate_tree_git_sha1);
  expect(isAncestor(dashboardRepo, dashboard.production_base_commit_git_sha1, dashboard.comms_reset_input_tip_commit_git_sha1)).toBe(true);
  expect(isAncestor(dashboardRepo, dashboard.comms_reset_input_tip_commit_git_sha1, dashboard.integrated_candidate_commit_git_sha1)).toBe(true);

  expect(runtime.operator_reachable_dashboard_http_url.replace(/\/$/u, "")).toBe(baseUrl);
  expect(runtime.test_gateway_websocket_url).toBe(gatewayUrl.href);
  expect(runtime.supplied_bind_host_ip_literal).toBe(bindHost);
  expect(runtime.production_gateway_tcp_port).toBe(productionGatewayPort);
  expect(runtime.state_home_absolute_path).toBe(stateHome);
  expect(runtime.session_workspace_root_absolute_path).toBe(workspaceRoot);
  expect(runtime.operator_voice_enabled).toBe(true);
  expect(runtime.browser_headless).toBe(false);
  expect(runtime.playwright_workers).toBe(1);
  expect(runtime.playwright_retries).toBe(0);
  expect(runtime.playwright_trace).toBe("on");
  expect(runtime.playwright_video).toBe("on");
  expect(runtime.playwright_screenshot).toBe("on");

  const release = JSON.parse(readFileSync(runtime.release_json_absolute_path, "utf8")) as { commit?: string; ref?: string };
  expect(release.commit).toBe(dashboard.integrated_candidate_commit_git_sha1);
  expect(release.ref).toBe(dashboard.integrated_candidate_commit_git_sha1);
  expect(sha256File(runtime.release_json_absolute_path)).toBe(runtime.release_json_content_sha256);
  expect(realpathSync(runtime.staged_release_root_absolute_path)).toBe(runtime.staged_release_root_absolute_path);
  expect(realpathSync(runtime.staged_dashboard_entry_absolute_path)).toBe(runtime.staged_dashboard_entry_absolute_path);
  expect(realpathSync(runtime.staged_server_workspace_absolute_path)).toBe(runtime.staged_server_workspace_absolute_path);

  const settings = JSON.parse(readFileSync(runtime.settings_json_absolute_path, "utf8")) as { packages?: unknown };
  expect(settings.packages).toEqual(expect.arrayContaining([
    runtime.dashboard_extension_package_absolute_path,
    runtime.operator_voice_package_absolute_path,
  ]));

  expect(manifest.content_identities.length).toBeGreaterThan(0);
  const requiredRoles = new Set([
    "dashboard_natural_healthy_playwright_spec",
    "dashboard_natural_healthy_playwright_config",
    "dashboard_reachable_bind_guard",
    "producer_ask_user_door",
    "staged_dashboard_release_json",
    "isolated_runtime_settings_json",
  ]);
  const observedRoles = new Set<string>();
  for (const identity of manifest.content_identities) {
    expect(identity.semantic_role).not.toBe("");
    expect(path.isAbsolute(identity.absolute_path)).toBe(true);
    assertSha256(identity.content_sha256, `${identity.semantic_role}_content_sha256`);
    expect(existsSync(identity.absolute_path)).toBe(true);
    expect(statSync(identity.absolute_path).isFile()).toBe(true);
    expect(sha256File(identity.absolute_path)).toBe(identity.content_sha256);
    observedRoles.add(identity.semantic_role);
  }
  for (const role of requiredRoles) expect(observedRoles.has(role), `missing content identity role ${role}`).toBe(true);
  return manifest;
}

function readJsonLines(file: string): any[] {
  if (!existsSync(file)) return [];
  const entries: any[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* writer may own a partial tail line */ }
  }
  return entries;
}

function toolArguments(toolCall: any): Record<string, unknown> {
  if (toolCall?.arguments && typeof toolCall.arguments === "object") return toolCall.arguments;
  if (typeof toolCall?.arguments === "string") {
    const parsed = JSON.parse(toolCall.arguments);
    if (parsed && typeof parsed === "object") return parsed;
  }
  throw new Error("ask_user tool call did not carry object arguments");
}

async function waitForToolCall(sessionFile: string): Promise<any> {
  let found: any;
  await expect.poll(() => {
    for (const entry of readJsonLines(sessionFile)) {
      const message = entry.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      found = message.content.find((part: any) => part.type === "toolCall" && part.name === "ask_user");
      if (found) return true;
    }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  return found;
}

async function waitForToolResult(sessionFile: string): Promise<any> {
  let found: any;
  await expect.poll(() => {
    for (const entry of readJsonLines(sessionFile)) {
      if (entry.message?.role === "toolResult" && entry.message.toolName === "ask_user") found = entry.message;
    }
    return found?.details?.result;
  }, { timeout: 60_000 }).not.toBeUndefined();
  return found;
}

function captureBrowser(page: Page): BrowserCapture {
  const captured: BrowserCapture = { console: [], network: [], sockets: [] };
  page.on("console", (message) => captured.console.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => captured.console.push({ type: "pageerror", text: error.message }));
  page.on("request", (request) => captured.network.push({ event: "request", method: request.method(), url: request.url(), resourceType: request.resourceType() }));
  page.on("response", (response) => captured.network.push({ event: "response", status: response.status(), url: response.url() }));
  page.on("websocket", (socket) => {
    const record = { url: socket.url(), sent: [] as string[], received: [] as string[] };
    captured.sockets.push(record);
    socket.on("framesent", (event) => record.sent.push(String(event.payload).slice(0, 20_000)));
    socket.on("framereceived", (event) => record.received.push(String(event.payload).slice(0, 20_000)));
  });
  return captured;
}

async function api(capture: BrowserCapture, request: APIRequestContext, route: string, data?: unknown): Promise<any> {
  const response = data === undefined
    ? await request.get(`${baseUrl}${route}`)
    : await request.post(`${baseUrl}${route}`, { data });
  const body = await response.text();
  capture.network.push({ source: "api-request-context", route, status: response.status(), method: data === undefined ? "GET" : "POST" });
  expect(response.ok(), `${route}: ${response.status()} ${body.slice(0, 1_000)}`).toBe(true);
  return body ? JSON.parse(body) : {};
}

async function spawnSession(capture: BrowserCapture, request: APIRequestContext, cwd: string, label: string): Promise<any> {
  mkdirSync(cwd, { recursive: true });
  await api(capture, request, "/api/session/spawn", { cwd, label });
  let found: any;
  await expect.poll(async () => {
    const sessions = (await api(capture, request, "/api/sessions")).data ?? [];
    found = sessions.find((session: any) => session.cwd === cwd);
    return Boolean(found?.id && found?.sessionFile);
  }, { timeout: 60_000 }).toBe(true);
  return found;
}

function sessionPids(cwd: string): string[] {
  const result = spawnSync("pgrep", ["-f", "pi"], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(`pgrep failed: ${result.stderr}`);
  const pids = result.stdout.split(/\s+/u).filter(Boolean);
  return pids.filter((pid) => {
    const observed = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" });
    return observed.status === 0 && observed.stdout.includes(cwd);
  });
}

function observeSockets(cwd: string): SocketObservation {
  const pids = sessionPids(cwd);
  const records: string[] = [];
  let hasTestGateway = false;
  let hasProductionGateway = false;
  for (const pid of pids) {
    const observed = spawnSync("lsof", ["-nP", "-a", "-p", pid, "-iTCP"], { encoding: "utf8" });
    const output = observed.stdout.trim();
    records.push(`--- pid ${pid} ---\n${output || "(no TCP)"}`);
    if (output.includes(`${bindHost}:${testGatewayPort}`)) hasTestGateway = true;
    if (output.includes(`:${productionGatewayPort}`)) hasProductionGateway = true;
  }
  return { pids, output: records.join("\n"), has_test_gateway: hasTestGateway, has_production_gateway: hasProductionGateway };
}

async function waitForSocketIsolation(cwd: string): Promise<SocketObservation> {
  let observation: SocketObservation = { pids: [], output: "", has_test_gateway: false, has_production_gateway: false };
  await expect.poll(() => {
    observation = observeSockets(cwd);
    return observation.pids.length > 0 && observation.has_test_gateway && !observation.has_production_gateway;
  }, { timeout: 60_000 }).toBe(true);
  return observation;
}

function normalizeVisible(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

async function pendingDialog(page: Page): Promise<{ dialog: Locator; promptBodies: Locator; optionButtons: Locator }> {
  const pageOptions = page.getByRole("button", { name: /^\d+\.\s/u });
  await expect(pageOptions).toHaveCount(3, { timeout: 120_000 });
  const dialog = pageOptions.first().locator("xpath=ancestor::div[.//*[@data-testid='prompt-body']][1]");
  await expect(dialog).toBeVisible();
  const promptBodies = dialog.getByTestId("prompt-body");
  const optionButtons = dialog.getByRole("button", { name: /^\d+\.\s/u });
  await expect(promptBodies).toHaveCount(2);
  await expect(optionButtons).toHaveCount(3);
  return { dialog, promptBodies, optionButtons };
}

function sentPromptResponse(capture: BrowserCapture): any | undefined {
  for (const socket of capture.sockets) {
    for (const frame of socket.sent) {
      try {
        const parsed = JSON.parse(frame);
        if (parsed?.type === "prompt_response") return parsed;
      } catch { /* non-JSON frame */ }
    }
  }
  return undefined;
}

async function writeEvidence(testInfo: TestInfo, file: string, value: string | Buffer): Promise<void> {
  const target = path.join(evidenceDir, file);
  writeFileSync(target, value);
  await testInfo.attach(file, { path: target });
}

test.describe.serial("Build 1 integrated natural healthy ask_user", () => {
  test.beforeAll(() => {
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    readAndVerifyManifest();
  });

  for (const [optionIndex, expectedOriginal] of sourceOptions.entries()) {
    test(`visible option ${optionIndex + 1} returns original machine value`, async ({ page, request }, testInfo) => {
      const tag = `build1-natural-${optionIndex}-${Date.now()}`;
      const cwd = path.join(workspaceRoot, tag);
      const capture = captureBrowser(page);
      const record: Record<string, unknown> = {
        option_index: optionIndex,
        expected_original: expectedOriginal,
        raw_source_title: sourceTitle,
        raw_source_message: sourceMessage,
        raw_source_options: sourceOptions,
      };
      let session: any;
      let dialog: Locator | undefined;

      try {
        session = await spawnSession(capture, request, cwd, `Build1Natural-${optionIndex + 1}`);
        record.session_id = session.id;
        record.session_file = session.sessionFile;
        expect(realpathSync(session.sessionFile).startsWith(`${realpathSync(stateHome)}${path.sep}`)).toBe(true);

        // arm_runner.py / dl-11991: prove the spawned subject talks only to the
        // test gateway before any ask is emitted; zero production gateway.
        const socketBeforePrompt = await waitForSocketIsolation(cwd);
        record.socket_before_prompt = socketBeforePrompt;
        await writeEvidence(testInfo, `${tag}-socket-before-prompt.txt`, `${JSON.stringify({ pids: socketBeforePrompt.pids }, null, 2)}\n${socketBeforePrompt.output}\n`);

        const promptText = [
          "Call ask_user exactly once and immediately, with no assistant prose or other tool calls.",
          `Use method=\"select\", title=${JSON.stringify(sourceTitle)}, message=${JSON.stringify(sourceMessage)}.`,
          `Pass these options byte-for-byte with no ordinals: ${JSON.stringify(sourceOptions)}.`,
        ].join("\n");
        await api(capture, request, `/api/session/${session.id}/prompt`, { text: promptText });
        await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: "domcontentloaded" });

        const located = await pendingDialog(page);
        dialog = located.dialog;
        const titleText = normalizeVisible(await located.promptBodies.nth(0).innerText());
        const messageText = normalizeVisible(await located.promptBodies.nth(1).innerText());
        const visibleLabels = (await located.optionButtons.allInnerTexts()).map(normalizeVisible);
        const visibleBare = visibleLabels.map((value) => value.replace(ordinalPrefix, "").trim());
        record.visible_title = titleText;
        record.visible_message = messageText;
        record.visible_labels = visibleLabels;
        record.visible_bare_labels = visibleBare;
        record.dialog_text = await dialog.innerText();

        // capture.py / dl-11990: preserve the dialog node BEFORE assertions.
        await writeEvidence(testInfo, `${tag}-dialog-preclick.png`, await dialog.screenshot());
        await writeEvidence(testInfo, `${tag}-full-preclick.png`, await page.screenshot({ fullPage: true }));
        await writeEvidence(testInfo, `${tag}-dialog-preclick.html`, await dialog.evaluate((node) => node.outerHTML));

        const toolCall = await waitForToolCall(session.sessionFile);
        const presentedArgs = toolArguments(toolCall);
        record.presented_tool_arguments = presentedArgs;

        // Healthy assertions are soft so the exact dl-11990 RED still captures
        // its blind click and machine result, but the Playwright test exits RED.
        // The same assertions catch arm_runner controls: swapped/reversed result,
        // duplicate labels, and hidden-action placeholders.
        expect.soft(await located.promptBodies.nth(0).isVisible()).toBe(true);
        expect.soft(await located.promptBodies.nth(1).isVisible()).toBe(true);
        expect.soft(titleText.length).toBeGreaterThan(0);
        expect.soft(messageText.length).toBeGreaterThan(0);
        expect.soft(titleText).not.toBe(sourceTitle);
        expect.soft(messageText).not.toBe(sourceMessage);
        expect.soft(titleText).not.toMatch(forbiddenInternal);
        expect.soft(messageText).not.toMatch(forbiddenInternal);
        expect.soft(titleText).not.toContain(hiddenQuestionPlaceholder);
        expect.soft(messageText).not.toContain(hiddenQuestionPlaceholder);
        expect.soft(await dialog.innerText()).not.toContain(hiddenOptionPlaceholder);
        expect.soft(visibleLabels).toHaveLength(3);
        expect.soft(new Set(visibleBare).size).toBe(3);
        for (let index = 0; index < visibleBare.length; index += 1) {
          expect.soft(await located.optionButtons.nth(index).isVisible()).toBe(true);
          expect.soft(await located.optionButtons.nth(index).isEnabled()).toBe(true);
          expect.soft(visibleLabels[index]).toMatch(new RegExp(`^${index + 1}\\.\\s`, "u"));
          expect.soft(visibleBare[index].length).toBeGreaterThan(0);
          expect.soft(visibleBare[index]).not.toBe(sourceOptions[index]);
          expect.soft(visibleBare[index]).not.toMatch(forbiddenInternal);
          expect.soft(visibleBare[index]).not.toContain(hiddenOptionPlaceholder);
        }

        // The persisted arguments are presentation values because operator-voice
        // mutates the shared toolCall args before persistence. They must match the
        // dialog, not the raw machine constants.
        expect(normalizeVisible(String(presentedArgs.title))).toBe(titleText);
        expect(normalizeVisible(String(presentedArgs.message))).toBe(messageText);
        expect(presentedArgs.options).toEqual(visibleLabels);

        const clickedLabel = visibleLabels[optionIndex];
        record.clicked_label = clickedLabel;
        await located.optionButtons.nth(optionIndex).click();

        await expect.poll(() => sentPromptResponse(capture)?.answer, { timeout: 30_000 }).toBe(clickedLabel);
        const responseFrame = sentPromptResponse(capture);
        record.prompt_response = responseFrame;

        const toolResult = await waitForToolResult(session.sessionFile);
        record.returned_consumer_value = toolResult.details.result;
        record.tool_result = toolResult;
        expect(toolResult.isError).toBe(false);
        expect(toolResult.details.result).toBe(expectedOriginal);
        expect(toolResult.content?.[0]?.text).toContain(JSON.stringify(expectedOriginal));

        const socketAfterClick = observeSockets(cwd);
        record.socket_after_click = socketAfterClick;
        expect(socketAfterClick.has_production_gateway).toBe(false);

        await writeEvidence(testInfo, `${tag}-full-postclick.png`, await page.screenshot({ fullPage: true }));
        readAndVerifyManifest();
      } finally {
        record.browser_capture = capture;
        record.page_errors = capture.console.filter((entry: any) => entry?.type === "pageerror");
        record.completed_at_utc = new Date().toISOString();
        if (dialog) {
          try { record.dialog_final_text = await dialog.innerText(); } catch { /* resolved dialog may be replaced */ }
        }
        try { await writeEvidence(testInfo, `${tag}-page-final.html`, await page.content()); } catch { /* page may already be gone */ }
        await writeEvidence(testInfo, `${tag}-expected-actual.json`, `${JSON.stringify(record, null, 2)}\n`);
        await writeEvidence(testInfo, `${tag}-browser.json`, `${JSON.stringify(capture, null, 2)}\n`);
        if (session?.id) {
          try { await api(capture, request, `/api/session/${session.id}/shutdown`, {}); } catch { /* best-effort teardown */ }
        }
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
