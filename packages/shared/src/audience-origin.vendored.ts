/**
 * VENDORED — the operator-voice audience-origin producer (SDK-free, pure).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SYNC SOURCE: pi-config extension pi-operator-voice                        │
 * │   path:  pi-extensions/pi-operator-voice/src/audience.ts                  │
 * │   fns:   deriveSessionCtx / deriveAudienceFromEnv / classifyAudience…     │
 * │   why:   the dashboard's tsc project has `rootDir: src`, so a cross-      │
 * │          worktree import of the extension's audience.ts is a TS6059. This │
 * │          vendored copy lets the F4 real-seam corpus DERIVE the stamp from │
 * │          the REAL producer logic (not inject it) while staying in-tree.   │
 * │   parity: `packages/shared/src/__tests__/audience-origin-parity.test.ts`  │
 * │          asserts this copy's derivation matches the documented contract   │
 * │          (worker→agent, standing-crew→operator, driver→agent, operator    │
 * │          pane→operator, headless-no-name→agent). Re-vendor on drift.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The AUTHORITATIVE producer is the extension (it stamps the envelope at emit);
 * this vendored copy is used ONLY by the dashboard's F4 corpus to reconstruct
 * the producer's derivation in a single in-tree test. It carries NO business
 * logic the dashboard relies on at runtime (the dashboard reads the stamp).
 *
 * BROWSER-SAFE: no `node:` imports.
 */

export type Audience = "operator" | "agent";

export type SessionOrigin = "operator-chat-pane" | "mesh-dispatched" | "unknown";

export interface SessionCtx {
	origin: SessionOrigin;
	canonicalName?: string | undefined;
	isStandingCrew?: boolean;
}

export interface AudienceEnvLike {
	PI_AGENT_NAME?: string | undefined;
	[k: string]: string | undefined;
}

/** All nine standing-crew names, anchored, optional `-N` suffix (canonical-9). */
const STANDING_CREW_NAME_RE = /^(Bert|Joan|Peggy|Lane|Pete|Faye|Don|Alice|Harry)(-|$)/i;

export function isStandingCrewName(name: string | undefined): boolean {
	if (!name) return false;
	return STANDING_CREW_NAME_RE.test(name);
}

/**
 * Derive the session context from the REAL signal (`PI_AGENT_NAME` presence).
 * name unset + interactive → operator pane; name unset + headless → mesh
 * (fail-safe); named standing-crew → operator; any other named → dispatched agent.
 */
export function deriveSessionCtx(env: AudienceEnvLike, hasUI = true): SessionCtx {
	const name = env.PI_AGENT_NAME?.trim();
	if (!name) {
		return hasUI
			? { origin: "operator-chat-pane", isStandingCrew: false }
			: { origin: "mesh-dispatched", isStandingCrew: false };
	}
	if (isStandingCrewName(name)) {
		return { origin: "operator-chat-pane", canonicalName: name, isStandingCrew: true };
	}
	return { origin: "mesh-dispatched", canonicalName: name, isStandingCrew: false };
}

export function classifyAudienceRetrospective(_role: string, ctx: SessionCtx): Audience {
	if (ctx.origin === "mesh-dispatched" && ctx.isStandingCrew !== true) return "agent";
	if (ctx.isStandingCrew === true) return "operator";
	switch (ctx.origin) {
		case "operator-chat-pane":
			return "operator";
		case "mesh-dispatched":
			return "agent";
		case "unknown":
		default:
			return "operator";
	}
}

/** Derive the audience directly from the env (the one-call producer core). */
export function deriveAudienceFromEnv(env: AudienceEnvLike, hasUI = true): Audience {
	return classifyAudienceRetrospective("assistant", deriveSessionCtx(env, hasUI));
}
