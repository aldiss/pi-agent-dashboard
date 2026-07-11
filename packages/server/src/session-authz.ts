/**
 * Central session-write authorization chokepoint.
 *
 * This is the OUTERMOST gate every session-write action routes through
 * (auth-merge contract invariant #1), covering BOTH the WS `send_prompt` seam
 * (Build 0) AND every session-write REST route (Build 1b — C-REST-CLOSURE).
 * Nothing bypasses it: a single `authorizeSessionAction` call is the last word
 * on whether a session-write proceeds.
 *
 * Build 0 established: capture + bind the `human{principal}` actor at the `/ws`
 * gate; the discriminated `SessionActor` is `service`-ready so a future
 * det-spawn producer inherits the same chokepoint.
 *
 * Build 1b adds (this file):
 *   - `action` classification (co-drive | operator-only | service-allowed) over
 *     the COMPLETE set of session-write actions (mandate 4c). The map is total:
 *     every gated action has exactly one class, so no route is unclassified.
 *   - operator-only ENFORCEMENT at the gate against the actor's identity + kind
 *     (NOS §4 — authorization, NOT a prompt-convention): an operator-only action
 *     requires `actor.kind==="human" && isOperator(principal, operatorUsers)`.
 *     A bounded co-driver (op-2) and a `service` actor are structurally refused
 *     for operator-only actions but may perform co-drive actions.
 *   - H-M2 sub-validation: a `human` actor must carry a principal with a usable
 *     `sub` (the identity the operator-only match + Build-2 attribution depend
 *     on). Refused at the gate when the flag is ON.
 *
 * Flag OFF (single-operator, default) OR operator identity unset → the gate is
 * INERT (allows unconditionally / operator-only no-ops) so single-operator
 * behavior is byte-unchanged.
 */
import type { TokenPayload } from "./auth.js";
import { hasUsableSub } from "./auth.js";
import type { OperatorSetTracker } from "./operator-set-tracker.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { CellAccessController } from "./cell-access.js";

/**
 * The authenticated actor behind a session-write, discriminated by kind.
 *
 * - `human`  — a browser operator. `principal` is the verified `TokenPayload`
 *   bound at `validateWsUpgrade` (WS) or captured from the verified JWT cookie
 *   on the REST `onRequest` hook (`null` when single-operator mode allowed the
 *   connection with no cookie). NEVER a client-claimed value — the server
 *   derives it from the connection / verified cookie, never from the message or
 *   request body.
 * - `service` — a server-side producer authenticated out of band (the
 *   shared-secret / Bearer REST path; a future det-spawn spawn-intent). A
 *   `service` actor may perform co-drive actions but structurally CANNOT
 *   satisfy an operator-only action (it is infra, not an operator).
 */
export type SessionActor =
  | { kind: "human"; principal: TokenPayload | null }
  | { kind: "service"; id: string };

/**
 * The authorization class of a session-write action (mandate 4c).
 *
 * - `co-drive`       — both op-1 and op-2 (any authenticated human) may perform
 *   it; a `service` actor may too. At minimum `send_prompt`.
 * - `operator-only`  — op-1 only (the session-control / lifecycle actions).
 *   A non-operator human (op-2) and a `service` actor are refused.
 * - `service-allowed`— reserved: an action a `service` actor may perform that is
 *   NOT plain co-drive. EMPTY in Build 1b (no such action exists yet — a
 *   service today only ever needs co-drive actions, which it already gets under
 *   `co-drive`). Declared for taxonomy completeness + so a future service-only
 *   action has a home without reclassifying. A `service-allowed` action is
 *   co-drive-class for a human (structurally cannot be operator-only). See the
 *   report's open question on the service-actor REST decision.
 */
export type SessionWriteActionClass = "co-drive" | "operator-only" | "service-allowed";

