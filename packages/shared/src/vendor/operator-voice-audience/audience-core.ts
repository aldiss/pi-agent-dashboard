/**
 * VENDORED from pi-operator-voice src/audience-core.ts @ 942ac27.
 * Drift-guarded by golden-corpus.test.ts (reconciled to the extension's
 * test/audience-golden-corpus.test.ts). Do not hand-edit — re-vendor from source.
 */
/**
 * audience-core — the DEPENDENCY-LIGHT, PURE audience-derivation core (build-item-3).
 *
 * This is the ONE source of the operator-addressed classification, factored so a
 * SEPARATE tree (the Dashwright dashboard-server, `@blackbelt-technology/pi-agent-
 * dashboard` — ESM, no npm dep path to this extension) can VENDOR it verbatim and
 * guard its copy with a golden-corpus consistency-test.
 *
 * ── WHY THIS MODULE EXISTS (R1-session-meta anti-drift) ──────────────────────
 * Both the extension (stamp-at-emit) and the dashboard-server (SessionMeta.audience)
 * must derive the SAME audience from the SAME inputs. Two independent
 * implementations WILL drift. So the derivation lives HERE, pure and portable, and
 * both sides run it. The extension re-exports it (via `audience.ts` + `role-
 * registry.ts`); the dashboard vendors a copy reconciled against the golden corpus.
 *
 * ── THE INJECTION SEAM (the one thing the caller supplies) ───────────────────
 * The ONLY impurity in audience derivation is the FS read of `role-registry.json`.
 * This module does NOT read it — it takes a caller-supplied `RegistryLoadResult`.
 * The extension injects `loadRegistryResult()` (its cached `node:fs` read); the
 * dashboard-server injects ITS own read (it already owns the FS read of the
 * registry + reuses it for its registry-CHANGE watch). So: NO `node:fs` / `node:os`
 * / `node:path` here — this file imports nothing. Pure, portable, vendorable.
 *
 * ── THE DECISION RULE (own-hand, session-level constant) ─────────────────────
 *   standing-crew incumbent (exact themed_name @ standing tier) → operator
 *   registered non-standing member AND load.status==="complete"  → agent
 *   PI_AGENT_NAME unset + hasUI=true (interactive TTY)           → operator
 *   everything else — named-miss / partial / stale / unreadable /
 *     unset+headless                                             → unknown
 * `role` is NOT consulted (audience is a property of the session's interlocutor,
 * not the row's role). `hasUI` is pi's ACTUAL `ctx.hasUI` (interactive-TTY).
 * The safety asymmetry: `agent` (the only hide-eligible state) demands POSITIVE
 * proof; every unproven case fails OPEN to `unknown` (shown + exempt), never hidden.
 */

// ── registry identity types (moved here so the dashboard vendors ONE file) ───

/** A single registry role entry (partial — only the fields the derivation reads). */
export interface RegistryRole {
	themed_name?: string | undefined;
	tier?: string | undefined;
	tmux_session?: string | undefined;
	heartbeat_at?: string | undefined;
	[k: string]: unknown;
}

export interface RegistrySnapshot {
	/** Top-level completeness marker (the writer's schema stamp). */
	schema_version?: string | undefined;
	/** Top-level currency marker (ISO-8601 last-write time). */
	updated_at?: string | undefined;
	roles: Record<string, RegistryRole>;
}

/** The parsed, indexed registry identity view. */
export interface RegistryIdentity {
	/** lowercased standing-crew themed-names (exact-identity set). */
	standingCrew: ReadonlySet<string>;
	/**
	 * ALL non-standing display-names (from tmux_session / non-standing themed_name),
	 * regardless of liveness. This is the AUDIENCE-path set (F1): membership here
	 * licenses `agent` in a COMPLETE load.
	 */
	transientNames: ReadonlySet<string>;
	/**
	 * The LINT-path set (F4): the transient display-names that are BOTH live
	 * (per-entry heartbeat inside the freshness window) AND not a canonical-nine
	 * name. Dead residue + canonical names never lint.
	 */
	liveTransientNames: ReadonlySet<string>;
}

