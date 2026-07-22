/**
 * audience-golden-corpus.test.ts — the AUTHORITATIVE anti-drift table (build-item-3).
 *
 * This is the GOLDEN CORPUS the Dashwright dashboard-server reconciles its VENDORED
 * copy of `audience-core` against. It drives the PURE `deriveAudienceFromEnv` over
 * the FINITE input space and pins the expected audience for every cell, so any
 * drift (in either the extension's core or Dashwright's vendored copy) is caught.
 *
 * FINITE SPACE:
 *   name-class {unset, standing, registered-non-standing, named-miss}
 *     × hasUI {true, false}
 *     × load.status {complete, partial, stale, unreadable}
 *   + the two edges Dashwright pinned:
 *       unnamed + MISSING source  (source undefined → hasUI=false → unknown)
 *       unnamed + {tui, terminal, zed} (interactive source → hasUI=true → operator)
 *
 * DECISION RULE (own-hand, session-level constant; `role` NOT consulted):
 *   standing (exact themed_name @ standing tier)      → operator
 *                                                        [BUT: an `unreadable` load
 *                                                        has an EMPTY identity, so the
 *                                                        standing name cannot be
 *                                                        PROVEN → unknown. Standing→
 *                                                        operator needs a readable
 *                                                        identity (complete/partial/stale).]
 *   registered-non-standing AND status==="complete"   → agent
 *   unset + hasUI=true (interactive TTY)              → operator
 *   everything else (named-miss / partial / stale /
 *     unreadable / unset+headless)                    → unknown  (fail-open shown+exempt)
 */

import { describe, it, expect } from "vitest";
import {
	deriveAudienceFromEnv,
	hasUiFromSource,
	classifyLoad,
	type Audience,
	type RegistryLoadResult,
	type RegistrySnapshot,
} from "../audience-core.js";

// A FIXED clock so every load-status fixture is deterministic (no Date.now()).
const NOW = Date.parse("2026-07-19T15:00:00Z");
const FRESH = "2026-07-19T14:55:00Z"; // 5 min old — inside the 30-min window
const OLD = "2026-07-19T10:00:00Z"; // 5 h old — outside the window

// Registry role fixtures: Joan = standing incumbent; Commwright-2 = live non-standing.
const ROLES = {
	joan: { themed_name: "Joan", tier: "L0.5b" },
	commwright: { tmux_session: "Commwright-2" },
};

// One parsed-registry fixture per load.status (verified by b1-registry-completeness).
const COMPLETE: RegistrySnapshot = { schema_version: "1.0", updated_at: FRESH, roles: ROLES };
const PARTIAL = { updated_at: FRESH, roles: ROLES }; // no schema_version → partial
const STALE = { schema_version: "1.0", updated_at: OLD, roles: ROLES }; // currency outside window
const UNREADABLE = null; // null → unreadable (empty identity)

function loadFor(status: "complete" | "partial" | "stale" | "unreadable"): RegistryLoadResult {
	const parsed = status === "complete" ? COMPLETE : status === "partial" ? PARTIAL : status === "stale" ? STALE : UNREADABLE;
	const r = classifyLoad(parsed, NOW);
	// Guard: the fixture actually produces the intended status (fixtures can't drift silently).
	expect(r.status).toBe(status);
	return r;
}

// The four name-classes, as the PI_AGENT_NAME env value.
const NAME: Record<string, Record<string, string | undefined>> = {
	unset: {}, // no PI_AGENT_NAME
	standing: { PI_AGENT_NAME: "Joan" }, // exact standing incumbent
	"registered-non-standing": { PI_AGENT_NAME: "Commwright-2" }, // live transient member
	"named-miss": { PI_AGENT_NAME: "subagent-worker-3f4a1b" }, // not a registry member
};

type Status = "complete" | "partial" | "stale" | "unreadable";
const STATUSES: Status[] = ["complete", "partial", "stale", "unreadable"];