/**
 * The COMPLETE enumeration of gated session-write actions → class (mandate 4c).
 *
 * Keys are the canonical action tokens the gate is called with (one per
 * session-write REST route + the WS `send_prompt` seam). This map is the single
 * source of truth for the classification; a completeness test asserts every
 * gated route maps to a key here (no route un-gated / unclassified — Joan
 * refinement-(b): no silent operator-only gain).
 *
 * CLASSIFICATION (proposed; the architect gates it):
 *   - `send_prompt` = co-drive — co-driving IS sending prompts; the whole point
 *     of admitting op-2 is that they can drive the agent.
 *   - `abort` = co-drive (Build-1b WS-closure decision) — a bounded co-driver
 *     must be able to STOP a runaway turn for safety without waiting for op-1.
 *     `abort` is non-destructive (interrupts the current turn; does NOT end the
 *     session, kill the process, or change wiring), so co-drive is the safe +
 *     correct class. This MUST match the WS `abort` handler (both seams share
 *     this one entry — see WS_SESSION_WRITE_MESSAGE_ACTION).
 *   - EVERYTHING ELSE = operator-only — the session-control / lifecycle surface
 *     (shutdown / kill_process / force_kill / retire / resurrect / spawn /
 *     resume / rename / hide / unhide / model / thinking-level / flow-control /
 *     attach-/detach-proposal). These change the session's existence, identity,
 *     wiring, model, or process — a bounded co-driver must not silently hold
 *     them (dl-5761).
 *
 * BORDERLINE calls (Build-1b WS-closure, stated explicitly per the directive):
 *   - `abort` → co-drive (safety emergency-stop; rationale above).
 *   - `flow-control` → operator-only. It bundles `toggle_autonomous` (an
 *     operator-level autonomy-mode decision) with an `abort` sub-action; the
 *     pure safety-stop is already covered by the standalone co-drive `abort`,
 *     so the compound stays operator-only.
 *   - `resume` → operator-only. Resurrecting/forking an ENDED session is
 *     lifecycle control (creates/revives a session), not co-driving a live one.
 */
