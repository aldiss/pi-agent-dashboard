/**
 * operator-status-renderer — a TS status-string renderer surface bound to
 * `OperatorString` (Phase-2 acceptance: "a renderer string built outside the
 * composer fails to typecheck").
 *
 * This is the primitive-provider side of the #2 seam (ruling #3): the renderer
 * ACCEPTS ONLY `OperatorString`, so a call site handing it a raw ledger/status
 * string is a COMPILE ERROR. The dashboard-CARD wiring that feeds real events
 * through `composeOperatorString` into this renderer is #2 / Dashwright's
 * consumer side.
 *
 * BROWSER-SAFE.
 */

import {
	composeOperatorString,
	type OperatorFacts,
	type OperatorString,
	renderOperatorString,
} from "./operator-string.js";

/** A rendered operator status row (what a card/status-line consumes). */
export interface OperatorStatusView {
	/** The operator-facing text — TYPED, so it cannot be a raw string. */
	text: OperatorString;
	/** Optional opaque drilldown handle (provenance-ref), kept OFF `text`. */
	drilldownRef?: string;
}

/**
 * Render an operator status view. The `text` parameter is `OperatorString` —
 * NOT `string` — so every call site MUST route through a composer
 * (`composeOperatorString` for typed facts, or `composeStatusString` for typed
 * status kinds). Handing a bare `string` fails to typecheck.
 */
export function renderOperatorStatus(text: OperatorString, drilldownRef?: string): OperatorStatusView {
	return { text, drilldownRef };
}

/**
 * Convenience: compose + render in one step from typed facts. The provenance
 * ref is carried as the drilldown handle (kept off the rendered text).
 */
export function statusFromFacts(facts: OperatorFacts): OperatorStatusView {
	const text = composeOperatorString(facts);
	return { text, drilldownRef: facts.provenanceRef };
}

/** Extract the plain string for a DOM/text sink at the last mile. */
export function operatorStatusText(view: OperatorStatusView): string {
	return renderOperatorString(view.text);
}