/**
 * The load status of a registry read (B1 — the TOTAL result). Only a `complete`
 * load may license the hide-eligible `agent` stamp; every other status projects
 * `unknown` (shown + exempt), NEVER agent-hidden.
 *
 *   - "complete":   readable + parsed + non-empty `roles` + a RECOGNIZED
 *                   `schema_version` + a currency point INSIDE the freshness
 *                   window. Positive membership CAN be trusted → `agent` allowed.
 *   - "stale":      well-shaped, but the currency point is OUTSIDE the window
 *                   (or absent). The generation could be behind — do NOT hide.
 *   - "partial":    parsed, but missing the completeness markers
 *                   (`schema_version` / `roles`) that prove a full snapshot.
 *   - "unreadable": read/parse failure, `null`, non-object, or no `roles`.
 */
export type RegistryLoadStatus = "complete" | "stale" | "partial" | "unreadable";

export interface RegistryLoadResult {
	status: RegistryLoadStatus;
	/** The indexed identity view (always present — empty sets on unreadable). */
	identity: RegistryIdentity;
	/** The parsed currency point (ms epoch) — max(updated_at, newest heartbeat), when derivable. */
	currencyAtMs?: number | undefined;
	/** Age of the currency point vs `now` (ms), when derivable. */
	ageMs?: number | undefined;
}

// ── thresholds + constants (the completeness/liveness knobs) ─────────────────

/** Standing-crew tiers (operator-facing council incumbents), per AGENTS.md. */
export const STANDING_TIERS: ReadonlySet<string> = new Set([
	"L0.4",
	"L0.5",
	"L0.5a",
	"L0.5b",
	"L0.5c",
	"L0.5d",
	"L1",
]);

/**
 * The canonical nine standing-crew names (Peggy's curation). NEVER linted as
 * transient display-names (F4). SINGLE-SOURCE: asserted equal to the lexicon JSON
 * `canonical_9_allow_list` + shape-rules `CANONICAL_9` by `test/single-source.test.ts`.
 */
export const CANONICAL_NINE: readonly string[] = Object.freeze([
	"Bert",
	"Joan",
	"Peggy",
	"Faye",
	"Lane",
	"Pete",
	"Don",
	"Alice",
	"Harry",
]);

/** Lowercased canonical-nine, for O(1) case-insensitive subtraction. */
const CANONICAL_NINE_LC: ReadonlySet<string> = new Set(CANONICAL_NINE.map((n) => n.toLowerCase()));

/** Recognized top-level `schema_version` values (completeness marker). */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<string> = new Set<string>(["1.0"]);

/**
 * Registry currency window (B1). Mirrors the registry's OWN documented convention
 * (`role-registry.json._comment`: "heartbeat_at older than 30 min … treated as
 * stale by readers"). A load whose freshest currency point is older than this
 * projects `stale` → no `agent` stamp (conservative degradation).
 */
export const DEFAULT_REGISTRY_FRESHNESS_MS = 30 * 60 * 1000;

/** The empty identity (unreadable load / no registry). */
export const EMPTY_IDENTITY: RegistryIdentity = {
	standingCrew: new Set<string>(),
	transientNames: new Set<string>(),
	liveTransientNames: new Set<string>(),
};

/** Parse an ISO-8601 instant to ms epoch, or undefined when unparseable. */
export function parseInstantMs(v: unknown): number | undefined {
	if (typeof v !== "string" || v.trim() === "") return undefined;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : undefined;
}

/**
 * Per-entry LIVENESS (F4). A transient entry contributes a live display-name ONLY
 * if it is not dead residue: a PRESENT `heartbeat_at` older than the window → dead;
 * inside the window → live; a MISSING/unparseable stamp → live (absence is not
 * evidence of death).
 */
function isEntryLive(entry: RegistryRole, now: number, freshnessMs: number): boolean {
	const hb = parseInstantMs(entry.heartbeat_at);
	if (hb === undefined) return true;
	return now - hb <= freshnessMs;
}