export const SESSION_WRITE_ACTION_CLASS = {
  // co-drive
  send_prompt: "co-drive",
  // co-drive — safety emergency-stop (see borderline note above). MUST match
  // the WS `abort` handler classification (one shared entry, both seams).
  abort: "co-drive",
  // co-drive/read — lists the available roles for the session; carries no
  // `presetName`, mutates NOTHING (the actual read op, PUSHBACK-1 Fix 1a). A
  // bounded co-driver may enumerate roles; it is gated (routes through the
  // chokepoint) only so it is CLASSIFIED, not left pass-through-by-default.
  request_roles: "co-drive",
  // operator-only — session control / lifecycle
  shutdown: "operator-only",
  rename: "operator-only",
  resurrect: "operator-only",
  hide: "operator-only",
  unhide: "operator-only",
  spawn: "operator-only",
  resume: "operator-only",
  "flow-control": "operator-only",
  model: "operator-only",
  "thinking-level": "operator-only",
  "attach-proposal": "operator-only",
  "detach-proposal": "operator-only",
  retire: "operator-only",
  // operator-only — process control (WS-only, no REST twin). Added in Build-1b
  // WS-closure so completeness stays mechanically total across BOTH seams.
  kill_process: "operator-only",
  force_kill: "operator-only",
  // operator-only — role/model + preset mutation (WS-only, no REST twin). Added
  // in PUSHBACK-1 Fix 1a: these were REACHABLE session-write handlers left
  // ungated (the op-2 bypass the dual-review caught). Classification follows
  // EFFECT (does it mutate operator-level state?), fail-CLOSED on uncertainty:
  //   - role_set carries a `modelId` → changes the session role/model = the
  //     SAME operator-level effect as the gated `set_model`.
  //   - flow_management run|new|edit|delete → mutates flows.
  //   - role_preset_save / role_preset_delete → mutate the saved presets.
  //   - role_preset_load forwards a `presetName` → APPLYING a named preset
  //     re-applies its saved role/model = the same operator-level effect as
  //     role_set (architect-verified own-hand). NOT co-drive.
  role_set: "operator-only",
  flow_management: "operator-only",
  role_preset_save: "operator-only",
  role_preset_delete: "operator-only",
  role_preset_load: "operator-only",
  // operator-only — process kill+respawn primitive (WS-only, no REST twin, no
  // distinct message-type: it is the `/reload` text on a headless session,
  // intercepted INSIDE `handleSendPrompt`). PUSHBACK-2 FIX-P2-4: the intercept
  // was riding the co-drive `send_prompt` verdict → op-2 could SIGTERM+respawn a
  // headless pi. `handleSendPrompt` re-authorizes this action before
  // `handleHeadlessReload`. A kill+respawn is lifecycle control, not co-driving.
  reload: "operator-only",
  // operator-only — a MUTATING `ui_management` (an advertised rowActions/actions
  // event). WS-only, no REST twin, no static message-type gate: `ui_management`
  // is ACTION-GATED (the central WS gate classifies read/mutation/forged via
  // `classifyUiManagement`; a mutation routes THIS action through the chokepoint).
  // PUSHBACK-2 FIX-P2-1: the blanket-passthrough let op-2 fire arbitrary
  // extension side-effects (judo:delete-row). A validated mutation is
  // operator-level (it mutates extension-owned state); op-2 refused.
  ui_management: "operator-only",
  // operator-only — a `send_prompt` text that is a bridge COMMAND form (NOT a
  // raw passthrough prompt). WS + REST (BOTH send_prompt seams), no distinct
  // message-type: the send_prompt handler classifies the text with the SHARED
  // `parseSendPrompt` (the ONE parser the bridge EXECUTES) and routes a
  // command-form (`!`/`!!` host-shell, `/quit`, `/exit`, `/reload`, `/new`,
  // `/model …`, `/compact`, any `/slash`) through THIS operator-only action.
  // PUSHBACK-3 FIX-P3-1: `send_prompt` is co-drive, but the bridge PARSES the
  // forwarded text into COMMANDS it executes (host shell, shutdown, kill+respawn,
  // spawn, model-switch), so a co-driver could reach the operator-only/host
  // command surface via prompt TEXT. A raw passthrough prompt stays co-drive.
  "prompt-command": "operator-only",
  // operator-only — C2 huddle control (N-2). Starting/recalling a huddle pauses
  // the agent + opens a PRIVATE co-driver exchange + gates the ended-replay
  // delivery (M-B) — a session-control effect a bounded co-driver must not hold
  // (design F4 who-starts = operator-only; the brief's operator-only huddle-start).
  // WS-only, no REST twin: deliberately ABSENT from GUEST_SESSION_HTTP_ROUTES so
  // REST defaults operator-only, and ABSENT from GUEST_SESSION_MESSAGE_TYPES so a
  // guest WS cannot send it (N-2 map #4/#5 = deliberate absences).
  "huddle-start": "operator-only",
  "huddle-recall": "operator-only",
} as const satisfies Record<string, SessionWriteActionClass>;

/** The canonical action tokens (keys of {@link SESSION_WRITE_ACTION_CLASS}). */
export type SessionWriteAction = keyof typeof SESSION_WRITE_ACTION_CLASS;

/** All gated session-write action tokens as a runtime array (for tests). */
export const SESSION_WRITE_ACTIONS = Object.keys(
  SESSION_WRITE_ACTION_CLASS,
) as SessionWriteAction[];

/**
 * WS `BrowserToServerMessage.type` → session-write action token (Build-1b
 * WS-closure; extended in PUSHBACK-1 Fix 1a). This is the WS arm of the SAME
 * single source of truth: the value is a {@link SessionWriteAction} key of
 * {@link SESSION_WRITE_ACTION_CLASS}, so the WS handler and the REST route for
 * the SAME logical action DERIVE their operator-only class from the ONE
 * enumeration. Add an operator-only action to `SESSION_WRITE_ACTION_CLASS` + a
 * row here and it is auto-gated on the WS seam (close-by-construction).
 *
 * A session-write message-type NOT listed here is handled by the FOLD-A
 * fail-CLOSED default in `ws-session-gate.ts`: when the flag is ON, an unmapped
 * type that is not in the explicit pass-allowed allowlist
 * (`ws-session-write-surface.ts`) is REFUSED — so an omission is not merely
 * coverage-test-RED, it cannot ship ungated. The derived-coverage test
 * (`build1b-ws-coverage.test.ts`) additionally parses the gateway switch and
 * asserts every reachable `sendToSession` case is classified.
 *
 * `send_prompt` is intentionally ABSENT: it keeps its own in-handler gate
 * (Build 0 `handleSendPrompt`, defense-in-depth + already red-arm-tested; it is
 * classified `self-gated` in `ws-session-write-surface.ts`), and routing it here
 * too would double-emit `send_prompt_failed`. It is co-drive, so the central
 * gate would never refuse it anyway.
 */
