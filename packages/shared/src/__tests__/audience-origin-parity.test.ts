/**
 * audience-origin-parity.test.ts — drift-guard for the vendored audience producer.
 *
 * The vendored `audience-origin.vendored.ts` reconstructs the extension's REAL
 * audience-origin producer (SYNC SOURCE pinned in its header) so the F4 real-seam
 * corpus can derive the stamp in-tree. This test asserts the vendored copy's
 * derivation matches the extension's documented contract for every corpus case —
 * so a drift between the two is caught here (re-vendor on failure).
 */

import { describe, expect, it } from "vitest";
import {
	deriveAudienceFromEnv,
	deriveSessionCtx,
	isStandingCrewName,
} from "../audience-origin.vendored.js";

describe("vendored audience producer — parity with the extension contract", () => {
	it("a known worker → agent (the FATAL fixture)", () => {
		expect(deriveAudienceFromEnv({ PI_AGENT_NAME: "subagent-worker-3f4a1b" })).toBe("agent");
	});
	it("a themed driver (Commwright) → agent", () => {
		expect(deriveAudienceFromEnv({ PI_AGENT_NAME: "Commwright" })).toBe("agent");
	});
	it("a bare-named dispatched spawn → agent", () => {
		expect(deriveAudienceFromEnv({ PI_AGENT_NAME: "someRandomSpawn" })).toBe("agent");
	});
	it("every standing-crew name → operator", () => {
		for (const n of ["Bert", "Joan", "Peggy", "Lane", "Pete", "Faye", "Don", "Alice", "Harry"]) {
			expect(deriveAudienceFromEnv({ PI_AGENT_NAME: n }), n).toBe("operator");
			expect(isStandingCrewName(n), n).toBe(true);
		}
	});
	it("operator's own pane (no name, interactive) → operator", () => {
		expect(deriveAudienceFromEnv({}, /* hasUI */ true)).toBe("operator");
	});
	it("headless with no name → agent (fail-safe)", () => {
		expect(deriveAudienceFromEnv({}, /* hasUI */ false)).toBe("agent");
	});
	it("deriveSessionCtx sets origin + isStandingCrew consistently", () => {
		expect(deriveSessionCtx({ PI_AGENT_NAME: "Joan" })).toMatchObject({
			origin: "operator-chat-pane",
			isStandingCrew: true,
		});
		expect(deriveSessionCtx({ PI_AGENT_NAME: "subagent-worker-x" })).toMatchObject({
			origin: "mesh-dispatched",
			isStandingCrew: false,
		});
	});
});