/**
 * THE GOLDEN TABLE. For each (name-class, hasUI, status) the expected audience.
 * Read the rule off it:
 *   - standing → operator when the load is READABLE (complete/partial/stale — the
 *     identity is populated, so the standing name is provable). An `unreadable` load
 *     has an EMPTY identity → the standing name can't be proven → unknown (fail-open).
 *   - registered-non-standing → agent ONLY at status=complete; else unknown.
 *   - unset → operator iff hasUI; else unknown (never depends on the registry).
 *   - named-miss → unknown ALWAYS (no positive membership anywhere).
 */
const GOLDEN: Array<{ nameClass: string; hasUI: boolean; status: Status; expected: Audience }> = [];
for (const nameClass of Object.keys(NAME)) {
	for (const hasUI of [true, false]) {
		for (const status of STATUSES) {
			let expected: Audience;
			if (nameClass === "standing") {
				// operator when the identity is readable (contains the standing set);
				// an unreadable load has an empty identity → cannot prove → unknown.
				expected = status === "unreadable" ? "unknown" : "operator";
			} else if (nameClass === "registered-non-standing") {
				expected = status === "complete" ? "agent" : "unknown";
			} else if (nameClass === "unset") {
				expected = hasUI ? "operator" : "unknown";
			} else {
				expected = "unknown"; // named-miss
			}
			GOLDEN.push({ nameClass, hasUI, status, expected });
		}
	}
}

describe("audience golden corpus — deriveAudienceFromEnv over the finite space (anti-drift)", () => {
	for (const row of GOLDEN) {
		it(`${row.nameClass} × hasUI=${row.hasUI} × ${row.status} → ${row.expected}`, () => {
			const env = NAME[row.nameClass]!;
			const load = loadFor(row.status);
			expect(deriveAudienceFromEnv(env, row.hasUI, load)).toBe(row.expected);
		});
	}

	it("covers the full finite space (4 name-classes × 2 hasUI × 4 statuses = 32 cells)", () => {
		expect(GOLDEN.length).toBe(32);
	});
});

describe("audience golden corpus — the two Dashwright-pinned edges (source → hasUI)", () => {
	// The dashboard-server derives hasUI from SessionMeta.source; the extension reads
	// pi's ctx.hasUI directly. `hasUiFromSource` is the ONE mapping both use.
	it("unnamed + MISSING source → hasUI=false → unknown (fail-open shown+exempt)", () => {
		const hasUI = hasUiFromSource(undefined);
		expect(hasUI).toBe(false);
		// The registry is irrelevant for an unnamed session; use any load.
		expect(deriveAudienceFromEnv({}, hasUI, loadFor("complete"))).toBe("unknown");
		expect(deriveAudienceFromEnv({}, hasUI, loadFor("unreadable"))).toBe("unknown");
	});

	for (const source of ["tui", "terminal", "zed"]) {
		it(`unnamed + ${source} → hasUI=true → operator (interactive pane)`, () => {
			const hasUI = hasUiFromSource(source);
			expect(hasUI).toBe(true);
			expect(deriveAudienceFromEnv({}, hasUI, loadFor("complete"))).toBe("operator");
			// The registry cannot change an unnamed interactive session's operator verdict.
			expect(deriveAudienceFromEnv({}, hasUI, loadFor("unreadable"))).toBe("operator");
		});
	}

	it("an UNKNOWN source (not tui/terminal/zed) → hasUI=false → unknown", () => {
		expect(hasUiFromSource("cron")).toBe(false);
		expect(deriveAudienceFromEnv({}, hasUiFromSource("cron"), loadFor("complete"))).toBe("unknown");
	});
});

describe("audience golden corpus — role is NOT consulted (session-level constant)", () => {
	it("the same session yields the same audience for user AND assistant rows", () => {
		// deriveAudienceFromEnv takes no role; the audience is a property of the
		// session interlocutor. This pins that invariant for the vendored copy.
		const load = loadFor("complete");
		const agentAudience = deriveAudienceFromEnv({ PI_AGENT_NAME: "Commwright-2" }, true, load);
		expect(agentAudience).toBe("agent"); // identical regardless of any row's role
	});
});