export const WS_SESSION_WRITE_MESSAGE_ACTION = {
  abort: "abort",
  shutdown: "shutdown",
  flow_control: "flow-control",
  kill_process: "kill_process",
  force_kill: "force_kill",
  rename_session: "rename",
  hide_session: "hide",
  unhide_session: "unhide",
  attach_proposal: "attach-proposal",
  detach_proposal: "detach-proposal",
  resume_session: "resume",
  spawn_session: "spawn",
  set_model: "model",
  set_thinking_level: "thinking-level",
  // PUSHBACK-1 Fix 1a: the found-missed reachable session-write handlers. The
  // WS message-type IS the action token (WS-only, no REST twin — same pattern
  // as kill_process/force_kill). Each derives its class from the ONE
  // SESSION_WRITE_ACTION_CLASS above, so both seams stay drift-proof.
  role_set: "role_set",
  flow_management: "flow_management",
  role_preset_save: "role_preset_save",
  role_preset_delete: "role_preset_delete",
  role_preset_load: "role_preset_load",
  request_roles: "request_roles",
  // C2 huddle control (N-2 map #2). The WS message-type IS the action token
  // (WS-only, no REST twin). Each derives its operator-only class from the ONE
  // SESSION_WRITE_ACTION_CLASS above → auto-gated on the WS seam (map #3
  // `WS_GATED_TYPES` derives from these keys) → op-2 refused, guest WS refused.
  huddle_start: "huddle-start",
  huddle_recall: "huddle-recall",
} as const satisfies Record<string, SessionWriteAction>;

/** WS message-types that carry a session-write action (keys of the registry). */
export type WsSessionWriteMessageType = keyof typeof WS_SESSION_WRITE_MESSAGE_ACTION;

/**
 * Resolve the session-write action for a WS message-type, or `undefined` when
 * the message-type is not a gated session-write.
 */
export function wsMessageAction(type: string): SessionWriteAction | undefined {
  return (WS_SESSION_WRITE_MESSAGE_ACTION as Record<string, SessionWriteAction>)[type];
}

/**
 * Resolve an action's class. Returns `undefined` for an unknown token — the
 * gate treats an unknown action as fail-CLOSED when the flag is ON (a route
 * added without an enumeration entry must not silently pass).
 */
export function actionClass(action: string): SessionWriteActionClass | undefined {
  return (SESSION_WRITE_ACTION_CLASS as Record<string, SessionWriteActionClass>)[action];
}

/**
 * Session-CREATING actions — they bring a NEW session into existence rather than
 * acting on an existing one, so they legitimately carry NO `sessionId` (there is
 * nothing to bound yet). fix-2 MINOR-3 exemption: the fail-closed-on-absent-
 * sessionId rule targets a session-SCOPED action whose id went missing (an
 * inconsistency / potential bypass); a session-creating action with no id is
 * NOT that — it is the normal shape. So admission is SKIPPED for these (the
 * per-action operator-only rule still refuses a non-operator). Today only
 * `spawn`: `POST /api/session/spawn` has no `:id`, creates a fresh session, and
 * is operator-only — op-2 must get `operator-only`, and op-1 (operator) must be
 * allowed. (`resume` is session-scoped on REST — `/api/session/:id/resume` —
 * so it is NOT exempt.)
 */
export const SESSION_CREATING_ACTIONS = new Set<string>(["spawn"]);

