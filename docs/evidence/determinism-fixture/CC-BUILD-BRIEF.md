# CC Build Brief — Track-2 fixture-bound determinism render-binding

You are a Claude Code build-session **supervised by Threadwright-9** (a pi-driver). Build ONE frozen candidate. Do NOT merge, push, deploy, wire live, or ask the operator. When done, STOP and report back to Threadwright-9 with the evidence package below. Read this brief top to bottom, then execute exactly.

## Context (operator dl-13423)
The dashboard `/threads` view (ThreadsView) and a NOS determinism-model are "two halves of one thing": the thread shows how work is being done; the determinism model supplies each work-item's stage + a deterministic-vs-judgment overlay. Statewright owns the fold (`project()`); YOU build the dashboard render-binding that consumes its output. This is the FIXTURE-BOUND phase: bind against a frozen sample, zero live coupling.

## Where you are
- **Isolated git worktree** (branch `threadwright/determinism-fixture-bind`, base `feat/ledger-thread-durability @ 111aae4`): this directory. Work ONLY here.
- Target surface: `packages/client/src/components/ThreadsView.tsx` (+ `packages/client/src/hooks/`, `packages/client/src/lib/`). It already uses an **injectable-fetcher** pattern (`ThreadsListFetcher`, `handoffFetcher`, `MessageLaneManagerProvider`) — follow it exactly.

## THE BIND TARGET (consume ONLY this — never a repo path)
`_fixture/fixture-c23c8d47.json` — sha256 `c23c8d47…`, 1911 bytes, extracted from frozen commit `6d4b412c`. It has a top-level `{_artifact,_machine,_generated,samples[]}`; the 3 projections are under `samples`. Your fetcher/tests read THIS FILE ONLY. Do NOT read the arch-diagram-driver `_model/` or any repo working-tree copy — an hourly cron mutates that tree; the extracted file is the immutable bind target.

## Wire contract (frozen; project(thread_id) →)
```
{ thread_id, machine, stage, stage_meaning?, pending[], degrade }
  pending item: { to, kind:"deterministic", via_event, gate }
             OR { to, kind:"judgment",     via_event, who  }
  degrade: "unmapped" | "spine-only" | null
```

## Build (§21 TypeScript only)
1. **`determinismFetcher(threadId) → Promise<Projection | null>`** — injectable, sister to `handoffFetcher`. Fixture-backed: resolves from `_fixture/fixture-c23c8d47.json` `samples[]` keyed by `thread_id`; unknown thread → a `degrade:"unmapped"` projection (stage:null), never throw.
2. **A determinism overlay component** rendering per thread: `stage` + `stage_meaning` (optional subtitle/tooltip) + `pending[]` as edges — **deterministic → solid/green + `gate` label; judgment → dashed/amber + `who` label**. Degrade handling: `spine-only` → honest "partial fold" badge; `unmapped` → "not mapped / unknown" (NOT an error); `done`/empty-pending → no edges.
3. **Wire into ThreadsView** additively via an injectable `determinismFetcher` prop (same shape as `handoffFetcher`), rendered alongside `ThreadStatusBadge` / on select. Follow the existing **CSS-var token / theme-safe** discipline (no hard-coded colors). Load the `frontend-design` skill before composing new visual structure (§14).
4. **A read-only server route** that serves the projection — FIXTURE-BACKED for this phase (serves the extracted fixture; NO live ledger read, NO coupling).

## LOAD-BEARING RENDER INVARIANTS
- **Key pending items by `via_event`** (or the full transition tuple), **NEVER de-dupe on `to` alone.** The fixture's `peggy+attention-app` has **7 pending**, including **2 rows with `to:"reaped"`** but different `via_event` (`operator-reap` vs `sweep-reap`) — both MUST render as **distinct edges**. Add a test asserting **7 pending / 2 distinct reaped edges** so a de-dupe-on-`to` regression fails loud.
- **`who` = decision-authority** (from `escalate_to`), NOT process actor. **`gate` = enforcement mechanism** (from `enforced_by`). Document this in the build report.
- Review note to carry in the report: **if `sweep-reap` ever becomes autonomous without operator authorization, that transition must flip to deterministic/gate semantics.**

## TESTS ASSERT SHAPE, NOT MUTABLE VALUES
The fixture is a SHAPE snapshot of 3 LIVE ledger threads — their stage/pending WILL diverge over time and that is CORRECT. Assert: the 5 contract fields present; det/judgment tagging; terminal(`done`→empty pending); unmapped(`stage:null`/`degrade:"unmapped"`); the 7-pending/2-distinct-reaped-edges shape-handling. Use the snapshot as a REPRESENTATIVE example — do NOT pin `peggy+attention-app` to `stage:"running"` forever, and do NOT "fix" any fold to match the snapshot. `tsc` clean + all tests green + the reaped-edges test proven able-to-fail (RED on a de-dupe mutation).

## HARD CONSTRAINTS
- Work ONLY in this isolated worktree. NO edit to the shared tree, NO edit to source `_model/`, NO live ledger coupling, NO live wiring, NO deploy, NO push, NO production, NO operator re-ask.
- §3 no-attribution (no `Co-Authored-By`, no "Generated with" / AI markers in commits/code/docs). §21 TS-only. §14 SKILL-load before UI.

## STOP + REPORT (one frozen candidate/evidence package)
Commit on the worktree branch (no push). Then STOP and report to Threadwright-9 with: the commit sha + diff summary; `tsc` clean output; test results (all green + the able-to-fail reaped-edges assertion shown RED-on-mutation then GREEN); render evidence (screenshot or DOM assertion) of the overlay rendering the 3 fixture cases (running/7-pending/spine-only, done/terminal, unmapped); and the fixture provenance line (`fixture-c23c8d47.json` sha c23c8d47 @ frozen 6d4b412c). Threadwright-9 verifies, then returns the package to Lane + Joan for seam review. Live wiring is a separate Joan decision — not in scope.
