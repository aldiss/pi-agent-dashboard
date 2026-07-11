/**
 * Huddle — shared domain vocabulary (multi-operator, Surface A extension).
 *
 * A HUDDLE is a bounded span during which the two admitted co-drivers of a
 * session (`operatorSet.operatorsOf(sessionId)`, N=2) confer PRIVATELY while the
 * agent is PAUSED, then hand the conferred conclusion back to the agent as a
 * single server-composed catch-up turn. This module holds ONLY the shared types
 * that cross the extension↔server↔client boundary; the ledger + state machine
 * live server/extension-side.
 *
 * Design: `_design/huddle-design-v2.1-2026-07-11.md` @ 9e3600a7 (C1–C5 spine +
 * M/N fixes) + `_design/huddle-design-v2.1.1-2026-07-11.md` @ 4c43388a (the
 * text-only-first-pilot image fold). Built to the FROZEN design.
 */
import type { ImageContent, MessageAuthor } from "./types.js";

/**
 * The C3 pause phase for a session. Serialized, bridge-ACKed CAS transitions:
 *   idle → arming → active → recalling → idle
 * - `idle`      — no huddle; turns flow to the agent normally.
 * - `arming`    — start requested; server proposed, awaiting the bridge ACK
 *                 (+ any outstanding ask-user drain/hold, M-C).
 * - `active`    — huddle live; human turns are HELD from the agent + broadcast
 *                 privately to `operatorsOf` only (C1 split + C5 quarantine).
 * - `recalling` — recall requested; composing the C4 catch-up + draining the
 *                 held span; awaiting the bridge ACK before returning to idle.
 */
export type HuddlePhase = "idle" | "arming" | "active" | "recalling";

/** A huddle participant's authorization role, server-RESOLVED (never body-claimed). */
export type HuddleRole = "operator" | "guest";

/**
 * The ingress a held turn arrived through — server-RESOLVED, stamped into the
 * C4 per-turn frame's `origin=` attribute. `tui` appears only if the M-E fence
 * is downgraded to the honest-fallback (a local-TUI turn that bypassed the
 * server); with the primary mechanical fence, TUI input never reaches the
 * ledger during a huddle.
 */
export type HuddleOrigin = "ws" | "rest" | "resume" | "tui";

/**
 * The command-form verdict recorded ALONGSIDE a turn (M-A). Only gate-PASSED
 * turns ever reach the ledger — a refused command-form returns upstream
 * (`session-action-handler.ts:347`) and never records. So the ledger carries no
 * "refused" variant by construction.
 * - `raw`            — a plain co-drive prompt (passthrough).
 * - `prompt-command` — an operator-only command form (`!`/`!!`/`/slash`) that
 *                      PASSED the operator-only re-authorization (`:322-347`).
 */
export type HuddleGateResult = "raw" | "prompt-command";

/**
 * What kind of held human input a ledger entry models. The C1 hold set covers
 * BOTH (M-C) — not only fresh human turns but also a co-driver's `prompt_response`
 * answering an outstanding ask-user, which would otherwise un-block the agent
 * mid-huddle.
 */
export type HuddleTurnKind = "human_turn" | "prompt_response";

/**
 * The input to the C1 ledger's `record`. Everything here is SERVER-RESOLVED at
 * the capture point (`deriveAuthor` seam, downstream of the command-form
 * verdict) — never read from the client message body (anti-spoof, Contract-3).
 * `seq` + `recordedAt` are assigned BY the ledger (record-time authority), so
 * they are absent here.
 */
export interface HuddleTurnInput {
  sessionId: string;
  /** The C3 huddle epoch this turn belongs to (bumped each huddle-start). */
  epoch: number;
  kind: HuddleTurnKind;
  /** Server-derived author (`deriveAuthor(ctx.principal)`) — never body-claimed. */
  author: MessageAuthor;
  /** Server-resolved role for the C4 frame `role=` attribute. */
  role: HuddleRole;
  /** Server-resolved ingress for the C4 frame `origin=` attribute. */
  origin: HuddleOrigin;
  /** The command-form verdict (M-A) — gate-passed turns only. */
  gateResult: HuddleGateResult;
  /** The RAW human text (unwrapped; C4 sanitizes + frames it at compose time). */
  text: string;
  /**
   * Any images on the turn. Policy B: images ARE allowed in the private human
   * exchange (broadcast to the audience), but their PRESENCE fails the C4 agent
   * catch-up LOUD until an operator records a text conclusion — never
   * silent-omit, never mis-attribute (v2.1.1).
   */
  images?: ImageContent[];
  /** For `prompt_response` turns: the ask-user prompt id being answered (M-C). */
  promptId?: string;
  /** For `prompt_response` turns: whether the co-driver cancelled the ask-user. */
  cancelled?: boolean;
}

/**
 * A recorded huddle turn. Immutable once appended. `seq` is monotonic per
 * (sessionId, epoch); `recordedAt` is the SERVER record-time stamp (never
 * human-supplied) that C4 renders into the frame — the C1 ledger is the
 * authority for both.
 */
export interface HuddleTurn extends HuddleTurnInput {
  /** Monotonic per (sessionId, epoch), assigned at record time. */
  seq: number;
  /** Server record-time epoch-millis stamp (authoritative; never body-supplied). */
  recordedAt: number;
}

/**
 * Architect-set FAIL-LOUD caps on a single catch-up span (design §6 M6 open
 * decision, resolved here as fixed fail-loud bounds — the brief's "architect-set
 * fail-loud caps"). Exceeding either does NOT silently truncate (that would let
 * the agent claim "whole exchange read" on a partial span — the exact provenance
 * failure v2.1.1 forbids); the C4 composer FAILS LOUD and the operators must
 * split/conclude the huddle explicitly.
 */
export const HUDDLE_CATCHUP_MAX_TURNS = 200;
/** Fail-loud byte cap on the composed catch-up text (pre-frame raw-text sum). */
export const HUDDLE_CATCHUP_MAX_BYTES = 256 * 1024;
