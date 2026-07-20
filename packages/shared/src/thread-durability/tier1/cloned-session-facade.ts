/**
 * Tier-1 read-only visibility — the cloned-DTO facade over
 * `ReadonlySessionManager` (design v0.3 Tier-1 §"Additive-safety on the
 * never-drop core" (a)).
 *
 * THE PROBLEM this seam exists to solve. The pi core's `ReadonlySessionManager`
 * is a `Pick<SessionManager, "getEntry" | "getLeafEntry" | "getBranch" | …>`.
 * That `Pick` is a COMPILE-TIME type only — it is runtime-erased, so it is no
 * barrier at all: the object you hold IS the live `SessionManager`, and its
 * getters ALIAS the manager's mutable internals. Verified own-hand against
 * `session-manager.js:802-806`:
 *
 *     getLeafEntry() { return this.leafId ? this.byId.get(this.leafId) : undefined; }
 *     getEntry(id)   { return this.byId.get(id); }
 *
 * `getEntry`/`getLeafEntry`/`getBranch` hand back the SAME object stored in the
 * live `byId` map; `getEntries`/`getTree` return a fresh ARRAY but the SAME
 * entry object references (a shallow copy). So a Tier-1 reader that mutated a
 * returned entry would corrupt the live session the core is actively appending
 * to — a read surface silently acquiring write reach into the never-drop core.
 *
 * THE FIX. This facade wraps the manager and returns, from every getter, a DEEP
 * CLONE (`structuredClone`) that is then DEEP-FROZEN. The clone severs the
 * aliasing (mutating a returned DTO cannot reach the manager's internals); the
 * freeze makes the read-only contract enforced at runtime, not merely by
 * convention. The facade NEVER exposes the live manager object — there is no
 * getter that returns `this.mgr`.
 *
 * Scope: this is the safe read seam for session/message CONTENT the P2 message
 * lane consumes. It is PURE (no I/O of its own — it calls the injected
 * manager's getters) and lives in `shared` so both server and bridge read
 * through the identical seam. It confers NO write authority: the facade has no
 * `append*`/`branch`/`setSessionFile` surface at all.
 */

/**
 * A session entry DTO — the cloned, frozen projection of a pi `SessionEntry`.
 * Structural + permissive (`[k: string]: unknown`) so a real pi `SessionEntry`
 * (message / custom_message / model_change / …) assigns without re-declaring
 * pi's full union here. Every value is a deep clone; the object is deep-frozen.
 */
export interface SessionEntryDto {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [k: string]: unknown;
}

/** A session header DTO — cloned + frozen projection of the pi `SessionHeader`. */
export interface SessionHeaderDto {
  type: "session";
  id: string;
  cwd: string;
  timestamp: string;
  [k: string]: unknown;
}

/** A tree-node DTO — cloned + frozen projection of the pi `SessionTreeNode`. */
export interface SessionTreeNodeDto {
  entry: SessionEntryDto;
  children: SessionTreeNodeDto[];
  label?: string;
  [k: string]: unknown;
}

/**
 * The minimal READ getters the facade wraps — a structural mirror of the pi
 * `ReadonlySessionManager` getter subset Tier-1 consumes. A real
 * `ReadonlySessionManager` satisfies this structurally (the return types are
 * supersets of these DTOs). Declared locally so `shared` needs no compile-time
 * dependency on the pi package. NOTE: these methods return the manager's LIVE
 * aliased internals — the facade clones them before returning.
 */
export interface ReadonlySessionManagerLike {
  getCwd(): string;
  getSessionId(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getSessionName?(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntryDto | undefined;
  getEntry(id: string): SessionEntryDto | undefined;
  getBranch(fromId?: string): SessionEntryDto[];
  getEntries(): SessionEntryDto[];
  getTree(): SessionTreeNodeDto[];
  getHeader(): SessionHeaderDto | null;
  getLabel(id: string): string | undefined;
}

/**
 * The immutable read-only facade — every getter returns a deep-cloned,
 * deep-frozen DTO. NO method returns the live manager object; NO mutation
 * surface exists. This is the type the P2 message lane depends on.
 */
export interface ClonedSessionFacade {
  // ── scalar getters (value types — no aliasing risk, passed through) ──
  getCwd(): string;
  getSessionId(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
  getLeafId(): string | null;
  getLabel(id: string): string | undefined;
  // ── object/array getters (deep-cloned + deep-frozen DTOs) ──
  getLeafEntry(): SessionEntryDto | undefined;
  getEntry(id: string): SessionEntryDto | undefined;
  getBranch(fromId?: string): SessionEntryDto[];
  getEntries(): SessionEntryDto[];
  getTree(): SessionTreeNodeDto[];
  getHeader(): SessionHeaderDto | null;
}

/**
 * Deep-freeze a value in place (recursively freezes plain objects + arrays).
 * Operates on a structuredClone output, so there are no shared references back
 * to the source — freezing is safe and total. Returns the same (now frozen)
 * reference, typed as `T`.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  // Freeze children first so the whole graph is frozen bottom-up.
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Clone-then-freeze a getter's return value. `undefined`/`null` pass through
 * (nothing to clone). Everything else is `structuredClone`d (severing the alias
 * to the manager's internals) then deep-frozen (runtime read-only). pi session
 * entries are JSON-shaped (message/custom/model-change records) → always
 * structured-cloneable.
 */
function cloneFrozen<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return deepFreeze(structuredClone(value));
}

/**
 * Build the cloned-DTO facade over a `ReadonlySessionManager`-like handle.
 *
 * Every object/array getter deep-clones then deep-freezes before returning, so:
 *  - mutating a returned DTO can NEVER reach the manager's live internals
 *    (the alias is severed by the clone), and
 *  - the returned DTO is itself frozen (a read-only contract enforced at
 *    runtime, not just by the erased `Pick` type).
 *
 * Scalar getters (`getCwd`, `getSessionId`, …) return value types (strings /
 * null / undefined) — no aliasing is possible, so they pass through directly.
 *
 * The facade closes over `mgr` privately and exposes NO accessor that returns
 * it — the live manager object is never handed out.
 */
export function createClonedSessionFacade(mgr: ReadonlySessionManagerLike): ClonedSessionFacade {
  return {
    // ── scalars: value types, no clone needed ──
    getCwd: () => mgr.getCwd(),
    getSessionId: () => mgr.getSessionId(),
    getSessionDir: () => mgr.getSessionDir(),
    getSessionFile: () => mgr.getSessionFile(),
    getSessionName: () => mgr.getSessionName?.(),
    getLeafId: () => mgr.getLeafId(),
    getLabel: (id: string) => mgr.getLabel(id),
    // ── object/array getters: deep clone + deep freeze (sever the alias) ──
    getLeafEntry: () => cloneFrozen(mgr.getLeafEntry()),
    getEntry: (id: string) => cloneFrozen(mgr.getEntry(id)),
    getBranch: (fromId?: string) => cloneFrozen(mgr.getBranch(fromId)),
    getEntries: () => cloneFrozen(mgr.getEntries()),
    getTree: () => cloneFrozen(mgr.getTree()),
    getHeader: () => cloneFrozen(mgr.getHeader()),
  };
}