// ── registry indexing + load classification (pure) ───────────────────────────

/**
 * Build the indexed identity view from a parsed registry snapshot (pure).
 * Computes the audience-path `transientNames` (ALL non-standing display-names) and
 * the lint-path `liveTransientNames` (live entries only, minus canonical-nine).
 *
 * `now` defaults to `Date.now()` for ergonomics, but pass it explicitly for
 * DETERMINISTIC use (the golden-corpus consistency-test pins `now`). The only hard
 * portability guarantee this module makes is NO FS/OS/PATH import.
 */
export function indexRegistry(
	snapshot: RegistrySnapshot | undefined,
	now: number = Date.now(),
	freshnessMs: number = DEFAULT_REGISTRY_FRESHNESS_MS,
): RegistryIdentity {
	const standingCrew = new Set<string>();
	const transientNames = new Set<string>();
	const liveTransientNames = new Set<string>();
	const roles = snapshot?.roles ?? {};
	for (const v of Object.values(roles)) {
		if (!v || typeof v !== "object") continue;
		const themed = (v.themed_name ?? "").trim();
		const tier = v.tier;
		const tmux = (v.tmux_session ?? "").trim();
		const isStanding = themed !== "" && typeof tier === "string" && STANDING_TIERS.has(tier);
		if (isStanding) {
			standingCrew.add(themed.toLowerCase());
		} else {
			const live = isEntryLive(v, now, freshnessMs);
			for (const name of [tmux, themed]) {
				if (!name) continue;
				transientNames.add(name);
				if (live && !CANONICAL_NINE_LC.has(name.toLowerCase())) {
					liveTransientNames.add(name);
				}
			}
		}
	}
	return { standingCrew, transientNames, liveTransientNames };
}

/**
 * Classify a PARSED registry value into a total `RegistryLoadResult` (pure — B1).
 * Completeness-and-currency are decided HERE, before any membership query. A value
 * that is not a genuine complete/current snapshot can NEVER license `agent`.
 *
 * `now` defaults to `Date.now()` for ergonomics; pass it explicitly for
 * DETERMINISTIC use (the golden-corpus test pins it).
 */
export function classifyLoad(
	parsed: unknown,
	now: number = Date.now(),
	freshnessMs: number = DEFAULT_REGISTRY_FRESHNESS_MS,
): RegistryLoadResult {
	if (!parsed || typeof parsed !== "object") {
		return { status: "unreadable", identity: EMPTY_IDENTITY };
	}
	const snap = parsed as RegistrySnapshot;
	const roles = snap.roles;
	if (!roles || typeof roles !== "object" || Object.keys(roles).length === 0) {
		return { status: "unreadable", identity: EMPTY_IDENTITY };
	}

	const identity = indexRegistry(snap, now, freshnessMs);

	if (typeof snap.schema_version !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(snap.schema_version)) {
		return { status: "partial", identity };
	}

	let currencyAtMs = parseInstantMs(snap.updated_at);
	for (const v of Object.values(roles)) {
		if (!v || typeof v !== "object") continue;
		const hb = parseInstantMs((v as RegistryRole).heartbeat_at);
		if (hb !== undefined && (currencyAtMs === undefined || hb > currencyAtMs)) currencyAtMs = hb;
	}

	if (currencyAtMs === undefined) {
		return { status: "stale", identity };
	}
	const ageMs = now - currencyAtMs;
	if (ageMs > freshnessMs) {
		return { status: "stale", identity, currencyAtMs, ageMs };
	}
	return { status: "complete", identity, currencyAtMs, ageMs };
}

/** TRUE iff the load is a COMPLETE, CURRENT snapshot — the only agent-licensing status. */
export function isComplete(result: RegistryLoadResult): boolean {
	return result.status === "complete";
}

/**
 * Build a total `RegistryLoadResult` from an in-memory snapshot (pure — tests +
 * callers that already hold the parsed registry). Same classification as a disk
 * load, no fs.
 */
