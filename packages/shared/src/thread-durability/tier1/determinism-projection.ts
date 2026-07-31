/**
 * Determinism-model wire contract — the FROZEN output of the NOS `project()`
 * fold (dl-13423 / dl-13481). ThreadsView and this determinism-model are "two
 * halves of one thing": the thread shows how work is being done; this projection
 * supplies each work-item's `stage` plus a deterministic-vs-judgment overlay of
 * where it can go next and WHO or WHAT authorizes each move.
 *
 * Statewright owns the fold that PRODUCES these projections; this module only
 * declares their SHAPE (shared by the fixture loader, the server route, and the
 * client overlay). It confers no authority and drives nothing — it is the
 * type-level mirror of one committed `project(thread_id)` result.
 *
 * This is a SHAPE contract, not a value snapshot: the live `stage`/`pending` of
 * any real thread WILL diverge over time and that divergence is CORRECT. Bind to
 * these fields, never to a particular thread's momentary stage.
 */

/**
 * The lifecycle stage of a work-item, as the fold currently reads it. `null` is
 * the honest "not mapped" value (paired with `degrade:"unmapped"`) — the thread
 * is real but the machine has no stage for it yet; it is NOT an error.
 */
export type DeterminismStage = string | null;

/**
 * How a pending transition is authorized — the load-bearing distinction this
 * overlay exists to make legible:
 *   • `deterministic` — the machine takes the edge on its own when a `via_event`
 *     fires; a `gate` (the enforcement mechanism, from `enforced_by`) constrains
 *     it. Rendered solid/green.
 *   • `judgment` — a human/agent authority decides; `who` (the decision
 *     authority, from `escalate_to`) owns the call. Rendered dashed/amber.
 */
export type TransitionKind = "deterministic" | "judgment";

/**
 * A deterministic pending edge: the machine advances itself on `via_event`,
 * bounded by `gate`. `gate` is the ENFORCEMENT MECHANISM (from `enforced_by`) —
 * e.g. a TS gate or a QA+done-gate pair — NOT a process actor.
 */
export interface DeterministicPending {
  to: string;
  kind: "deterministic";
  via_event: string;
  gate: string;
}

/**
 * A judgment pending edge: a decision-authority chooses to take it. `who` is the
 * DECISION AUTHORITY (from `escalate_to`) — the party authorized to make the
 * call — NOT the process actor that happens to execute it.
 *
 * Review note (carry into any live-wiring decision): if a judgment transition
 * such as `sweep-reap` ever becomes AUTONOMOUS without operator authorization,
 * it must flip to `kind:"deterministic"` + `gate` semantics — an autonomous move
 * is enforced, not judged.
 */
export interface JudgmentPending {
  to: string;
  kind: "judgment";
  via_event: string;
  who: string;
}

/** One pending transition out of the current stage (a discriminated union). */
export type PendingTransition = DeterministicPending | JudgmentPending;

/**
 * A degrade posture on the projection:
 *   • `"unmapped"` — the thread is not in the machine yet (`stage:null`); render
 *     an honest "not mapped / unknown", never an error.
 *   • `"spine-only"` — a partial fold: only the spine event-types are mapped
 *     (the §16 canon-touch has not added the absent event-types yet); the stage
 *     + pending are real but incomplete — render a "partial fold" badge.
 *   • `null` — a complete fold, no degrade.
 */
export type DegradeKind = "unmapped" | "spine-only" | null;

/**
 * The projection of ONE thread through the determinism model — the frozen wire
 * contract `project(thread_id) →`. The five load-bearing fields
 * (`thread_id`, `machine`, `stage`, `pending`, `degrade`) are always present;
 * `stage_meaning` is an optional human gloss on the stage.
 */
export interface DeterminismProjection {
  thread_id: string;
  machine: string;
  stage: DeterminismStage;
  stage_meaning?: string;
  pending: PendingTransition[];
  degrade: DegradeKind;
}

/** The machine every fixture sample folds through (cell-lifecycle spine). */
export const CELL_LIFECYCLE_MACHINE = "cell-lifecycle";

/**
 * The honest projection for a thread the machine does not map: `stage:null`,
 * no pending edges, `degrade:"unmapped"`. This is the graceful-degrade the
 * fetcher returns for an unknown `thread_id` — never a throw, never a
 * fabricated stage. `machine` defaults to the cell-lifecycle spine so the
 * overlay still names the model it would fold through.
 */
export function unmappedProjection(
  threadId: string,
  machine: string = CELL_LIFECYCLE_MACHINE,
): DeterminismProjection {
  return { thread_id: threadId, machine, stage: null, pending: [], degrade: "unmapped" };
}

/**
 * The stable identity of a pending edge — the FULL transition tuple
 * (`kind : via_event → to`), keyed on `via_event`, NEVER on `to` alone.
 *
 * This is a load-bearing render invariant. The fixture's `peggy+attention-app`
 * has two distinct edges that both target `to:"reaped"` — `operator-reap` and
 * `sweep-reap` — which are genuinely different transitions (a human reap vs. a
 * sweep reap). De-duping on `to` would silently collapse them into one edge and
 * hide a whole authorization path. Keying on the tuple keeps both visible.
 */
export function pendingKey(p: PendingTransition): string {
  return `${p.kind}:${p.via_event}->${p.to}`;
}

/** Type guard: a deterministic (machine-advanced, gated) pending edge. */
export function isDeterministic(p: PendingTransition): p is DeterministicPending {
  return p.kind === "deterministic";
}

/** Type guard: a judgment (authority-decided) pending edge. */
export function isJudgment(p: PendingTransition): p is JudgmentPending {
  return p.kind === "judgment";
}