/**
 * True when a verified principal matches the configured operator identity
 * (mandate 4c). Matches by `sub` (email) OR `username`, case-insensitive. When
 * `operatorUsers` is unset/empty, NO principal is an operator → operator-only
 * enforcement is INERT (single-operator / flag-ON-without-an-operator is
 * byte-unchanged). The VALUES are configured at Build 1; Build 1b ships the
 * mechanism.
 *
 * Requires a usable `sub` (H-M2): a `sub`-less principal can never be an
 * operator (nothing to match, and it is refused at the gate anyway).
 */
export function isOperator(
  principal: TokenPayload | null | undefined,
  operatorUsers: string[] | undefined,
): boolean {
  if (!operatorUsers || operatorUsers.length === 0) return false;
  if (!hasUsableSub(principal)) return false;
  const sub = principal!.sub.trim().toLowerCase();
  const username =
    typeof principal!.username === "string" ? principal!.username.trim().toLowerCase() : "";
  return operatorUsers.some((u) => {
    const p = u.trim().toLowerCase();
    return p.length > 0 && (p === sub || (username.length > 0 && p === username));
  });
}

export interface AuthorizeSessionActionInput {
  actor: SessionActor;
  /** The session-scoped action being attempted (a {@link SessionWriteAction}). */
  action: string;
  /**
   * Whether the multi-operator browser-auth gate is engaged for this server.
   * Sourced from the startup-frozen `auth.requireBrowserAuth`. When false, the
   * gate no-ops (single-operator, byte-unchanged).
   */
  requireBrowserAuth: boolean;
  /**
   * The configured operator identities (`auth.operatorUsers`). When
   * unset/empty, operator-only enforcement is INERT (see {@link isOperator}).
   */
  operatorUsers?: string[];
  /**
   * The session the action targets (Stream-2 D — N=2 admission). Required
   * together with {@link operatorSet} for the bounded-cell admission check to
   * run; when either is absent, admission is SKIPPED (the gate degrades to the
   * Build-1b identity + operator-only behavior — byte-unchanged for every
   * existing caller that does not thread the cell). The two live gate arms (WS +
   * REST) BOTH thread these so a session is bounded to 2 distinct humans from the
   * ONE chokepoint, not per-arm.
   */
  sessionId?: string;
  /**
   * The shared bounded-cell tracker (Stream-2 D). The SAME instance is threaded
   * by BOTH the WS and REST arms so admission is derived from one source (a 3rd
   * distinct human cannot bypass a connection-only cap via REST). Consulted ONLY
   * for `human` actors (a `service` actor is infra, not one of the 2 humans, and
   * is never admission-counted). Absent → admission SKIPPED (see `sessionId`).
   */
  operatorSet?: OperatorSetTracker;
  /** Direct-dashboard guest→cell boundary. Absent/disabled preserves phase 1. */
  cellAccess?: CellAccessController;
  /** Server-resolved target session; never a client-supplied ownership claim. */
  session?: DashboardSession;
}

export interface AuthorizeSessionActionResult {
  allowed: boolean;
  /** Machine-readable denial reason, present only when `allowed:false`. */
  reason?:
    | "no-principal"
    | "invalid-principal"
    | "session-full"
    | "session-unavailable"
    | "operator-only"
    | "unclassified-action"
    | "ui-management-forged";
}

