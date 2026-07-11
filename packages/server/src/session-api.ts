/**
 * REST API wrappers for session control operations.
 * These expose WebSocket-only operations as HTTP endpoints
 * for use by skills, scripts, and external tooling.
 */
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { isAbsolute } from "node:path";
import { execSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import type { SessionManager } from "./memory-session-manager.js";
import type { PiGateway } from "./pi-gateway.js";
import type { BrowserGateway } from "./browser-gateway.js";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { spawnPiSession } from "./process-manager.js";
import { buildInteractiveResumeOptions, resolvePinDashboardUrl } from "./resume-spawn-options.js";
import { writeOperatorPin, readOperatorPin, checkNamePinConsistency } from "./name-sync-write-pin.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { resolveDriverLiveness } from "./driver-liveness.js";
import { resurrectSession } from "./resurrection-sweep.js";
import {
  killProcess as platformKillProcess,
  isProcessAlive as platformIsProcessAlive,
} from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { addWorktree, isInsideWorkTree, resolveRepoRoot } from "./worktree-manager.js";
import type { PendingForkRegistry } from "./pending-fork-registry.js";
import type { PendingResumeIntentRegistry } from "./pending-resume-intent-registry.js";
import type { BootstrapStateStore } from "./bootstrap-state.js";
import type { BootstrapQueue } from "./bootstrap-queue.js";
import { attachRenameTarget, detachShouldClearName } from "./proposal-attach-naming.js";
import { FORK_DEGRADED_TO_NEW_MESSAGE, FORK_DEGRADED_TO_NEW_CODE } from "./browser-handlers/session-action-handler.js";
import { makeRestSessionGate, makeRestPromptGate } from "./rest-session-gate.js";
import { deriveAuthor } from "./derive-author.js";
import {
  verifyResurrection,
  createProductionProbes,
  type VerifyResult,
} from "./resurrection-verify.js";

export interface SessionApiDeps {
  sessionManager: SessionManager;
  piGateway: PiGateway;
  browserGateway: BrowserGateway;
  pendingForkRegistry?: PendingForkRegistry;
  pendingDashboardSpawns?: Map<string, number>;
  /**
   * Bootstrap state + queue for degraded-mode gating. When omitted,
   * session operations run normally (legacy behavior for tests that
   * don't exercise the bootstrap flow). See change: unified-bootstrap-install.
   */
  bootstrapState?: BootstrapStateStore;
  bootstrapQueue?: BootstrapQueue;
  /**
   * User-resume-intent registry. Tagged in the resume endpoint so the
   * `sessionManager.onChange` ended→alive branch can distinguish a
   * REST-initiated user resume from a bridge auto-reattach on reboot.
   * See change: preserve-session-order-on-reboot.
   */
  pendingResumeIntents?: PendingResumeIntentRegistry;
  /**
   * Optional pending-attach registry. When provided, the resume endpoint's
   * fork-empty-session degradation path inherits the parent's
   * `attachedProposal` for the new spawn.
   * See change: fix-fork-empty-session-silent-timeout.
   */
  pendingAttachRegistry?: import("./pending-attach-registry.js").PendingAttachRegistry;
  /**
   * Post-respawn VERIFY gate seam (design-pass §3-B; build-gate item 2).
   * Injected by tests to drive the 5-assertion gate deterministically; in
   * production, omitted → the endpoint builds the real-oracle gate
   * (`createProductionProbes` + `verifyResurrection`). Receives the resurrected
   * session id; resolves the gate verdict. The resurrect endpoint returns
   * success for cases 2/3 ONLY when this resolves `ok:true`.
   * See change: unend-mechanism-v2.
   */
  resurrectVerify?: (sessionId: string) => Promise<VerifyResult>;
  /**
   * Runtime pi-gateway port of THIS server, threaded from `ServerConfig.piPort`
   * in server.ts. Used by the resurrect respawn to pin the spawned bridge to
   * the SPAWNING server's own gateway (`PI_DASHBOARD_URL=ws://localhost:<port>`)
   * so it can't mDNS-migrate to a sibling local dashboard.
   *
   * ⚠ MUST be the RUNTIME port, not `loadConfig().piPort`: when the server is
   * started with `--pi-port <N>` overriding the config file, the file value can
   * differ from `<N>` — pinning to the wrong port would RE-INTRODUCE the exact
   * cross-wire bug this fixes. `config.piPort` (the value passed to
   * `piGateway.start()`) is the runtime port; the handler prefers the live
   * `piGateway.address()` (the actually-bound socket) and falls back to this.
   * See change: pin-on-resurrect.
   */
  serverPiPort?: number;
  /**
   * Build 1b (C-REST-CLOSURE): the STARTUP-FROZEN multi-operator browser-auth
   * gate flag. When true, every session-write REST route routes through the
   * central `authorizeSessionAction` chokepoint (F4-closure + operator-only
   * enforcement). Reads the SAME frozen boolean the WS gate + send-seam gate
   * read (server.ts `requireBrowserAuthAtStartup`) — NOT a live config value —
   * so the REST gate can never desync from the others on a runtime auth reload.
   * Default false → the gate no-ops and every route behaves exactly as today
   * (byte-unchanged). See auth-merge contract invariant #1.
   */
  requireBrowserAuth?: boolean;
  /**
   * Build 1b operator-identity source (`auth.operatorUsers`), frozen at startup
   * alongside the flag. Drives operator-only enforcement for the session-control
   * REST routes. Unset/empty → operator-only enforcement is INERT (mandate 4c).
   */
  operatorUsers?: string[];
  /**
   * Stream-2 D: the shared bounded-cell (N=2) admission tracker — the SAME
   * instance the WS gate reads (threaded from `server.ts`). Passed into both REST
   * gate factories so a session is bounded to 2 distinct humans from the ONE
   * chokepoint. Unset → admission SKIPPED (byte-unchanged).
   */
  operatorSet?: import("./operator-set-tracker.js").OperatorSetTracker;
}

type IdParams = { Params: { id: string } };

/**
 * Double-writer guard for force-resurrect case 2 (bridgeless-live takeover).
 *
 * Sequence is LOAD-BEARING and must never reorder: SIGTERM the live pid →
 * **confirm clean exit** (poll, with SIGKILL escalation inside the platform
 * `killProcess`) → only THEN respawn `pi --session`. Respawning while the old
 * writer is still alive = two pi processes on one session file = corruption.
 * If the old pid will not die, we REFUSE to respawn and surface an error.
 *
 * Pure + injectable so the ordering is unit-testable without real processes
 * (see resurrection-takeover.test.ts). Production callers use the platform
 * defaults.
 */
export interface ForceTakeoverDeps {
  /** Terminate the live pid; resolves once it is dead (or could not be killed). */
  killProcess?: (pid: number) => Promise<{ ok: boolean; forced: boolean }>;
  /** Liveness recheck AFTER kill — the guard gate. Must return false before respawn. */
  isProcessAlive?: (pid: number) => boolean;
  /** Respawn the session once the old writer is confirmed gone. */
  respawn: () => Promise<import("./process-manager.js").SpawnResult>;
}

export interface ForceTakeoverResult {
  ok: boolean;
  /** Set on refusal/failure: "kill_failed" (old pid would not die) or "respawn_failed". */
  reason?: "kill_failed" | "respawn_failed";
  spawnResult?: import("./process-manager.js").SpawnResult;
}

export async function forceTakeover(pid: number, deps: ForceTakeoverDeps): Promise<ForceTakeoverResult> {
  const kill = deps.killProcess ?? ((p: number) => platformKillProcess(p, { timeoutMs: 5000 }));
  const isAlive = deps.isProcessAlive ?? ((p: number) => platformIsProcessAlive(p));

  // 1. Graceful SIGTERM → (platform escalates to SIGKILL after timeout).
  await kill(pid);

  // 2. Confirm clean exit — the double-writer GATE. Never respawn over a live
  //    writer: if the old pid is somehow still alive, refuse.
  if (isAlive(pid)) {
    return { ok: false, reason: "kill_failed" };
  }

  // 3. Old writer is gone → safe to respawn the single writer.
  const spawnResult = await deps.respawn();
  if (!spawnResult.success) {
    return { ok: false, reason: "respawn_failed", spawnResult };
  }
  return { ok: true, spawnResult };
}

/** Helper: validate session exists, return it or send error response */
function getSessionOrFail(sessionManager: SessionManager, id: string): { session: any } | { error: ApiResponse } {
  const session = sessionManager.get(id);
  if (!session) return { error: { success: false, error: "session not found" } };
  return { session };
}

export function registerSessionApi(fastify: FastifyInstance, deps: SessionApiDeps) {
  const { sessionManager, piGateway, browserGateway, pendingForkRegistry, pendingDashboardSpawns, bootstrapState, bootstrapQueue, pendingResumeIntents, pendingAttachRegistry } = deps;

  // ── Build 1b (C-REST-CLOSURE): the single session-write REST gate ─────────
  // Every session-write route below is wired through `gate(action)` as a
  // preHandler — the REST arm of the ONE central `authorizeSessionAction`
  // chokepoint (the WS seam is the other arm), built from the shared
  // `makeRestSessionGate` factory (identical actor-construction + gate call as
  // the retire route, no drift). On `{allowed:false}` the preHandler replies
  // 401/403 and the route handler never runs, so the F4 backdoor (`/prompt`
  // reaching piGateway) and every sibling session-write are refused for an
  // unauthorized actor. Flag OFF → the gate no-ops → every route byte-unchanged.
  //
  // `action: SessionWriteAction` (not `string`) makes the enumeration
  // mechanically total: a route wired with an action token absent from
  // `SESSION_WRITE_ACTION_CLASS` is a COMPILE error. FOLD-B (PUSHBACK-1): route
  // coverage DERIVES from the actual fastify route table — the
  // `build1b-rest-coverage.test.ts` suite drives `registerSessionApi` against an
  // `onRoute`-collecting stub and asserts EVERY session-write route (a POST that
  // reaches `sendToSession`/`sessionManager.update`) carries a gate preHandler
  // whose `__sessionWriteAction` token matches its effect. So a route added
  // without a gate — or wired to the wrong token — is caught RED, not by a
  // hand-copied `EXPECTED_ACTIONS` literal. See mandate 2d / Joan refinement-(b).
  const gate = makeRestSessionGate({
    requireBrowserAuth: deps.requireBrowserAuth === true,
    ...(deps.operatorUsers ? { operatorUsers: deps.operatorUsers } : {}),
    ...(deps.operatorSet ? { operatorSet: deps.operatorSet } : {}),
  });

  // PUSHBACK-3 FIX-P3-1: the `/prompt` route gets a command-classifying gate.
  // `send_prompt` is co-drive, but the forwarded TEXT can be a bridge COMMAND the
  // bridge executes (host shell, shutdown, kill+respawn, model-switch) — a
  // command-form authorizes operator-only (`prompt-command` → op-2 403); a raw
  // prompt stays co-drive. Tagged `send_prompt` for the route-table coverage.
  const promptGate = makeRestPromptGate({
    requireBrowserAuth: deps.requireBrowserAuth === true,
    ...(deps.operatorUsers ? { operatorUsers: deps.operatorUsers } : {}),
    ...(deps.operatorSet ? { operatorSet: deps.operatorSet } : {}),
  });

  // Post-respawn VERIFY gate (build-gate item 2). Production default wires the
  // real oracles (createProductionProbes: kill-0 + :9999 isSessionConnected +
  // sendToSession-boolean + observed session.model change). Tests inject
  // `deps.resurrectVerify` to drive the 5 assertions deterministically.
  // See change: unend-mechanism-v2.
  const runResurrectVerify =
    deps.resurrectVerify ??
    ((sessionId: string) =>
      verifyResurrection(
        createProductionProbes({ sessionId, sessionManager, piGateway }),
      ));

  /**
   * Gate pi-dependent operations on bootstrap status. Returns:
   *   - null when ready (proceed).
   *   - `{ code: 202, body: { status: "queued", ticketId } }` when installing;
   *     the operation is enqueued and will run once status flips to "ready".
   *   - `{ code: 503, body: { error } }` when failed.
   * See change: unified-bootstrap-install §5.
   */
  function gateOrEnqueue<T>(handler: () => Promise<T>):
    | null
    | { code: 202; body: { status: "queued"; ticketId: string } }
    | { code: 503; body: { error: string; bootstrap: "failed" | "version-too-old" } } {
    if (!bootstrapState) return null;
    const snap = bootstrapState.get();
    // Block when pi version is below the configured minimum —
    // even when status is "ready", a too-old pi must not run sessions.
    // See change: unified-bootstrap-install §9.3.
    if (
      snap.status === "ready"
      && snap.error?.message?.startsWith("pi version ")
    ) {
      return {
        code: 503,
        body: { error: snap.error.message, bootstrap: "version-too-old" },
      };
    }
    if (snap.status === "ready") return null;
    if (snap.status === "installing") {
      if (!bootstrapQueue) {
        return {
          code: 202,
          body: { status: "queued", ticketId: "" },
        };
      }
      const ticket = bootstrapQueue.enqueue(handler);
      return {
        code: 202,
        body: { status: "queued", ticketId: ticket.ticketId },
      };
    }
    // status === "failed"
    return {
      code: 503,
      body: { error: "pi not installed (bootstrap failed)", bootstrap: "failed" },
    };
  }

  // POST /api/session/:id/prompt
  fastify.post<IdParams & { Body: { text?: string; images?: any[] } }>(
    "/api/session/:id/prompt",
    { preHandler: promptGate },
    async (request, reply) => {
      const { id } = request.params;
      const { text, images } = request.body ?? {};
      if (!text) {
        reply.code(400);
        return { success: false, error: "text is required" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      // Locus-3 REST author-stamp (multi-operator, Surface A — §16.1 merge). The
      // REST `/prompt` send is the THIRD author carrier. Derive the author from
      // Build-1b's `request.restPrincipal` (stashed by auth-plugin.ts's onRequest
      // hook, read by rest-session-gate.ts) — server-derived, NEVER from the
      // request body, so BA-2 holds by construction. Downstream of the
      // `promptGate` preHandler (attribution ⊥ authorization, Contract-3).
      // Conditional-spread keeps flag-off byte-unchanged. REUSES the Build-1b
      // REST-identity stash — no second REST-identity path.
      const restAuthor = deriveAuthor((request as any).restPrincipal ?? null, deps.operatorUsers);
      const sent = piGateway.sendToSession(id, {
        type: "send_prompt",
        sessionId: id,
        text,
        images,
        ...(restAuthor ? { author: restAuthor } : {}),
      });
      if (!sent) {
        reply.code(502);
        // W1b: surface WHY there's no bridge, not just THAT there isn't one.
        // The recorded disconnect reason (heartbeat-timeout / cross-wire /
        // process-gone / clean-shutdown / unknown) turns an opaque 502 into an
        // actionable one. See change: bridge-disconnect-reason.
        const why = result.session.bridgeDisconnectReason;
        return {
          success: false,
          error: why
            ? `no bridge connection for session (last disconnect: ${why})`
            : "no bridge connection for session",
        } satisfies ApiResponse;
      }
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/abort
  fastify.post<IdParams>(
    "/api/session/:id/abort",
    { preHandler: gate("abort") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      piGateway.sendToSession(id, { type: "abort", sessionId: id });
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/shutdown
  fastify.post<IdParams>(
    "/api/session/:id/shutdown",
    { preHandler: gate("shutdown") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      piGateway.sendToSession(id, { type: "shutdown", sessionId: id });
      browserGateway.headlessPidRegistry.killBySessionId(id);
      sessionManager.unregister(id);
      browserGateway.broadcastSessionRemoved(id);
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/rename
  fastify.post<IdParams & { Body: { name?: string } }>(
    "/api/session/:id/rename",
    { preHandler: gate("rename") },
    async (request, reply) => {
      const { id } = request.params;
      const { name } = request.body ?? {};
      if (name === undefined) {
        reply.code(400);
        return { success: false, error: "name is required" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const updates = { name: name || undefined };
      sessionManager.update(id, updates);
      browserGateway.broadcastSessionUpdated(id, updates);
      piGateway.sendToSession(id, { type: "rename_session", sessionId: id, name });
      // W4 — name-sync write-pin (row-hygiene name-canon completion, F5-write).
      // A raw rename updated the dashboard record + bridge but NOT the registry
      // pin, so `pi-dashboard-name-sync` reclobbered it ~120s later. Write
      // `operatorPinnedName` to the messenger registry (atomic temp+rename, as
      // pi-rename does) so the rename SURVIVES a name-sync tick. Single source
      // of truth = the registry pin. Best-effort: a registry miss (dashboard-
      // only session with no mesh entry) does NOT fail the rename.
      // See change: name-sync-write-pin.
      const pinResult = writeOperatorPin(id, name || undefined);
      // Consistency check (W4 (b)): after the write, the registry pin and the
      // row name MUST agree. Surface divergence LOUD (the detection missing
      // today) — e.g. a concurrent raw registry edit, or a write that silently
      // no-op'd. `no-matching-entry` is benign (no mesh entry for this session).
      if (pinResult.ok) {
        const consistency = checkNamePinConsistency(name || undefined, readOperatorPin(id));
        if (consistency.divergent) {
          console.warn(
            `[dashboard] W4 name-pin DIVERGENCE for ${id}: row="${consistency.rowName ?? ""}" ` +
            `!= registry pin="${consistency.registryPin ?? ""}" — investigate (name-sync will honor the pin).`,
          );
        }
      } else if (pinResult.reason === "write-failed") {
        console.warn(
          `[dashboard] W4 name-pin write FAILED for ${id} (registry file=${pinResult.file ?? "?"}); ` +
          `rename applied to dashboard but NOT pinned — name-sync may reclobber it.`,
        );
      }
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/resurrect
  //
  // Component B — the operator's "bring it back, no matter what" (session-
  // resurrection design-pass §3-B / §4). State-aware bring-back to
  // dashboard-interactable, modeled on the sibling rename route above:
  //
  //   case 1  bridge-connected-live → clear tombstone + rebind (display). The
  //           live :9999 socket IS the transport — no respawn. mode:"display".
  //   case 2  bridgeless-live (live pid, no bridge = the Cartographer-2 case) →
  //           controlled single-writer takeover (RATIFIED Option 1): SIGTERM the
  //           live pid → confirm clean exit → respawn `pi --session` so the new
  //           process loads the bridge + registers. Double-writer guarded.
  //           mode:"respawn".
  //   case 3  truly-ended (no live process) → clean `pi --session` continue
  //           respawn (the existing path). mode:"respawn".
  fastify.post<IdParams>(
    "/api/session/:id/resurrect",
    { preHandler: gate("resurrect") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const session = result.session;

      // CC sessions are correctly-ended read-only views — never resurrected.
      if (session.source === "claude-code") {
        reply.code(400);
        return { success: false, error: "claude-code sessions are read-only and cannot be resurrected" } satisfies ApiResponse;
      }

      // ── case 1: bridge-connected-live ────────────────────────────────
      // A live :9999 bridge is the strongest proof of life + already carries
      // transport. Clear the tombstone (if any) and rebind; no respawn.
      if (piGateway.isSessionConnected(id)) {
        resurrectSession(
          id,
          { sessionManager, browserGateway },
          { alive: true, ...(typeof session.pid === "number" ? { pid: session.pid } : {}) },
        );
        return { success: true, data: { resurrected: true, mode: "display" } } satisfies ApiResponse<{ resurrected: boolean; mode: string }>;
      }

      // Resolve live-process state via the registry UUID-join + kill-0.
      const liveness = resolveDriverLiveness(id);

      // Shared respawn-continue path (cases 2 + 3). Returns the raw
      // SpawnResult so both `forceTakeover` (case 2) and case 3 read `.success`
      // off the same shape. Mirrors the resume endpoint's bookkeeping: tag the
      // user-resume intent "front", register the headless pid, stamp
      // pendingDashboardSpawns. Callers guard `session.sessionFile` first.
      //
      // §19 INTERACTIVE FORM — FORCED (design-pass §3-A, §4a item 4): the
      // respawn uses `strategy:"tmux"`, OVERRIDING `loadConfig().spawnStrategy`
      // (which defaults to "headless"). The headless `--mode rpc` form is the
      // one that crashed on the real Cartographer-2; the §19 interactive tmux
      // form (`PI_AGENT_NAME=<N> pi --name <N> --session <file>`, NO --model,
      // NO --mode rpc) is the ONE proven to restore a bridge-connected +
      // writable + model-changeable session. The themed identity comes from the
      // live messenger-registry name (case 2) or the session's display name.
      // See change: unend-mechanism-v2.
      const respawnAgentName = liveness.name ?? session.name ?? undefined;
      // ENV-INDEPENDENT ANTI-CROSS-WIRE PIN (see change: pin-on-resurrect).
      // Pin the respawn's bridge to THIS server's own gateway so a
      // multi-dashboard host (e.g. prod :8000 + :8001 both mDNS-advertising)
      // can't migrate the respawned session to a sibling dashboard via mDNS
      // discovery → `updateUrl`. With PI_DASHBOARD_URL set, the spawned bridge
      // captures it as `pinnedUrl` and the ISOLATION GUARD in
      // server-auto-start.ts short-circuits discovery entirely.
      //
      // ⚠ CRITICAL: source the RUNTIME pi-gateway port, NEVER
      // `loadConfig().piPort`. The live `piGateway.address()` is the
      // actually-bound socket port (ground truth even under ephemeral :0);
      // `deps.serverPiPort` (threaded from `ServerConfig.piPort` = the value
      // passed to `piGateway.start()`, which honors a `--pi-port <N>` CLI
      // override) is the fallback. The config-FILE port can differ from the
      // runtime port → pinning to it would re-introduce the cross-wire bug.
      const runtimePiPort = piGateway.address() ?? deps.serverPiPort;
      const pinDashboardUrl =
        typeof runtimePiPort === "number" ? `ws://localhost:${runtimePiPort}` : undefined;
      const doRespawnContinue = async (): Promise<import("./process-manager.js").SpawnResult> => {
        pendingResumeIntents?.record(id, "front");
        const spawnResult = await spawnPiSession(session.cwd, {
          sessionFile: session.sessionFile!,
          mode: "continue",
          strategy: "tmux",
          // Fix-10: a session-resume MUST use the §19 interactive form or fail
          // loudly — never silently degrade to the headless `--mode rpc`
          // crash-form (the exact prod PATH-miss that motivated this).
          // See change: fail-loud-interactive-resolve.
          requireInteractive: true,
          ...(respawnAgentName ? { agentName: respawnAgentName } : {}),
          ...(pinDashboardUrl ? { pinDashboardUrl } : {}),
        });
        if (spawnResult.process && spawnResult.pid) {
          browserGateway.headlessPidRegistry.register(
            spawnResult.pid,
            session.cwd,
            spawnResult.process,
            spawnResult.spawnToken,
          );
        }
        if (spawnResult.dashboardSpawned && spawnResult.success) {
          pendingDashboardSpawns?.set(session.cwd, (pendingDashboardSpawns?.get(session.cwd) ?? 0) + 1);
        }
        return spawnResult;
      };

      // ── case 2: bridgeless-live → controlled single-writer takeover ──
      if (liveness.alive && typeof liveness.pid === "number") {
        if (!session.sessionFile) {
          reply.code(400);
          return { success: false, error: "session file is unknown" } satisfies ApiResponse;
        }
        const takeover = await forceTakeover(liveness.pid, { respawn: doRespawnContinue });
        if (!takeover.ok) {
          // kill_failed → never respawned over a live writer (guard held).
          reply.code(takeover.reason === "kill_failed" ? 409 : 500);
          return {
            success: false,
            error:
              takeover.reason === "kill_failed"
                ? `live process ${liveness.pid} did not exit; refusing to respawn (double-writer guard)`
                : `respawn failed after takeover${takeover.spawnResult ? `: ${takeover.spawnResult.message}` : ""}`,
          } satisfies ApiResponse;
        }
        // POST-RESPAWN VERIFY (build-gate item 2): the respawn process started,
        // but "started" ≠ "interactable" (the exact v1 false-green). Assert the
        // 5 real oracles before returning success; on failure (after the gate's
        // internal retry) surface a LOUD actionable error, never silent success.
        const verify2 = await runResurrectVerify(id);
        if (!verify2.ok) {
          reply.code(503);
          return {
            success: false,
            error:
              `respawn started but verify gate REJECTED it: assertion "${verify2.failedAssertion}" ` +
              `failed — ${verify2.detail}. Session is NOT fully interactable.`,
          } satisfies ApiResponse;
        }
        return { success: true, data: { resurrected: true, mode: "respawn", verified: true } } satisfies ApiResponse<{ resurrected: boolean; mode: string; verified: boolean }>;
      }

      // ── case 3: truly-ended → clean continue respawn ─────────────────
      if (!session.sessionFile) {
        reply.code(400);
        return { success: false, error: "session file is unknown" } satisfies ApiResponse;
      }
      const respawn = await doRespawnContinue();
      if (!respawn.success) {
        reply.code(500);
        return { success: false, error: respawn.message } satisfies ApiResponse;
      }
      // POST-RESPAWN VERIFY (build-gate item 2) — same gate as case 2.
      const verify3 = await runResurrectVerify(id);
      if (!verify3.ok) {
        reply.code(503);
        return {
          success: false,
          error:
            `respawn started but verify gate REJECTED it: assertion "${verify3.failedAssertion}" ` +
            `failed — ${verify3.detail}. Session is NOT fully interactable.`,
        } satisfies ApiResponse;
      }
      return { success: true, data: { resurrected: true, mode: "respawn", verified: true } } satisfies ApiResponse<{ resurrected: boolean; mode: string; verified: boolean }>;
    },
  );

  // POST /api/session/:id/hide
  fastify.post<IdParams>(
    "/api/session/:id/hide",
    { preHandler: gate("hide") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const updates = { hidden: true };
      sessionManager.update(id, updates);
      browserGateway.broadcastSessionUpdated(id, updates);
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/unhide
  fastify.post<IdParams>(
    "/api/session/:id/unhide",
    { preHandler: gate("unhide") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const updates = { hidden: false };
      sessionManager.update(id, updates);
      browserGateway.broadcastSessionUpdated(id, updates);
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/spawn
  fastify.post<{ Body: { cwd?: string; spawnMode?: string; branch?: string; baseBranch?: string; label?: string } }>(
    "/api/session/spawn",
    { preHandler: gate("spawn") },
    async (request, reply) => {
      const { cwd, spawnMode, branch, baseBranch, label } = request.body ?? {};
      if (!cwd) {
        reply.code(400);
        return { success: false, error: "cwd is required" } satisfies ApiResponse;
      }

      // ── Worktree spawn mode validation ──────────────────────────────
      if (spawnMode === "worktree") {
        // `branch` is the NEW branch to create in the worktree.
        // `baseBranch` (optional) is the branch to branch FROM.
        // If baseBranch is omitted, `branch` must already exist.
        if (!branch || typeof branch !== "string" || branch.length === 0) {
          reply.code(400);
          return { success: false, error: "branch is required for worktree spawn" } satisfies ApiResponse;
        }
        if (baseBranch && typeof baseBranch !== "string") {
          reply.code(400);
          return { success: false, error: "baseBranch must be a string" } satisfies ApiResponse;
        }
        // Validate branch name characters
        if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
          reply.code(400);
          return { success: false, error: `Invalid branch name: "${branch}"` } satisfies ApiResponse;
        }
        if (baseBranch && !/^[a-zA-Z0-9._\/-]+$/.test(baseBranch)) {
          reply.code(400);
          return { success: false, error: `Invalid base branch name: "${baseBranch}"` } satisfies ApiResponse;
        }
        // Validate cwd is absolute
        if (!isAbsolute(cwd)) {
          reply.code(400);
          return { success: false, error: "cwd must be an absolute path" } satisfies ApiResponse;
        }
        // Check git repo
        if (!isInsideWorkTree(cwd)) {
          reply.code(400);
          return { success: false, error: "not_a_git_repo" } satisfies ApiResponse;
        }
      }

      const doSpawn = async () => {
        const config = loadConfig();

        // Build pre-spawn hook for worktree mode
        let preSpawnHook: ((ctx: { cwd: string; branch?: string; label?: string }) => Promise<string>) | undefined;
        if (spawnMode === "worktree" && branch) {
          preSpawnHook = async (ctx) => {
            const repoRoot = resolveRepoRoot(ctx.cwd);
            const result = addWorktree(repoRoot, branch, {
              label: label ?? undefined,
              baseBranch: baseBranch ?? undefined,
            });
            try {
              execSync("npm install", { cwd: result.path, stdio: "pipe", timeout: 120_000 });
            } catch { /* non-fatal */ }
            return result.path;
          };
        }

        const spawnResult = await spawnPiSession(cwd, {
          strategy: config.spawnStrategy,
          preSpawnHook,
          ...(branch ? { branch } as any : {}),
          ...(label ? { label } as any : {}),
        });

        if (spawnResult.process && spawnResult.pid) {
          browserGateway.headlessPidRegistry.register(
            spawnResult.pid,
            spawnResult.cwd ?? cwd,
            spawnResult.process,
          );
        }
        if (spawnResult.dashboardSpawned && spawnResult.success) {
          const actualCwd = spawnResult.cwd ?? cwd;
          pendingDashboardSpawns?.set(actualCwd, (pendingDashboardSpawns?.get(actualCwd) ?? 0) + 1);
        }
        return spawnResult;
      };

      // Bootstrap gate: if pi isn't ready, queue the spawn and return 202.
      const gate = gateOrEnqueue(doSpawn);
      if (gate) {
        reply.code(gate.code);
        return gate.body;
      }

      // Worktree spawn: return 202 immediately, do work in background
      // (npm install can take 30-120s, which times out tunnel proxies)
      if (spawnMode === "worktree" && branch) {
        reply.code(202);
        const response = { success: true, data: { status: "spawning", message: "Worktree creation started..." } } satisfies ApiResponse;
        // Fire-and-forget the actual spawn
        doSpawn().then((result) => {
          if (!result.success) {
            browserGateway.broadcastToAll({
              type: "spawn_error",
              cwd,
              strategy: loadConfig().spawnStrategy,
              message: result.message,
              code: result.code ?? "SPAWN_FAILED",
            } as any);
          }
        }).catch((err) => {
          browserGateway.broadcastToAll({
            type: "spawn_error",
            cwd,
            strategy: loadConfig().spawnStrategy,
            message: err.message ?? String(err),
            code: "SPAWN_ERRNO",
          } as any);
        });
        return response;
      }

      const spawnResult = await doSpawn();
      if (!spawnResult.success) {
        // Return structured error code when available (spec: error codes §2.5)
        const code = spawnResult.code;
        if (code === "dirty_working_tree" || code === "branch_not_found" || code === "not_a_git_repo" || code === "git_unavailable" || code === "branch_already_checked_out") {
          reply.code(400);
          return { success: false, error: code } satisfies ApiResponse;
        }
        reply.code(500);
        return { success: false, error: spawnResult.message } satisfies ApiResponse;
      }
      // Return worktreePath for worktree spawns (spec: return { sessionId, worktreePath })
      const worktreePath = spawnResult.cwd && spawnResult.cwd !== cwd ? spawnResult.cwd : undefined;
      return { success: true, data: { message: spawnResult.message, worktreePath } } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/resume
  fastify.post<IdParams & { Body: { mode?: string } }>(
    "/api/session/:id/resume",
    { preHandler: gate("resume") },
    async (request, reply) => {
      const { id } = request.params;
      const { mode } = request.body ?? {};
      if (mode !== "continue" && mode !== "fork") {
        reply.code(400);
        return { success: false, error: "mode must be 'continue' or 'fork'" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const session = result.session;
      if (!session.sessionFile) {
        reply.code(400);
        return { success: false, error: "session file is unknown" } satisfies ApiResponse;
      }
      if (mode === "continue" && session.status !== "ended") {
        reply.code(409);
        return { success: false, error: "session is already active" } satisfies ApiResponse;
      }
      if (session.resuming) {
        reply.code(409);
        return { success: false, error: "session is already being resumed" } satisfies ApiResponse;
      }
      // Fork preflight: silent-degrade when the source has no on-disk JSONL.
      // Mirrors the WS-handler logic. See change:
      // fix-fork-empty-session-silent-timeout.
      if (mode === "fork" && !existsSync(session.sessionFile)) {
        // Inherit attachedProposal from parent.
        if (session.attachedProposal && pendingAttachRegistry) {
          pendingAttachRegistry.enqueue(session.cwd, session.attachedProposal);
        }
        const degradeConfig = loadConfig();
        // Fix-11 scope note: fork-degrade is a FRESH spawn (no sessionFile —
        // the source had no on-disk history) → replays no large log, cannot hit
        // the headless crash-form. Left on config strategy so tmux-less hosts
        // keep the graceful fallback. See change: harden-headless-resume-paths.
        const degradeResult = await spawnPiSession(session.cwd, {
          strategy: degradeConfig.spawnStrategy,
        });
        if (degradeResult.process && degradeResult.pid) {
          browserGateway.headlessPidRegistry.register(
            degradeResult.pid,
            session.cwd,
            degradeResult.process,
            degradeResult.spawnToken,
          );
        }
        if (degradeResult.dashboardSpawned && degradeResult.success) {
          pendingDashboardSpawns?.set(
            session.cwd,
            (pendingDashboardSpawns?.get(session.cwd) ?? 0) + 1,
          );
        }
        if (!degradeResult.success) {
          reply.code(500);
          return {
            success: false,
            error: degradeResult.message,
          } satisfies ApiResponse;
        }
        return {
          success: true,
          data: { message: FORK_DEGRADED_TO_NEW_MESSAGE },
          code: FORK_DEGRADED_TO_NEW_CODE,
        } satisfies ApiResponse<{ message: string }>;
      }
      // Tag the user-resume intent BEFORE spawning. REST resume always
      // uses "front" placement — the only "keep" path is drag-to-resume
      // which goes through the WebSocket handler, not this REST endpoint.
      // See changes: preserve-session-order-on-reboot,
      //              differentiate-resume-intent-by-trigger.
      pendingResumeIntents?.record(id, "front");
      // Fix-11: a real session-RESUME (loads the existing --session file = the
      // large-log crash risk) MUST use the §19 interactive form or fail loud —
      // NEVER silently default to the headless `--mode rpc` crash-form. Pin the
      // respawn's bridge to THIS server's own gateway (anti-cross-wire).
      // See change: harden-headless-resume-paths.
      const resumePin = resolvePinDashboardUrl(piGateway, deps.serverPiPort);
      const spawnResult = await spawnPiSession(session.cwd, buildInteractiveResumeOptions({
        sessionFile: session.sessionFile,
        mode,
        ...(session.name ? { agentName: session.name } : {}),
        ...(resumePin ? { pinDashboardUrl: resumePin } : {}),
      }));
      // Fork bookkeeping uses the spawn token (not cwd) so two concurrent
      // forks in the same cwd correlate correctly. See change:
      // spawn-correlation-token.
      if (mode === "fork" && pendingForkRegistry && spawnResult.spawnToken) {
        pendingForkRegistry.recordFork(spawnResult.spawnToken, id);
      }
      if (spawnResult.dashboardSpawned && spawnResult.success) {
        pendingDashboardSpawns?.set(session.cwd, (pendingDashboardSpawns?.get(session.cwd) ?? 0) + 1);
      }
      if (!spawnResult.success) {
        reply.code(500);
        return { success: false, error: spawnResult.message } satisfies ApiResponse;
      }
      return { success: true, data: { message: spawnResult.message } } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/flow-control
  fastify.post<IdParams & { Body: { action?: string } }>(
    "/api/session/:id/flow-control",
    { preHandler: gate("flow-control") },
    async (request, reply) => {
      const { id } = request.params;
      const { action } = request.body ?? {};
      if (action !== "abort" && action !== "toggle_autonomous") {
        reply.code(400);
        return { success: false, error: "action must be 'abort' or 'toggle_autonomous'" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      piGateway.sendToSession(id, { type: "flow_control", sessionId: id, action });
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/model
  fastify.post<IdParams & { Body: { provider?: string; modelId?: string } }>(
    "/api/session/:id/model",
    { preHandler: gate("model") },
    async (request, reply) => {
      const { id } = request.params;
      const { provider, modelId } = request.body ?? {};
      if (!provider || !modelId) {
        reply.code(400);
        return { success: false, error: "provider and modelId are required" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      piGateway.sendToSession(id, { type: "set_model", sessionId: id, provider, modelId });
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/thinking-level
  fastify.post<IdParams & { Body: { level?: string } }>(
    "/api/session/:id/thinking-level",
    { preHandler: gate("thinking-level") },
    async (request, reply) => {
      const { id } = request.params;
      const { level } = request.body ?? {};
      if (!level) {
        reply.code(400);
        return { success: false, error: "level is required" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      piGateway.sendToSession(id, { type: "set_thinking_level", sessionId: id, level });
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/attach-proposal
  fastify.post<IdParams & { Body: { changeName?: string } }>(
    "/api/session/:id/attach-proposal",
    { preHandler: gate("attach-proposal") },
    async (request, reply) => {
      const { id } = request.params;
      const { changeName } = request.body ?? {};
      if (!changeName) {
        reply.code(400);
        return { success: false, error: "changeName is required" } satisfies ApiResponse;
      }
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const updates: Record<string, unknown> = { attachedProposal: changeName };
      const session = result.session;
      // Idempotent auto-rename (see change: fix-mobile-attach-proposal-display).
      const newName = attachRenameTarget(session, changeName);
      if (newName !== undefined) {
        updates.name = newName;
        piGateway.sendToSession(id, { type: "rename_session", sessionId: id, name: newName });
      }
      sessionManager.update(id, updates);
      browserGateway.broadcastSessionUpdated(id, updates);
      return { success: true } satisfies ApiResponse;
    },
  );

  // POST /api/session/:id/detach-proposal
  fastify.post<IdParams>(
    "/api/session/:id/detach-proposal",
    { preHandler: gate("detach-proposal") },
    async (request, reply) => {
      const { id } = request.params;
      const result = getSessionOrFail(sessionManager, id);
      if ("error" in result) {
        reply.code(404);
        return result.error;
      }
      const session = result.session;
      const updates: Record<string, unknown> = {
        attachedProposal: null, openspecPhase: null, openspecChange: null,
      };
      // Idempotent auto-revert (see change: fix-mobile-attach-proposal-display).
      if (detachShouldClearName(session)) {
        updates.name = undefined;
        piGateway.sendToSession(id, { type: "rename_session", sessionId: id, name: "" });
      }
      sessionManager.update(id, updates);
      browserGateway.broadcastSessionUpdated(id, updates);
      return { success: true } satisfies ApiResponse;
    },
  );
}
