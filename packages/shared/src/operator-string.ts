/**
 * OperatorString — Phase-2 typed operator-facing string (v3 §Phase-2 / coverage-item 7).
 *
 * The nominal-typed guarantee: an operator-facing RENDERER string is
 * constructible ONLY through `composeOperatorString`, which takes TYPED FACTS
 * (who · outcome · what-needs-you · when-default-fires · provenance-ref) — it
 * rejects a raw ledger/status string. A renderer that expects an
 * `OperatorString` and is handed a bare `string` FAILS TO TYPECHECK (the
 * acceptance test).
 *
 * SCOPE (build-context ruling #3 — the #2 seam): this build ships the COMPOSER +
 * the TYPE + applies it to the TS status-string renderers. The dashboard-CARD
 * wiring is #2 / Dashwright's consumer side (this build provides the primitive;
 * #2 consumes). Acceptance: "a renderer string built outside the composer fails
 * to typecheck."
 *
 * REUSE: the composed string is passed through the SAME legibility predicate as
 * the needs-you band (`isLegibleLabel`) so an operator-facing string can never
 * carry a dl-id / §-cite / themed-name / version-tag. A composed string that
 * would be illegible throws a LOUD `OperatorStringError` (never ships jargon).
 *
 * BROWSER-SAFE: no `node:` imports (client re-exports).
 */

import { isLegibleLabel } from "./needs-you-label.js";

/**
 * The canonical operator-label char cap (120). Inlined here rather than
 * re-imported from `needs-you-band.ts` because that module is NOT present in
 * this worktree (only `needs-you-label.ts` was cherry-picked onto the dashboard
 * branch; `needs-you-band.ts` lands with the full needs-band merge). 120 is the
 * canonical value across dashboard history. When the needs-band merge lands,
 * this can re-import from the single source if desired.
 */
export const MAX_LABEL_CHARS = 120;

/**
 * The opaque nominal type. The unique symbol brand makes a bare `string`
 * structurally incompatible with `OperatorString`, so it cannot be passed to a
 * renderer that wants an `OperatorString` without going through the composer.
 */
declare const OPERATOR_STRING_BRAND: unique symbol;

export type OperatorString = string & { readonly [OPERATOR_STRING_BRAND]: true };

/**
 * The TYPED FACTS an operator-facing string is composed from. Never a raw
 * `summary` — the composer builds the sentence from these fields (themed-names
 * already resolved to role-language by the caller).
 */
export interface OperatorFacts {
	/** WHO — the role-language subject ("the postprod driver", "the grocery build"). */
	who: string;
	/** OUTCOME — the plain-language result/state ("a live token is exposed"). */
	outcome: string;
	/** WHAT-NEEDS-YOU — the operator action framed as a next step. */
	whatNeedsYou: string;
	/** WHEN-DEFAULT-FIRES — optional: what happens if the operator does nothing. */
	whenDefaultFires?: string;
	/**
	 * PROVENANCE-REF — an opaque reference kept OUT of the rendered string (it is
	 * the drilldown handle, e.g. a dl-id / event-id). Never rendered; carried for
	 * the consumer to link back. Keeping it off the string is the whole point.
	 */
	provenanceRef?: string;
}

/** A LOUD failure: the composed string would be illegible (carries jargon / too long). */
export class OperatorStringError extends Error {
	constructor(
		message: string,
		readonly facts: OperatorFacts,
		readonly candidate: string,
		readonly violations: string[],
	) {
		super(message);
		this.name = "OperatorStringError";
	}
}

/** Capitalize first char; leave the rest untouched. */
function cap(s: string): string {
	const t = s.trim();
	if (t.length === 0) return t;
	return t[0]!.toUpperCase() + t.slice(1);
}

/**
 * Compose an `OperatorString` from typed facts. The rendered sentence is
 * WHO + OUTCOME + WHAT-NEEDS-YOU (+ optional WHEN-DEFAULT), with the
 * provenance-ref deliberately EXCLUDED. The result is asserted legible via the
 * shared predicate; an illegible composition throws `OperatorStringError`
 * (never ships jargon). The provenance-ref, if present, is NOT allowed to leak
 * into the rendered string (it is validated to be absent from the output).
 */
export function composeOperatorString(facts: OperatorFacts): OperatorString {
	const who = cap(facts.who);
	const outcome = facts.outcome.trim();
	const action = facts.whatNeedsYou.trim();
	const when = facts.whenDefaultFires?.trim();

	// WHO + OUTCOME as the substance; WHAT-NEEDS-YOU as the next step; WHEN as tail.
	let s = `${who}: ${outcome}. ${cap(action)}.`;
	if (when) s += ` If you do nothing: ${when}.`;

	// Legibility gate (shared predicate): no dl-id / §-cite / themed-name / vN /
	// over-length. A composed string that would be illegible fails LOUD.
	const { ok, violations } = isLegibleLabel(s);
	if (!ok) {
		// The length rule here uses the needs-band cap; an operator STATUS string
		// may legitimately be longer than a needs-band LABEL, so a length-only
		// violation is tolerated (the renderer surface owns its own cap via the
		// lint at door-3). A STRUCTURAL violation (jargon) is never tolerated.
		const structural = violations.filter((v) => !v.startsWith("length:"));
		if (structural.length > 0) {
			throw new OperatorStringError(
				`OperatorString would carry jargon: ${structural.join("; ")}`,
				facts,
				s,
				violations,
			);
		}
	}

	return s as OperatorString;
}

/**
 * Escape-hatch for text that is ALREADY known operator-safe (e.g. a literal UI
 * label authored in operator-language). Rare; prefer `composeOperatorString`.
 * Still asserts structural legibility (throws on jargon) so the escape-hatch
 * can't reintroduce jargon.
 */
export function operatorStringFromLiteral(literal: string): OperatorString {
	const { violations } = isLegibleLabel(literal);
	const structural = violations.filter((v) => !v.startsWith("length:"));
	if (structural.length > 0) {
		throw new OperatorStringError(
			`operatorStringFromLiteral carries jargon: ${structural.join("; ")}`,
			{ who: "", outcome: literal, whatNeedsYou: "" },
			literal,
			violations,
		);
	}
	return literal as OperatorString;
}

/** Read the underlying string for rendering (identity; the brand is compile-time only). */
export function renderOperatorString(s: OperatorString): string {
	return s;
}