export function indexRegistryResult(
	snapshot: RegistrySnapshot | undefined,
	now: number = Date.now(),
	freshnessMs: number = DEFAULT_REGISTRY_FRESHNESS_MS,
): RegistryLoadResult {
	return classifyLoad(snapshot, now, freshnessMs);
}

// ── the identity predicates (pure — operate on an indexed identity) ──────────

/**
 * EXACT standing-crew identity: `name` equals the `themed_name` of a standing-
 * crew-tier registry entry. NOT a prefix — `Joan-helper` is false. Case-insensitive.
 */
export function isStandingCrew(name: string | undefined, identity: RegistryIdentity): boolean {
	if (!name) return false;
	return identity.standingCrew.has(name.trim().toLowerCase());
}

/** Whether the registry knows this name at all (standing OR transient). */
export function isRegistered(name: string | undefined, identity: RegistryIdentity): boolean {
	if (!name) return false;
	const n = name.trim();
	if (identity.standingCrew.has(n.toLowerCase())) return true;
	return identity.transientNames.has(n);
}

/**
 * POSITIVE exact NON-STANDING membership (B1 — the only agent-licensing signal).
 * TRUE iff `name` is an exact transient display-name AND is NOT a standing-crew
 * incumbent. A named-miss returns false → the caller projects `unknown`, never
 * `agent`. Exact match (not prefix): `Commwright-2` in, bare `Commwright` out.
 */
export function isRegisteredNonStanding(name: string | undefined, identity: RegistryIdentity): boolean {
	if (!name) return false;
	const n = name.trim();
	if (identity.standingCrew.has(n.toLowerCase())) return false;
	return identity.transientNames.has(n);
}

// ── the audience derivation (pure — the vendored core) ───────────────────────

export type Audience = "operator" | "agent" | "unknown";

/** The three valid wire values. Used for runtime validation of an upstream stamp. */
const AUDIENCE_VALUES: ReadonlySet<string> = new Set<string>(["operator", "agent", "unknown"]);

/** Runtime-validate an upstream `audience` value (untrusted wire/env data). */
export function isValidAudience(v: unknown): v is Audience {
	return typeof v === "string" && AUDIENCE_VALUES.has(v);
}

/** VISIBILITY axis: is this row shown? operator + unknown → shown; agent → hide-eligible. */
export function isShown(audience: Audience): boolean {
	return audience === "operator" || audience === "unknown";
}

/** LINT axis: is this row linted? ONLY provably-operator rows are linted. */
export function isLinted(audience: Audience): boolean {
	return audience === "operator";
}

/**
 * Session interlocutor origin.
 *   - "operator-chat-pane": the operator's own chat pane.
 *   - "mesh-dispatched":     a dispatched LLM session (named, non-standing).
 *   - "unknown":             indeterminate (no name + headless, or registry-unreadable).
 */
export type SessionOrigin = "operator-chat-pane" | "mesh-dispatched" | "unknown";

export interface SessionCtx {
	origin: SessionOrigin;
	/** The agent's name (informational). */
	canonicalName?: string | undefined;
	/** TRUE iff a genuine registered standing-crew incumbent (exact identity). */
	isStandingCrew?: boolean;
}

/** A message role, minimally. */
export type MessageRole = "user" | "assistant" | "toolResult" | string;

export interface AudienceEnvLike {
	/** `PI_AGENT_NAME` — set for every dispatched LLM session, unset for the operator's pane. */
	PI_AGENT_NAME?: string | undefined;
	[k: string]: string | undefined;
}

/**
 * Derive the session context from the env + the TOTAL registry load (B1) — PURE.
 * `load` is a REQUIRED argument: the caller INJECTS it (the extension supplies its
 * cached `node:fs` read via `loadRegistryResult()`; the dashboard-server supplies
 * its own read). `agent` (via `mesh-dispatched`) is licensed ONLY by positive exact
 * non-standing membership in a COMPLETE/CURRENT load; every other case (named-miss
 * / partial / stale / unreadable) resolves to `unknown`.
 */
