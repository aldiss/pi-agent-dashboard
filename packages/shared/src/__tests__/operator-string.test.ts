/**
 * operator-string.test.ts — Phase-2 OperatorString composer + the
 * "fails-to-typecheck" acceptance assertion.
 *
 * The load-bearing acceptance (v3 §Phase-2 / ruling #3): "a renderer string
 * built outside the composer fails to typecheck." The `@ts-expect-error` lines
 * below are that assertion — if a raw `string` EVER became assignable to
 * `OperatorString` (the brand weakened), the `@ts-expect-error` would itself
 * error (unused directive) and `tsc` would FAIL. So the type guarantee is
 * enforced by the typechecker, exercised here.
 */

import { describe, expect, it } from "vitest";
import {
	composeOperatorString,
	composeStatusString,
	OperatorStringError,
	renderOperatorString,
	type OperatorString,
} from "../operator-string.js";
import { renderOperatorStatus, statusFromFacts, operatorStatusText } from "../operator-status-renderer.js";

describe("composeOperatorString — typed facts → legible operator string", () => {
	it("composes WHO + OUTCOME + WHAT-NEEDS-YOU into a legible sentence", () => {
		const s = composeOperatorString({
			who: "the postprod driver",
			outcome: "a live GitHub token is exposed",
			whatNeedsYou: "revoke the token and re-auth",
		});
		expect(renderOperatorString(s)).toContain("The postprod driver");
		expect(renderOperatorString(s)).toContain("Revoke the token");
	});

	it("keeps the provenance-ref OUT of the rendered string", () => {
		const s = composeOperatorString({
			who: "the build",
			outcome: "the signing step is blocked",
			whatNeedsYou: "install a valid certificate",
			provenanceRef: "dl-6858",
		});
		// The dl-id provenance ref must NOT leak into the operator-facing string.
		expect(renderOperatorString(s)).not.toContain("dl-6858");
	});

	it("appends the WHEN-DEFAULT-FIRES clause when present", () => {
		const s = composeOperatorString({
			who: "the experiment",
			outcome: "the A/B test is paused",
			whatNeedsYou: "pick the checkout flow",
			whenDefaultFires: "the test stays paused",
		});
		expect(renderOperatorString(s)).toContain("If you do nothing");
	});

	it("throws LOUD when the composition would carry jargon (a leaked dl-id)", () => {
		expect(() =>
			composeOperatorString({
				who: "the driver",
				outcome: "resolve dl-6858 before shipping",
				whatNeedsYou: "review the blocker",
			}),
		).toThrow(OperatorStringError);
	});

	it("throws LOUD on a leaked §-cite / themed-name / version-tag", () => {
		expect(() =>
			composeOperatorString({ who: "x", outcome: "approve per §16.1", whatNeedsYou: "sign" }),
		).toThrow(OperatorStringError);
		expect(() =>
			composeOperatorString({ who: "Dashwright", outcome: "has the steps", whatNeedsYou: "review" }),
		).toThrow(OperatorStringError);
		expect(() =>
			composeOperatorString({ who: "x", outcome: "ship the v2 build", whatNeedsYou: "deploy" }),
		).toThrow(OperatorStringError);
	});
});

describe("composeStatusString — typed StatusKind → operator-facing status (StatusBar bind)", () => {
	it("running → 'Running <tool>…'", () => {
		const s = composeStatusString({ kind: "running", tool: "the build" });
		expect(renderOperatorString(s)).toBe("Running the build…");
	});
	it("generating → 'Generating…'", () => {
		expect(renderOperatorString(composeStatusString({ kind: "generating" }))).toBe("Generating…");
	});
	it("thinking → 'Thinking…'", () => {
		expect(renderOperatorString(composeStatusString({ kind: "thinking" }))).toBe("Thinking…");
	});
	it("throws LOUD when a tool name carries jargon (never leaks to the operator)", () => {
		expect(() => composeStatusString({ kind: "running", tool: "dl-42 sync" })).toThrow(
			OperatorStringError,
		);
	});
	it("a raw string is NOT a valid StatusKind (composer-only, no raw-string hatch)", () => {
		// @ts-expect-error — composeStatusString takes a typed StatusKind, never a raw string.
		const bad = () => composeStatusString("Running…");
		expect(typeof bad).toBe("function");
	});
});

describe("renderer binds OperatorString (the #2 seam primitive)", () => {
	it("renderOperatorStatus accepts a composed OperatorString", () => {
		const s = composeOperatorString({
			who: "the report pipeline",
			outcome: "it is waiting on your review",
			whatNeedsYou: "approve the run",
		});
		const view = renderOperatorStatus(s, "event-123");
		expect(operatorStatusText(view)).toContain("The report pipeline");
		expect(view.drilldownRef).toBe("event-123");
	});

	it("statusFromFacts composes + renders in one step, ref kept off text", () => {
		const view = statusFromFacts({
			who: "the migration",
			outcome: "it stalled 12 days ago",
			whatNeedsYou: "unblock the cleanup",
			provenanceRef: "dl-9999",
		});
		expect(operatorStatusText(view)).not.toContain("dl-9999");
		expect(view.drilldownRef).toBe("dl-9999");
	});

	// ── THE ACCEPTANCE ASSERTION: a raw string fails to typecheck ──────────────
	it("a raw string is NOT assignable to a renderer expecting OperatorString", () => {
		// @ts-expect-error — a bare string cannot be passed where OperatorString is required.
		const bad = (): ReturnType<typeof renderOperatorStatus> => renderOperatorStatus("just a raw status string");
		// The call is never made (the point is the compile error above); assert the
		// guard exists at runtime by composing correctly instead.
		expect(typeof bad).toBe("function");
	});

	it("a raw string is NOT assignable to an OperatorString variable", () => {
		// @ts-expect-error — the brand blocks raw-string assignment.
		const s: OperatorString = "raw";
		expect(typeof s).toBe("string");
	});
});
