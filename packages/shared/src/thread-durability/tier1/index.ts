/**
 * Tier-1 read-only visibility — shared read-model barrel (design v0.3 Tier-1).
 *
 * The SHARED Tier-1 readers: the cloned-DTO session facade + the pure v2-ledger
 * keyset/hand-off-lane logic. READ-ONLY projections — no writes, no lock, no
 * recovery/dedup/terminal authority.
 *
 * STANDALONE barrel: intentionally NOT re-exported from the committed
 * `thread-durability/index.js` (that would fold Tier-1 into the core surface).
 * Tier-1 consumers import from here explicitly.
 *
 * SEAM-2: the recovery packages (`recovery-decision.ts`, `recover-evidence.ts`,
 * the drain/inject recovery path) may NEVER import a Tier-1 reader — enforced by
 * `packages/shared/src/__tests__/no-recovery-imports-tier1.test.ts`.
 */
export * from "./cloned-session-facade.js";
export * from "./ledger-range.js";