export function deriveSessionCtx(env: AudienceEnvLike, hasUI: boolean, load: RegistryLoadResult): SessionCtx {
	const name = env.PI_AGENT_NAME?.trim();
	if (!name) {
		// No name: interactive → operator's own pane; headless → unknown.
		return hasUI
			? { origin: "operator-chat-pane", isStandingCrew: false }
			: { origin: "unknown", isStandingCrew: false };
	}
	// NAMED. A standing-crew incumbent (exact identity, tolerated even on a
	// partial/stale load — `operator` SHOWS + lints, the safe direction) → operator.
	if (isStandingCrew(name, load.identity)) {
		return { origin: "operator-chat-pane", canonicalName: name, isStandingCrew: true };
	}
	// A named non-standing session is `agent` (hide-eligible) ONLY on POSITIVE exact
	// membership in a COMPLETE/CURRENT registry. Named-miss, or ANY non-`complete`
	// load (partial / stale / unreadable), fails OPEN to `unknown`.
	if (load.status === "complete" && isRegisteredNonStanding(name, load.identity)) {
		return { origin: "mesh-dispatched", canonicalName: name, isStandingCrew: false };
	}
	return { origin: "unknown", canonicalName: name, isStandingCrew: false };
}

/**
 * Decide the audience from the session context (3-state). ORIGIN dominates:
 *   - operator-chat-pane                → operator
 *   - mesh-dispatched (not standing)    → agent
 *   - mesh-dispatched + standing (rare) → operator
 *   - unknown                           → unknown (NOT operator — fail-open shown+exempt)
 * `role` is NOT consulted (audience is a property of the session's interlocutor).
 */
export function classifyAudience(ctx: SessionCtx): Audience {
	if (ctx.isStandingCrew === true) return "operator";
	switch (ctx.origin) {
		case "operator-chat-pane":
			return "operator";
		case "mesh-dispatched":
			return "agent";
		case "unknown":
		default:
			return "unknown";
	}
}

/** Derive the audience directly from the env + INJECTED load (the one-call producer core). */
export function deriveAudienceFromEnv(env: AudienceEnvLike, hasUI: boolean, load: RegistryLoadResult): Audience {
	return classifyAudience(deriveSessionCtx(env, hasUI, load));
}

/**
 * The AUTHORITATIVE producer stamp (B3 — single source of truth). The producer
 * OWNS the wire field: it derives the audience from the session context and
 * OVERWRITES whatever `audience` the envelope carried. Deterministic per session,
 * so re-emit/replay is idempotent.
 */
export function produceStamp(ctx: SessionCtx): Audience {
	return classifyAudience(ctx);
}

/**
 * Whether Door-3 should lint this message. ONLY an operator-addressed assistant row
 * is linted (the LINT axis): agent + unknown are exempt.
 */
export function shouldLintAtMessageEnd(role: MessageRole, audience: Audience): boolean {
	return role === "assistant" && isLinted(audience);
}

// ── source → hasUI mapping (the Dashwright SessionMeta seam) ──────────────────

/**
 * The pi session `source` values that are INTERACTIVE (a real controlling TTY /
 * editor pane) → `hasUI=true`. The EXTENSION reads pi's actual `ctx.hasUI` and
 * never needs this; the DASHBOARD-server, which derives `hasUI` from
 * `SessionMeta.source`, uses this to compute it consistently. Documented here so
 * the ONE derivation covers the "unnamed + {tui,terminal,zed} → operator" edges
 * Dashwright pinned. A MISSING / unknown source → NOT interactive → `hasUI=false`
 * → an unnamed session resolves to `unknown` (fail-open shown+exempt).
 */
export const INTERACTIVE_SOURCES: ReadonlySet<string> = new Set<string>(["tui", "terminal", "zed"]);

/** Map a pi session `source` string to `hasUI` (interactive-TTY). Missing/unknown → false. */
export function hasUiFromSource(source: string | undefined): boolean {
	return typeof source === "string" && INTERACTIVE_SOURCES.has(source);
}
