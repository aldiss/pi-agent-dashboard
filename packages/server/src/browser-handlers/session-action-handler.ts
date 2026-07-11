/**
 * Session action handlers: send_prompt, abort, resume, spawn, shutdown, flow_control.
 */
import { existsSync } from "node:fs";
import type { BrowserToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { BrowserHandlerContext } from "./handler-context.js";
import { spawnPiSession } from "../process-manager.js";
import { buildInteractiveResumeOptions, resolvePinDashboardUrl } from "../resume-spawn-options.js";
import { ToolResolver } from "@blackbelt-technology/pi-dashboard-shared/platform/binary-lookup.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { preflightSpawn } from "../spawn-preflight.js";
import { getSpawnRegisterWatchdog } from "../spawn-register-watchdog.js";
import { appendSpawnFailure } from "../spawn-failure-log.js";
import { createBranchedSessionFile } from "../session-file-reader.js";
import {
  killPidWithGroup,
  killProcess,
} from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import {
  findPidByMarker,
} from "@blackbelt-technology/pi-dashboard-shared/platform/process-identify.js";
import { shouldInterceptReload } from "./session-action-helpers.js";
import { authorizeSessionAction } from "../session-authz.js";
import { classifySendPromptAction } from "../send-prompt-authz.js";
import { deriveAuthor } from "../derive-author.js";

/**
 * Status message + code emitted when fork is attempted on a session whose
 * `.jsonl` does not exist on disk yet (empty session, no persisted entries).
 * The dashboard silently degrades to a fresh spawn in the same cwd — fork
 * has no history to copy, so the user-meaningful semantic of "fork" and
 * "new" is identical here. The structured code lets the client surface a
 * non-blocking toast.
 * See change: fix-fork-empty-session-silent-timeout.
 */
export const FORK_DEGRADED_TO_NEW_MESSAGE =
  "Started a fresh session \u2014 the source had no persisted history to fork from.";
export const FORK_DEGRADED_TO_NEW_CODE = "FORK_DEGRADED_TO_NEW";

/**
 * Find headless pi PIDs associated with a session-id marker and kill them.
 * Delegates platform branching to `platform/process-identify.ts` — Windows
 * returns `[]` because command-line lookup isn't viable; Windows kills go
 * through `headlessPidRegistry` instead.
 * See change: consolidate-windows-spawn-and-platform-handlers.
 */
function killHeadlessBySessionId(sessionId: string): boolean {
  const pids = findPidByMarker(sessionId);
  if (pids.length === 0) return false;
  for (const pid of pids) {
    // `killPidWithGroup` is the canonical platform helper. Failures here
    // (e.g. ESRCH because the process is already dead) are non-fatal —
    // the caller treats "no matching PID" and "PID already dead" the
    // same way. Log and continue. See change:
    // route-kill-paths-through-platform.
    try {
      killPidWithGroup(pid, "SIGTERM");
    } catch (err) {
      console.warn(
        `[dashboard] killHeadlessBySessionId: killPidWithGroup(${pid}) failed:`,
        err,
      );
    }
  }
  return true;
}

/**
 * Emit a `command_feedback` DashboardEvent to all subscribed browsers.
 * Mirrors what the bridge's command-handler does for TUI `/reload`, but from
 * the server side for the headless-reload path.
 *
 * See change: headless-reload-via-respawn.
 */
function emitCommandFeedback(
  ctx: BrowserHandlerContext,
  sessionId: string,
  status: "started" | "completed" | "error",
  message?: string,
): void {
  const event = {
    eventType: "command_feedback",
    timestamp: Date.now(),
    data: { command: "/reload", status, ...(message ? { message } : {}) },
  };
  const seq = ctx.eventStore.insertEvent(sessionId, event);
  ctx.broadcast({ type: "event", sessionId, seq, event } as any);
}

/**
 * Headless-session `/reload` handler.
 *
 * pi-coding-agent 0.68.0 has no programmatic reload path accessible to an
 * extension in RPC mode:
 *   - `ExtensionContext` (delivered to `session_start`) has no `reload` field
 *   - The RPC protocol has no `{type:"reload"}` command
 *   - The `globalThis[RELOAD_KEY]` bootstrap requires a human to type
 *     `/__dashboard_reload` in pi's TUI, which headless sessions lack.
 *
 * Instead, the server achieves a reload-equivalent outcome by killing the
 * headless pi process and respawning it with `--session <file>`, which
 * re-hydrates the same `sessionId` and entry list. Because
 * `memorySessionManager.register` carries accumulated state (tokens, cost,
 * context usage, attachedProposal) when the same sessionId re-registers,
 * the user-visible session state survives the respawn.
 *
 * See change: headless-reload-via-respawn.
 */
export async function handleHeadlessReload(
  msg: Extract<BrowserToServerMessage, { type: "send_prompt" }>,
  ctx: BrowserHandlerContext,
): Promise<void> {
  const { sessionManager, headlessPidRegistry } = ctx;
  const session = sessionManager.get(msg.sessionId);
  if (!session) {
    emitCommandFeedback(ctx, msg.sessionId, "error", "Session not found");
    return;
  }
  if (!session.sessionFile) {
    emitCommandFeedback(
      ctx,
      msg.sessionId,
      "error",
      "No session file — cannot respawn on reload",
    );
    return;
  }
  if (session.status === "streaming") {
    emitCommandFeedback(
      ctx,
      msg.sessionId,
      "error",
      "Wait for the current response to finish before reloading.",
    );
    return;
  }

  emitCommandFeedback(ctx, msg.sessionId, "started");

  // SIGTERM the old headless pi + clear its registry entry (killBySessionId
  // deletes the entry). No-op if already dead (idempotency guard). This handler
  // is only reached when `shouldInterceptReload` was true = the session had a
  // tracked HEADLESS pid (getPid !== undefined), so the predecessor is always a
  // headless-registry pid — killBySessionId covers it. An INTERACTIVE (tmux)
  // predecessor has no headless-registry pid, so it can never route here (see
  // the caller's shouldInterceptReload gate). See change:
  // harden-headless-reload-resume.
  headlessPidRegistry.killBySessionId(msg.sessionId);

  // Respawn with the same session file. Fix-11 amend: this is a real session-
  // RESUME (mode:"continue" + existing sessionFile = the large-log replay), so
  // it MUST use the §19 interactive form or fail loud — NEVER the headless
  // `--mode rpc` crash-form (the exact class the resume-hardening targets). Same
  // shape as the sibling prompt-auto-resume path. The new pi re-hydrates the
  // same sessionId, the bridge re-registers, and the server preserves
  // accumulated state (tokens/cost/context/attachedProposal).
  // See change: harden-headless-reload-resume.
  const reloadPin = resolvePinDashboardUrl(ctx.piGateway);
  let spawnResult: Awaited<ReturnType<typeof spawnPiSession>>;
  try {
    spawnResult = await spawnPiSession(session.cwd, buildInteractiveResumeOptions({
      sessionFile: session.sessionFile,
      mode: "continue",
      ...(session.name ? { agentName: session.name } : {}),
      ...(reloadPin ? { pinDashboardUrl: reloadPin } : {}),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dashboard] headless reload spawn failed: ${message}`);
    const endedAt = Date.now();
    sessionManager.update(msg.sessionId, { status: "ended", endedAt });
    ctx.broadcast({
      type: "session_updated",
      sessionId: msg.sessionId,
      updates: { status: "ended", endedAt },
    });
    emitCommandFeedback(ctx, msg.sessionId, "error", message);
    return;
  }

  if (!spawnResult.success) {
    console.error(
      `[dashboard] headless reload spawn failed: ${spawnResult.message}`,
    );
    const endedAt = Date.now();
    sessionManager.update(msg.sessionId, { status: "ended", endedAt });
    ctx.broadcast({
      type: "session_updated",
      sessionId: msg.sessionId,
      updates: { status: "ended", endedAt },
    });
    emitCommandFeedback(ctx, msg.sessionId, "error", spawnResult.message);
    return;
  }

  // Fix-11 amend — EXPLICIT no-headless-register for the interactive respawn
  // (Bert). The §19 interactive (tmux) respawn is DETACHED — it returns no
  // pid/process — and an interactive session must NEVER be tracked in the
  // headless-pid registry: that registry is the routing key for
  // `shouldInterceptReload`. Registering the converted session as headless would
  // (a) wrongly route a FUTURE /reload back here instead of the TUI
  // `/__dashboard_reload` path, and (b) let a pid-carrying spawnResult mis-tag an
  // interactive session as headless. So we deliberately do NOT call
  // headlessPidRegistry.register here — the old headless entry was already
  // cleared by killBySessionId above, leaving no stale entry.
  // See change: harden-headless-reload-resume.
  if (spawnResult.pid && spawnResult.process) {
    // Defensive: an interactive respawn should not surface a pid+process. If a
    // future spawn shape ever does, we still must NOT headless-register it —
    // log loud so the invariant violation is visible rather than silently
    // re-introducing the headless-routing bug.
    console.warn(
      `[dashboard] reload: interactive respawn unexpectedly returned pid ${spawnResult.pid} ` +
      `for ${msg.sessionId}; NOT headless-registering (interactive sessions route to TUI reload).`,
    );
  }

  emitCommandFeedback(ctx, msg.sessionId, "completed");
}

export async function handleSendPrompt(
  msg: Extract<BrowserToServerMessage, { type: "send_prompt" }>,
  ctx: BrowserHandlerContext,
): Promise<void> {
  const { sessionManager, piGateway, headlessPidRegistry, pendingResumeRegistry, pendingResumeIntents, pendingDashboardSpawns, broadcast, ws, sendTo } = ctx;

  // ── OUTERMOST session-write gate (Build 0 — PRINCIPAL-CAPTURE) ────────────
  // Every WS send routes through the single central chokepoint. The actor is
  // derived from the connection-bound principal (`ctx.principal`) — NEVER from
  // a client-supplied field in `msg`. In single-operator mode
  // (requireBrowserAuth=false) the gate allows unconditionally (byte-unchanged).
  // In multi-operator mode a principal-less human is refused here (the `/ws`
  // upgrade already refuses such connections; this pins the invariant at the
  // send seam too). A future `service{id}` actor (det-spawn) inherits this same
  // chokepoint. See auth-merge contract invariants #1, #2, #4.
  const decision = authorizeSessionAction({
    actor: { kind: "human", principal: ctx.principal },
    action: "send_prompt",
    requireBrowserAuth: ctx.requireBrowserAuth,
    // Stream-2 D (fix-1 BLOCKER-1): `send_prompt` is a WS_SELF_GATED_TYPE (it
    // bypasses the central `authorizeWsMessage`, so admission must be threaded
    // HERE). This is the PRIMARY co-drive action — N=2 admission MUST bound it:
    // an authorized co-drive POPULATES the cell, and a 3rd distinct human is
    // refused `session-full` admission-first, BEFORE the forward to the bridge.
    // `ctx.operatorSet` is the SAME shared cell the WS/REST gates thread; absent
    // (flag-off / non-multi-op) → admission SKIPPED (byte-unchanged). Actor
    // derivation unchanged (anti-spoof — never the body).
    ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
  });
  if (!decision.allowed) {
    console.error(
      `[dashboard] send_prompt refused by auth gate (session ${msg.sessionId}, reason=${decision.reason})`,
    );
    sendTo(ws, {
      type: "send_prompt_failed",
      sessionId: msg.sessionId,
      ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
      reason: "unauthorized",
    });
    return;
  }

  // Intercept `/reload` on active headless sessions — forward the request to
  // our kill-and-respawn handler instead of routing the prompt to the bridge
  // (the bridge has no programmatic reload path on RPC).
  // See change: headless-reload-via-respawn.
  if (shouldInterceptReload(msg, headlessPidRegistry)) {
    // PUSHBACK-2 FIX-P2-4: the `/reload` intercept is a process KILL+RESPAWN
    // (an operator-only lifecycle primitive), NOT a co-drive prompt. It must
    // NOT ride the co-drive `send_prompt` verdict above — re-authorize the
    // distinct operator-only `reload` action through the ONE chokepoint FIRST,
    // deriving the actor from the connection-bound principal (never the body).
    // op-2 (a bounded co-driver, refused kill_process/force_kill on the WS seam)
    // must not SIGTERM+respawn a headless pi via `send_prompt {text:"/reload"}`.
    const reloadDecision = authorizeSessionAction({
      actor: { kind: "human", principal: ctx.principal },
      action: "reload",
      requireBrowserAuth: ctx.requireBrowserAuth,
      ...(ctx.operatorUsers ? { operatorUsers: ctx.operatorUsers } : {}),
      // Stream-2 D (fix-1): admission-first consistency. Harmless — reload is
      // operator-only (a non-member is refused regardless), but a 3rd non-member
      // should hit `session-full` at admission first. Idempotent for a member
      // already admitted by the :236 co-drive gate above.
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
    });
    if (!reloadDecision.allowed) {
      console.error(
        `[dashboard] /reload refused by auth gate (session ${msg.sessionId}, reason=${reloadDecision.reason}) — kill+respawn is operator-only`,
      );
      sendTo(ws, {
        type: "send_prompt_failed",
        sessionId: msg.sessionId,
        ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
        reason: "unauthorized",
      });
      return;
    }
    await handleHeadlessReload(msg, ctx);
    return;
  }

  // ── PUSHBACK-3 FIX-P3-1: command-form send_prompt is operator-only ─────────
  // `send_prompt` is co-drive, but the bridge PARSES the forwarded text into
  // COMMANDS it EXECUTES (`!`/`!!` host shell, `/quit`/`/exit` shutdown, `/new`
  // spawn, `/model …` model-switch, `/compact`, any `/slash`, and — on a
  // non-headless session, below the reload intercept — `/reload`). So a bounded
  // co-driver could reach the operator-only/host command surface via prompt
  // TEXT. Classify the text through the SHARED `classifySendPromptAction` (the
  // SAME `parseSendPrompt` the bridge executes — no drift). A RAW passthrough is
  // already covered by the co-drive `send_prompt` gate above (one authorize), so
  // we ONLY escalate here for a COMMAND FORM: re-authorize the operator-only
  // `prompt-command` action (op-2 REFUSED). The actor is the connection-bound
  // principal, NEVER the body. Flag OFF → allowed (byte-unchanged). Subsumes P2-4
  // for the interactive `/reload` (a command form).
  const promptAction = classifySendPromptAction(msg.text);
  if (promptAction === "prompt-command") {
    const commandDecision = authorizeSessionAction({
      actor: { kind: "human", principal: ctx.principal },
      action: "prompt-command",
      requireBrowserAuth: ctx.requireBrowserAuth,
      ...(ctx.operatorUsers ? { operatorUsers: ctx.operatorUsers } : {}),
      // Stream-2 D (fix-1): admission-first consistency (operator-only action —
      // idempotent for a member already admitted at :236).
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
    });
    if (!commandDecision.allowed) {
      console.error(
        `[dashboard] send_prompt command-form refused by auth gate (session ${msg.sessionId}, ` +
          `reason=${commandDecision.reason}) — bridge commands are operator-only`,
      );
      sendTo(ws, {
        type: "send_prompt_failed",
        sessionId: msg.sessionId,
        ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
        reason: "unauthorized",
      });
      return;
    }
  }

  const promptSession = sessionManager.get(msg.sessionId);

  if (promptSession?.status === "ended") {
    // ── PUSHBACK-3 FIX-P3-4 (dual-review BLOCKER-1): resurrecting an ENDED session
    // via send_prompt is the operator-only `resume` effect, not co-driving a
    // live one. The auto-resume below is byte-identical to
    // `handleResumeSession` (spawnPiSession + buildInteractiveResumeOptions),
    // yet it fires AFTER the co-drive send_prompt gate with ZERO operator re-auth
    // — so op-2 could resurrect ANY ended session (wider than P2-4's /reload,
    // which needs an active headless pid). Re-authorize the operator-only
    // `resume` action through the ONE chokepoint BEFORE the auto-resume spawn
    // (actor from the connection-bound principal, mirroring the P2-4 /reload
    // block). Flag OFF → allowed (byte-unchanged). A raw prompt on an ALIVE
    // session is unaffected (co-drive, the else-branch below).
    const resumeDecision = authorizeSessionAction({
      actor: { kind: "human", principal: ctx.principal },
      action: "resume",
      requireBrowserAuth: ctx.requireBrowserAuth,
      ...(ctx.operatorUsers ? { operatorUsers: ctx.operatorUsers } : {}),
      // Stream-2 D (fix-1): admission-first consistency (operator-only action —
      // idempotent for a member already admitted at :236).
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
    });
    if (!resumeDecision.allowed) {
      console.error(
        `[dashboard] send_prompt auto-resume refused by auth gate (session ${msg.sessionId}, ` +
          `reason=${resumeDecision.reason}) — resurrecting an ended session is operator-only`,
      );
      sendTo(ws, {
        type: "send_prompt_failed",
        sessionId: msg.sessionId,
        ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
        reason: "unauthorized",
      });
      return;
    }
    if (!promptSession.sessionFile) {
      console.error(`[dashboard] auto-resume failed: no session file for session ${msg.sessionId}`);
      return;
    }
    const alreadyResuming = promptSession.resuming;
    // Capture the author at RECORD-TIME (Surface A) — the replay in
    // event-wiring.ts has no ctx.principal (cwd-keyed bridge event), so it
    // cannot be re-derived there. Server-derived, NEVER from msg. Downstream of
    // the Build-1b operator-only `resume` gate above (attribution ⊥ authz).
    const resumeAuthor = deriveAuthor(ctx.principal, ctx.operatorUsers);
    pendingResumeRegistry.record(promptSession.cwd, {
      text: msg.text,
      images: msg.images,
      oldSessionId: msg.sessionId,
      sessionFile: promptSession.sessionFile,
      ...(resumeAuthor ? { author: resumeAuthor } : {}),
    });
    if (alreadyResuming) return;
    // Tag the resume intent as "front" so the upcoming ended→alive
    // transition surfaces this card at the top of the alive tier. The
    // user is actively typing into this session; surfacing it matches
    // their mental model. See change: differentiate-resume-intent-by-trigger.
    pendingResumeIntents?.record(msg.sessionId, "front");
    sessionManager.update(msg.sessionId, { resuming: true });
    broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { resuming: true } });
    // Fix-11: prompt-auto-resume replays the existing --session file (the
    // large-log crash risk) — route through the §19 interactive form or fail
    // loud, NEVER silently default to the headless `--mode rpc` crash-form.
    // See change: harden-headless-resume-paths.
    const autoResumePin = resolvePinDashboardUrl(piGateway);
    const spawnResult = await spawnPiSession(promptSession.cwd, buildInteractiveResumeOptions({
      sessionFile: promptSession.sessionFile,
      mode: "continue",
      ...(promptSession.name ? { agentName: promptSession.name } : {}),
      ...(autoResumePin ? { pinDashboardUrl: autoResumePin } : {}),
    }));
    if (!spawnResult.success) {
      console.error(`[dashboard] auto-resume spawn failed: ${spawnResult.message}`);
      pendingResumeRegistry.consume(promptSession.cwd);
      sessionManager.update(msg.sessionId, { resuming: false });
      broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { resuming: false } });
    }
    if (spawnResult.dashboardSpawned && spawnResult.success) {
      pendingDashboardSpawns?.set(promptSession.cwd, (pendingDashboardSpawns?.get(promptSession.cwd) ?? 0) + 1);
    }
    if (spawnResult.process && spawnResult.pid) {
      headlessPidRegistry.register(spawnResult.pid, promptSession.cwd, spawnResult.process);
    }
  } else {
    // Locus-1 author-stamp (multi-operator, Surface A). Derive the author
    // SERVER-SIDE from the connection-bound principal — NEVER from `msg` (the
    // client cannot claim it). Downstream of the Build-1b co-drive/operator-only
    // gates above (attribution ⊥ authorization, Contract-3). The send stays
    // field-by-field (NOT a `...msg` spread) — the anti-spoof invariant.
    // Conditional-spread keeps flag-off byte-unchanged: single-operator derives
    // no principal → no `author` key. This carrier's attribution is enforced by
    // the derived-carrier-guard (`surface-attribution-carrier-guard.test.ts`).
    const author = deriveAuthor(ctx.principal, ctx.operatorUsers);
    const sent = piGateway.sendToSession(msg.sessionId, {
      type: "send_prompt",
      sessionId: msg.sessionId,
      text: msg.text,
      images: msg.images,
      ...(author ? { author } : {}),
      // Thread the client's queue correlation id to the bridge so it can
      // reuse it as the queued message's queueNonce (the client's optimistic
      // card reconciles by exact match). See change: dashboard-message-queue.
      ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
    });
    if (!sent) {
      console.error(`[dashboard] send_prompt failed: no bridge connection for session ${msg.sessionId}`);
      // AMEND #5 (f) delivery-aware-fail (2a): tell the BROWSER, not only the
      // log. `sent === false` means no bridge connection — the message
      // genuinely never reached pi. Emit the explicit bridge-absent failure so
      // the client marks its optimistic queue card "failed" immediately
      // (retry-safe), instead of waiting out a bare timeout that cannot tell
      // bridge-absent from connected-but-slow. See change: dashboard-message-queue.
      sendTo(ws, {
        type: "send_prompt_failed",
        sessionId: msg.sessionId,
        ...(msg.queueNonce ? { queueNonce: msg.queueNonce } : {}),
        reason: "no bridge connection",
      });
    }
  }
}

export async function handleResumeSession(
  msg: Extract<BrowserToServerMessage, { type: "resume_session" }>,
  ctx: BrowserHandlerContext,
): Promise<void> {
  const { ws, sessionManager, pendingForkRegistry, headlessPidRegistry, pendingDashboardSpawns, pendingResumeIntents, pendingClientCorrelations, sendTo } = ctx;
  const session = sessionManager.get(msg.sessionId);
  if (!session) {
    sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: false, message: "Session not found", requestId: msg.requestId });
    return;
  }
  // Resolve placement intent. Old browsers omit the field; default to
  // "front" so they keep getting today's behavior. Drag-to-resume sends
  // "keep" so the dropped slot is preserved through the resume round-trip.
  // See change: differentiate-resume-intent-by-trigger.
  const placement: "front" | "keep" = msg.placement ?? "front";
  if (!session.sessionFile) {
    sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: false, message: "Session file is unknown (pre-migration session)", requestId: msg.requestId });
    return;
  }
  if (msg.mode === "continue" && session.status !== "ended") {
    sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: false, message: "Session is already active", requestId: msg.requestId });
    return;
  }
  if (session.resuming) {
    sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: false, message: "Session is already being resumed", requestId: msg.requestId });
    return;
  }
  // Fork preflight: silent-degrade when the source session has no on-disk
  // JSONL yet (empty session, no persisted entries). `pi --fork <missing>`
  // would crash silently and produce a 30s register-timeout; instead we
  // spawn a fresh pi in the same cwd and surface `code: FORK_DEGRADED_TO_NEW`
  // so the client can render a non-blocking toast. The parent's
  // attachedProposal (if any) is inherited via `pendingAttachRegistry`
  // since fork's own inheritance path doesn't run on this branch.
  // See change: fix-fork-empty-session-silent-timeout.
  if (msg.mode === "fork" && session.sessionFile && !existsSync(session.sessionFile)) {
    // Inherit attachedProposal from parent so the new session still
    // tracks the change the user was working on.
    const pendingAttachRegistry = ctx.pendingAttachRegistry;
    if (session.attachedProposal && pendingAttachRegistry) {
      pendingAttachRegistry.enqueue(session.cwd, session.attachedProposal);
    }
    const degradeConfig = loadConfig();
    // Fix-11 scope note: fork-degrade is a FRESH spawn (no sessionFile — the
    // source had no persisted history) → replays no large log, cannot hit the
    // headless crash-form the resume-hardening targets. Left on config strategy
    // so tmux-less hosts keep the graceful fallback.
    // See change: harden-headless-resume-paths.
    // Fresh spawn: no sessionFile, no mode — just `pi --mode rpc`.
    const degradeResult = await spawnPiSession(session.cwd, {
      strategy: degradeConfig.spawnStrategy,
    });
    if (degradeResult.process && degradeResult.pid) {
      headlessPidRegistry.register(
        degradeResult.pid,
        session.cwd,
        degradeResult.process,
        degradeResult.spawnToken,
      );
    }
    if (msg.requestId && degradeResult.spawnToken && pendingClientCorrelations) {
      pendingClientCorrelations.record(degradeResult.spawnToken, msg.requestId);
    }
    if (degradeResult.dashboardSpawned && degradeResult.success) {
      pendingDashboardSpawns?.set(
        session.cwd,
        (pendingDashboardSpawns?.get(session.cwd) ?? 0) + 1,
      );
    }
    sendTo(ws, {
      type: "resume_result",
      sessionId: msg.sessionId,
      success: degradeResult.success,
      message: degradeResult.success ? FORK_DEGRADED_TO_NEW_MESSAGE : degradeResult.message,
      requestId: msg.requestId,
      ...(degradeResult.success ? { code: FORK_DEGRADED_TO_NEW_CODE } : {}),
    });
    return;
  }
  // For fork-from-message: create a pruned session file first
  let forkSessionFile = session.sessionFile;
  if (msg.mode === "fork" && msg.entryId) {
    try {
      forkSessionFile = createBranchedSessionFile(session.sessionFile, msg.entryId);
    } catch (err: any) {
      sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: false, message: `Fork from entry failed: ${err.message}`, requestId: msg.requestId });
      return;
    }
  }

  // Tag the user-resume intent BEFORE spawning so the `onChange`
  // ended→alive branch in `server.ts` can distinguish a user-initiated
  // resume from a bridge auto-reattach on dashboard reboot, and choose
  // placement (front vs. keep) appropriately. The fork path also tags
  // but the tag is harmless: forks create new session ids that never
  // appear in the ended→alive branch.
  // See changes: preserve-session-order-on-reboot,
  //              differentiate-resume-intent-by-trigger.
  pendingResumeIntents?.record(msg.sessionId, placement);
  // Fix-11: the primary dashboard Resume/Fork path replays the existing
  // --session file (the large-log crash risk) — route through the §19
  // interactive form or fail loud, NEVER silently default to the headless
  // `--mode rpc` crash-form. Pin the respawn to THIS server's own gateway.
  // See change: harden-headless-resume-paths.
  const resumePin = resolvePinDashboardUrl(ctx.piGateway);
  const result = await spawnPiSession(session.cwd, buildInteractiveResumeOptions({
    sessionFile: forkSessionFile,
    mode: msg.mode,
    ...(session.name ? { agentName: session.name } : {}),
    ...(resumePin ? { pinDashboardUrl: resumePin } : {}),
  }));
  // Record fork parent keyed by spawn token (was: keyed by cwd, racy on
  // multi-fork-in-same-cwd). See change: spawn-correlation-token.
  if (msg.mode === "fork" && pendingForkRegistry && result.spawnToken) {
    pendingForkRegistry.recordFork(result.spawnToken, msg.sessionId);
  }
  // Record client-correlation so the eventual session_added carries
  // spawnRequestId. See change: spawn-correlation-token.
  if (msg.requestId && result.spawnToken && pendingClientCorrelations) {
    pendingClientCorrelations.record(result.spawnToken, msg.requestId);
  }
  if (result.dashboardSpawned && result.success) {
    pendingDashboardSpawns?.set(session.cwd, (pendingDashboardSpawns?.get(session.cwd) ?? 0) + 1);
  }
  if (result.process && result.pid) {
    headlessPidRegistry.register(result.pid, session.cwd, result.process, result.spawnToken);
  }
  sendTo(ws, { type: "resume_result", sessionId: msg.sessionId, success: result.success, message: result.message, requestId: msg.requestId });
}

export async function handleSpawnSession(
  msg: Extract<BrowserToServerMessage, { type: "spawn_session" }>,
  ctx: BrowserHandlerContext,
): Promise<void> {
  const { ws, headlessPidRegistry, pendingDashboardSpawns, pendingAttachRegistry, pendingClientCorrelations, sendTo } = ctx;
  const config = loadConfig();
  const strategy = config.spawnStrategy ?? "tmux";

  // Queue the optional attach intent BEFORE awaiting the spawn so a fast
  // bridge `session_register` cannot lose the intent. See change:
  // add-folder-task-checker-and-spawn-attach. NOTE: at this point we don't
  // yet have a spawnToken (spawn hasn't run); we enqueue by cwd-FIFO and
  // re-record by token after spawnPiSession returns. See change:
  // spawn-correlation-token.
  if (typeof msg.attachProposal === "string" && msg.attachProposal.length > 0) {
    pendingAttachRegistry?.enqueue(msg.cwd, msg.attachProposal);
  }

  // ── Preflight: fast synchronous checks before spawning. See change: spawn-failure-diagnostics.
  const preflightResolver = new ToolResolver({ processExecPath: process.execPath, useLoginShell: false });
  const preflight = preflightSpawn(msg.cwd, { resolver: preflightResolver });
  if (!preflight.ok) {
    const message = preflight.reasons.map((r) => r.message).join("; ");
    sendTo(ws, { type: "spawn_result", cwd: msg.cwd, success: false, message, requestId: msg.requestId });
    sendTo(ws, { type: "spawn_error", cwd: msg.cwd, strategy, message, code: "PREFLIGHT_FAILED", reasons: preflight.reasons });
    appendSpawnFailure({
      ts: new Date().toISOString(),
      cwd: msg.cwd,
      strategy,
      code: "PREFLIGHT_FAILED",
      message,
      reasons: preflight.reasons,
    });
    return;
  }

  // Catch both thrown exceptions and { success: false } results; surface as
  // spawn_error so the UI can render a retryable banner instead of failing
  // silently. Previous behaviour left the user staring at an empty state
  // when pi itself was broken in the target folder.
  try {
    const spawnResult = await spawnPiSession(msg.cwd, { strategy });
    if (spawnResult.process && spawnResult.pid) {
      headlessPidRegistry.register(spawnResult.pid, msg.cwd, spawnResult.process, spawnResult.spawnToken);
    }
    // Record client-correlation so the eventual session_added carries
    // spawnRequestId. See change: spawn-correlation-token.
    if (msg.requestId && spawnResult.spawnToken && pendingClientCorrelations) {
      pendingClientCorrelations.record(spawnResult.spawnToken, msg.requestId);
    }
    if (spawnResult.dashboardSpawned && spawnResult.success) {
      pendingDashboardSpawns?.set(msg.cwd, (pendingDashboardSpawns?.get(msg.cwd) ?? 0) + 1);
    }
    sendTo(ws, {
      type: "spawn_result",
      cwd: msg.cwd,
      success: spawnResult.success,
      message: spawnResult.message,
      requestId: msg.requestId,
      ...(spawnResult.pid ? { pid: spawnResult.pid } : {}),
    });
    if (!spawnResult.success) {
      sendTo(ws, {
        type: "spawn_error",
        cwd: msg.cwd,
        strategy,
        message: spawnResult.message,
        ...(spawnResult.code ? { code: spawnResult.code } : {}),
        ...(spawnResult.stderr ? { stderr: spawnResult.stderr } : {}),
      });
      appendSpawnFailure({
        ts: new Date().toISOString(),
        cwd: msg.cwd,
        strategy,
        code: spawnResult.code ?? "SPAWN_ERRNO",
        message: spawnResult.message,
        ...(spawnResult.stderr ? { stderrTail: spawnResult.stderr } : {}),
      });
    } else {
      // Arm watchdog for every successful spawn. See change: spawn-failure-diagnostics.
      const watchdog = getSpawnRegisterWatchdog();
      watchdog.arm({
        pid: spawnResult.pid,
        cwd: msg.cwd,
        mechanism: strategy as import("@blackbelt-technology/pi-dashboard-shared/platform/spawn-mechanism.js").SpawnMechanism,
        logPath: spawnResult.logPath,
        // Read-on-arm: pass current config value so a Settings change takes effect
        // on the next spawn without a server restart. See change: spawn-failure-diagnostics (fix W1).
        timeoutMs: config.spawnRegisterTimeoutMs,
        ws,
        spawnToken: spawnResult.spawnToken,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr).slice(-2048) : undefined;
    sendTo(ws, { type: "spawn_result", cwd: msg.cwd, success: false, message, requestId: msg.requestId });
    sendTo(ws, { type: "spawn_error", cwd: msg.cwd, strategy, message, code: "SPAWN_ERRNO", stderr });
    appendSpawnFailure({
      ts: new Date().toISOString(),
      cwd: msg.cwd,
      strategy,
      code: "SPAWN_ERRNO",
      message,
      ...(stderr ? { stderrTail: stderr } : {}),
    });
  }
}

export function handleShutdown(
  msg: Extract<BrowserToServerMessage, { type: "shutdown" }>,
  ctx: BrowserHandlerContext,
): void {
  const { sessionManager, piGateway, headlessPidRegistry, broadcast } = ctx;
  piGateway.sendToSession(msg.sessionId, { type: "shutdown", sessionId: msg.sessionId });
  headlessPidRegistry.killBySessionId(msg.sessionId);
  killHeadlessBySessionId(msg.sessionId);
  sessionManager.unregister(msg.sessionId);
  broadcast({ type: "session_removed", sessionId: msg.sessionId });
}

export function handleAbort(
  msg: Extract<BrowserToServerMessage, { type: "abort" }>,
  ctx: BrowserHandlerContext,
): void {
  ctx.piGateway.sendToSession(msg.sessionId, { type: "abort", sessionId: msg.sessionId });
}

export function handleFlowControl(
  msg: Extract<BrowserToServerMessage, { type: "flow_control" }>,
  ctx: BrowserHandlerContext,
): void {
  ctx.piGateway.sendToSession(msg.sessionId, { type: "flow_control", sessionId: msg.sessionId, action: msg.action });
}

export function handleKillProcess(
  msg: Extract<BrowserToServerMessage, { type: "kill_process" }>,
  ctx: BrowserHandlerContext,
): void {
  ctx.piGateway.sendToSession(msg.sessionId, { type: "kill_process", sessionId: msg.sessionId, pgid: msg.pgid });
}

/**
 * Pure predicate: does a `ps`/cmdline output string look like a pi/node process?
 * Re-exported from `platform/process-identify.ts` for backwards compat with
 * any external consumer of this handler.
 */
export { isPiCommandLine } from "@blackbelt-technology/pi-dashboard-shared/platform/process-identify.js";

export async function handleForceKill(
  msg: Extract<BrowserToServerMessage, { type: "force_kill" }>,
  ctx: BrowserHandlerContext,
): Promise<void> {
  const { sessionManager, piGateway, headlessPidRegistry, broadcast, sendTo, ws } = ctx;
  const session = sessionManager.get(msg.sessionId);
  if (!session) {
    sendTo(ws, { type: "force_kill_result", sessionId: msg.sessionId, success: false, message: "Session not found" });
    return;
  }

  // Force-close the bridge WebSocket regardless of PID availability
  piGateway.closeSession(msg.sessionId);

  const pid = session?.pid;
  if (!pid) {
    // No PID — we can only close the WebSocket
    sessionManager.update(msg.sessionId, { status: "ended", endedAt: Date.now() });
    broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { status: "ended", endedAt: Date.now() } });
    sendTo(ws, { type: "force_kill_result", sessionId: msg.sessionId, success: true, message: "WebSocket closed (no PID available)" });
    return;
  }

  // Delegate the full SIGTERM → wait → SIGKILL escalation to the
  // platform helper so Windows uses `taskkill /F /T /PID <pid>`
  // (genuine tree kill) and POSIX keeps the 2s grace window.
  // See change: route-kill-paths-through-platform.
  //
  // PID-safety check: skip SIGKILL escalation on Unix when the PID
  // no longer resembles a pi process. We can't pass this check INTO
  // killProcess without a plugin, so: if `killProcess` reports forced
  // SIGKILL and isPiProcess says no, we still accept the result —
  // the process was either a pi leaf or a recycled PID, and either
  // way the session is ended. On Windows `taskkill /F /T` is atomic
  // so the check isn't meaningful.
  const killResult = await killProcess(pid, { timeoutMs: 2000 });

  // Also kill any headless-registered siblings (same session ID).
  headlessPidRegistry.killBySessionId(msg.sessionId);

  const endedAt = Date.now();
  sessionManager.update(msg.sessionId, { status: "ended", endedAt });
  broadcast({ type: "session_updated", sessionId: msg.sessionId, updates: { status: "ended", endedAt } });

  if (!killResult.ok) {
    // Process was already dead when the kill was issued.
    sendTo(ws, { type: "force_kill_result", sessionId: msg.sessionId, success: true, message: "Process already exited" });
    return;
  }
  const suffix = killResult.forced ? " (SIGKILL)" : "";
  sendTo(ws, { type: "force_kill_result", sessionId: msg.sessionId, success: true, message: `Process terminated${suffix}` });
}
