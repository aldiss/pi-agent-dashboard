/**
 * Tier-1 read-only visibility — server read-model barrel (design v0.3 Tier-1).
 *
 * The SERVER Tier-1 readers: the per-thread current-status read (row →
 * TerminalProof → fail-loud) + the hand-off-lane reader over the ACTIVE v2
 * ledger. READ-ONLY projections over the durable outbox + the v2 SQLite db — no
 * writes, no lock, no GC, no recovery/dedup/terminal authority.
 *
 * STANDALONE barrel: intentionally NOT re-exported from the committed
 * `thread-durability/index.js`, and NOT wired into `server.ts` (activation-tier).
 *
 * SEAM-2: the recovery packages may NEVER import a Tier-1 reader — enforced by
 * `packages/shared/src/__tests__/no-recovery-imports-tier1.test.ts`.
 */
export * from "./thread-status-read.js";
export * from "./handoff-lane-read.js";