/**
 * The single authorization chokepoint for session-write actions.
 *
 * Rules (multi-operator mode, `requireBrowserAuth=true`):
 *   1. A `human` actor must carry a bound principal — else `no-principal`
 *      (defense-in-depth: the `/ws` upgrade + REST hook already refuse
 *      principal-less browser session-writes; this pins the invariant at the
 *      seam too).
 *   2. A `human` principal must carry a usable `sub` (H-M2) — else
 *      `invalid-principal` (a secret-signed but `sub`-less token has no exact
 *      identity to authorize / attribute).
 *   3. N=2 ADMISSION (Stream-2 D, Contract-2 / Joan pin 2 — runs BEFORE the
 *      per-action check): when `operatorSet` + `sessionId` are threaded, a
 *      `human` `sub` is admitted to the session's bounded cell iff it is already
 *      a member OR a slot is free (`< 2` distinct subs). A 3rd DISTINCT human is
 *      refused `session-full` at ADMISSION — before any per-action verdict, so a
 *      non-member never learns a per-action outcome. Two tabs of the SAME `sub`
 *      are ONE operator (Set dedup). A `service` actor is NOT admission-counted
 *      (infra, not one of the 2 humans) — it bypasses admission but still faces
 *      the per-action operator-only rule (det-spawn-inherit unbroken). Absent
 *      cell/sessionId → admission SKIPPED (byte-unchanged for non-threading
 *      callers).
 *   4. An operator-only action requires `isOperator(principal, operatorUsers)`
 *      — a non-operator human (op-2) or a `service` actor is refused with
 *      `operator-only`. When `operatorUsers` is unset/empty this rule is INERT
 *      (no principal is an operator → the check no-ops for the co-drive class,
 *      but an operator-only action then has NO operator to satisfy it, so it is
 *      refused for humans only when an operator IS configured — see below).
 *   5. An unknown action token (not in the enumeration) is refused
 *      `unclassified-action` — fail-CLOSED so a route added without an
 *      enumeration entry cannot silently pass.
 *
 * INERT-operator note (mandate 4c): when `operatorUsers` is unset, operator-only
 * enforcement no-ops — i.e. an operator-only action is ALLOWED for an
 * authenticated human. This is deliberate: with the flag ON but no operator
 * configured (Build 1b's tested posture, before op-2 is admitted) op-1 is the
 * only human with a cookie and must retain full control. Build 1 configures
 * `operatorUsers` in the SAME change that admits op-2 (dl-5761), at which point
 * op-2 (not listed) is structurally refused every operator-only action.
 *
 * Single-operator mode (`requireBrowserAuth=false`): ALLOW unconditionally —
 * byte-unchanged.
 */
