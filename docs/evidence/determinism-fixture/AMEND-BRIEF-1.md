# AMEND-BRIEF-1 — Track-2 fixture-bound render-binding (3 Lane seam blockers)

Supervised by Threadwright-9. The seam review returned AMEND on THREE points. Fix ONLY these three, rerun, freeze evidence, then STOP and report back to Threadwright-9. Do NOT merge, push, or wire live. Work only in this isolated worktree. Read top to bottom, then execute exactly.

Context: Joan's fixture-integrity distinction was accepted — the count assertions (7 pending / 2 reaped / 3 samples / 1911 bytes) are fine AS shape-invariants of the immutable fixture with the sha256 provenance tripwire. Do NOT remove them. The three fixes below are separate.

## BLOCKER 1 — false terminal claim (DeterminismOverlay.tsx)
The `done` sample is `degrade:"spine-only"` (a PARTIAL fold) with `pending:[]`. The overlay currently renders `no pending transitions — terminal stage (nowhere left to go)` (~line 273) and the comments at ~line 21 and ~line 265 assert terminality. A partial (spine-only) fold with zero represented edges does NOT prove the stage is terminal — the unfolded event-types could carry transitions.
- FIX: change the copy to the truthful, projection-scoped: **"no pending transitions in this projection"**. 
- Remove any "terminal stage" / "nowhere left to go" / "nowhere to go" wording from the rendered copy AND the comments.
- Rule: do NOT emit terminal/nowhere-left copy unless an explicit authoritative terminal carrier exists in the projection (there is none today — `degrade:"spine-only"` is the opposite of an authoritative complete fold).
- Update any test asserting the old "terminal" copy to assert the new projection-scoped copy.

## BLOCKER 2 — live-wiring boundary crossed in the client (ThreadsView.tsx)
`ThreadsView` currently defaults `determinismFetcher = fetchDeterminism` (~line 202) — the live REST fetcher — so every selected thread calls the live endpoint by default. The server route is held (unregistered), but the CLIENT is already live-wired. Live wiring is a SEPARATE Joan gate and must NOT be the default.
- FIX: the default `determinismFetcher` MUST be an unbound/null no-op (returns `null` with NO network call), NOT `fetchDeterminism`. Simplest: make the prop optional with NO default (undefined), and guard the call-site so an absent fetcher renders the overlay inert (no fetch, no overlay call). 
- Keep `fetchDeterminism` EXPORTED and available as an explicit opt-in, but it must NOT be wired as the default anywhere. Enabling it is behind Joan's live-wiring gate — out of scope here.
- Fixture tests + the render-evidence harness MUST inject the fixture fetcher (`makeFixtureDeterminismFetcher`) EXPLICITLY (they may already; ensure no test relies on the removed live default).
- Confirm: with the default (no injected fetcher), the client makes ZERO network calls and the overlay is inert.

## BLOCKER 3 — freeze the evidence
The evidence artifacts under `_fixture/` (PNGs, render HTML, render scripts, this brief) are untracked with no immutable manifest.
- FIX: after the code fixes + rerun, freeze the AMENDED evidence: put the artifacts under a tracked path (e.g. `docs/evidence/determinism-fixture/`), generate a `MANIFEST.sha256` (sha256 of each evidence file), and COMMIT them in a docs/evidence commit on this branch (no push).
- Clean the worktree so `git status` is empty after the commit (no stray untracked files).
- The evidence commit binds to the amended CODE identity: reference the amended code commit sha in the evidence commit message / manifest.

## RERUN + FREEZE (after the 3 fixes)
- `HOME=$(mktemp -d) npx vitest run determinism` → all green (report the count).
- Re-prove able-to-fail: mutate `pendingKey` to key on `to` alone → RED → revert → GREEN (report).
- Re-render the 3 fixture cases (running / done / unmapped) → regenerate the desktop + mobile PNGs so the DONE case shows the corrected "no pending transitions in this projection" copy. Look at them.
- `npx tsc -p tsconfig.json --noEmit` → zero errors in your files (10 pre-existing baseline OK).
- Commit the amended code (surgical, §3 no-attribution: no Co-Authored-By / Generated / AI markers), then the evidence commit. NO push.

## HARD CONSTRAINTS (unchanged)
Isolated worktree only. NO edit to source `_model/`, NO shared-tree edit, NO live coupling (the whole point of blocker 2), NO live wiring, NO deploy, NO push, NO operator re-ask. §21 TS-only. Bind target remains `_fixture/fixture-c23c8d47.json` (sha c23c8d47) — do not re-extract or change it.

## STOP + REPORT
Report to Threadwright-9 with: amended code commit sha + evidence commit sha, the diff for each of the 3 fixes, rerun results (tests green + able-to-fail RED-on-mutation→GREEN), the regenerated DONE-case screenshot showing the corrected copy, `git status` clean, and confirmation the client makes zero network calls by default. Threadwright-9 re-verifies own-hand, then returns to Lane + Joan for re-seam.