export function authorizeSessionAction(
  input: AuthorizeSessionActionInput,
): AuthorizeSessionActionResult {
  const {
    actor,
    action,
    requireBrowserAuth,
    operatorUsers,
    sessionId,
    operatorSet,
    cellAccess,
    session,
  } = input;

  if (!requireBrowserAuth) {
    // Single-operator: no-op gate, byte-unchanged behavior.
    return { allowed: true };
  }

  // ── Actor identity checks (human) ──────────────────────────────────────
  if (actor.kind === "human") {
    if (actor.principal === null) {
      return { allowed: false, reason: "no-principal" };
    }
    // H-M2: a human actor must carry a real `sub`.
    if (!hasUsableSub(actor.principal)) {
      return { allowed: false, reason: "invalid-principal" };
    }
  }

  // ── STATIC GUEST→CELL BOUNDARY (before D admission/action disclosure) ──
  // Operators stay dashboard-wide. Services are autonomous infrastructure and
  // remain outside the trusted-co-driver boundary. A non-operator human must
  // target a server-resolved session in one of their configured cells. Missing
  // and outside sessions deliberately share one reason so the guest cannot use
  // the action gate as an existence oracle. Session-creating actions carry no
  // target and continue to the existing operator-only rule below.
  if (
    actor.kind === "human"
    && cellAccess?.enabled
    && !SESSION_CREATING_ACTIONS.has(action)
    && !cellAccess.canViewSession(actor.principal, session)
  ) {
    return { allowed: false, reason: "session-unavailable" };
  }

  // ── N=2 ADMISSION (Contract-2 / Joan pin 2: admission-FIRST) ────────────
  // Bound the session to 2 DISTINCT humans BEFORE any per-action check. A 3rd
  // distinct human is refused here — a non-member never reaches (nor learns the
  // verdict of) the per-action gate below. Only `human` actors with a real
  // `sub` (guaranteed by the identity checks above) are admission-counted; a
  // `service` actor is infra (not one of the 2 humans) and bypasses admission
  // — it remains bound by the per-action operator-only rule (det-spawn-inherit
  // unbroken).
  //
  // check-then-commit (fix-2 MAJOR-2): `canAdmit` is NON-mutating — it decides
  // admissibility here WITHOUT reserving a slot, so a subsequently-refused
  // action (unclassified / operator-only, below) commits NOTHING (no stranded
  // slot → no REST op-2 lockout). The commit (the ONLY admission mutation)
  // happens on the allowed path only, just before the final return.
  //
  // Admission engages when `operatorSet` is threaded (the caller opts in). With
  // NO `operatorSet` threaded → fully opt-out, SKIPPED (byte-unchanged for the
  // send-seam's in-handler gate + the unit tests). fix-2 MINOR-3: when the cell
  // IS threaded for a `human` but `sessionId` is ABSENT, fail-CLOSED (refuse) for
  // a session-SCOPED action — a caller that threads the cell is opting into
  // admission, so a missing sessionId is an inconsistency. EXCEPT a session-
  // CREATING action (`spawn`, SESSION_CREATING_ACTIONS): it has no sessionId by
  // nature (it makes a NEW session), so it is exempt — admission is skipped and
  // the per-action operator-only rule still applies (Bastion-gated, fix-2).
  let needsCommit = false;
  // The human `sub` to commit on the allowed path, captured INSIDE the
  // `actor.kind === "human"` narrowing so the commit below needs no re-narrow
  // (and never touches a `service` actor's shape). Empty when admission is not
  // engaged / the actor is not an admission-counted human.
  let commitSub = "";
  if (actor.kind === "human" && operatorSet) {
    if (!sessionId) {
      // MINOR-3: admission engaged but no session to bound. A session-SCOPED
      // action whose sessionId went missing is an inconsistency → fail-closed.
      // A session-CREATING action (`spawn`) legitimately has no sessionId (it
      // makes a NEW session) → NOT an inconsistency → SKIP admission and fall
      // through to the per-action operator-only rule (op-2 refused operator-only,
      // op-1 operator allowed). See SESSION_CREATING_ACTIONS.
      if (!SESSION_CREATING_ACTIONS.has(action)) {
        return { allowed: false, reason: "session-full" };
      }
    } else {
      const verdict = operatorSet.canAdmit(sessionId, actor.principal!.sub);
      if (!verdict.admissible) {
        return { allowed: false, reason: "session-full" };
      }
      // A NEW distinct sub that passed the check — commit it ONLY if the action
      // is ultimately allowed (below). `member` is used ONLY here (commit-vs-
      // skip), NEVER as an authorization ALLOW input (membership ≠ permission).
      needsCommit = !verdict.member;
      commitSub = actor.principal!.sub;
    }
  }

  // ── Action classification (fail-closed on unknown) ─────────────────────
  const cls = actionClass(action);
  if (cls === undefined) {
    return { allowed: false, reason: "unclassified-action" };
  }

  // ── Operator-only enforcement ──────────────────────────────────────────
  if (cls === "operator-only") {
    // A service actor can NEVER satisfy operator-only (infra, not operator).
    if (actor.kind === "service") {
      return { allowed: false, reason: "operator-only" };
    }
    // A human satisfies operator-only ONLY when they match the configured
    // operator identity. When operatorUsers is unset/empty, enforcement is
    // INERT (allow) — see the INERT-operator note above.
    const operatorConfigured = !!operatorUsers && operatorUsers.length > 0;
    if (operatorConfigured && !isOperator(actor.principal, operatorUsers)) {
      return { allowed: false, reason: "operator-only" };
    }
  }

  // ── Commit the admission slot (allowed path ONLY — check-then-commit) ────
  // Every refusal above returned BEFORE here, so a refused action strands no
  // slot. This is the ONLY place the cell is mutated for admission. `commitSub`
  // is non-empty only when a human passed the non-mutating `canAdmit` above.
  if (needsCommit && operatorSet && sessionId) {
    operatorSet.commit(sessionId, commitSub);
  }

  // co-drive / service-allowed, or operator-only satisfied → allowed.
  return { allowed: true };
}
