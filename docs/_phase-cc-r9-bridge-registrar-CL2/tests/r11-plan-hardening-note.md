# r11 — APPLY/ROLLBACK plan hardening (docs-only; dl-13823 / dl-13824)

Pete BLOCK **dl-13823** + Lane release **dl-13824** on the r10 apply package. **Code
(`e6ae9b9`) is unchanged and immutable** — `git diff e6ae9b9 -- scripts/` is empty. This is a
**docs-only** amendment to `APPLY-ROLLBACK-PLAN.md` (+ this note + manifest). No code retest was
required (no code bytes changed); the r10 code evidence (import controls, e2e 13/13, isolation
22/22) stands.

## The gap Pete found
The r10 plan's verifiers only *reported*: the post-apply `node -e` printed
`stale absent: true/false` and exited 0 regardless; the rollback used
`test … && echo OK || echo MISMATCH`, which **exits 0 even on mismatch**. A verifier that
cannot fail is not a gate.

## What r11 changes (every item = executable, exits nonzero on mismatch)
1. **Post-apply verify → hard assertions, nonzero exit.** A `node` verifier asserts and
   `process.exit(1)` on any failure; the shell wrapper checks `PIPESTATUS[0]` and aborts →
   roll back. No boolean-print success path.
2. **Rollback → hard-fail on hash AND mode.** `test "$RB_SHA" = "$PRE_SHA" || { echo …; exit 1; }`
   and the same for mode. The `|| echo MISMATCH` success path is gone.
3. **Fire-time clean-exact-e6 precondition + script binding.** Before anything: assert the
   executing `scripts/deploy.mjs` blob === `60db298023cf3baa7749ea89829374e8045d783a`
   (e6:scripts/deploy.mjs), `git diff --quiet e6ae9b9 -- scripts/`, and a clean worktree; bind
   `DEPLOY="$WT/scripts/deploy.mjs"`. Docs-only commits on top of e6 are allowed (code blobs
   unchanged); the binding is to the code, not the HEAD sha.
4. **Immediate PRE recheck.** After backup, right before apply, re-hash live settings and assert
   it STILL equals `PRE_SHA` + `PRE_MODE` (nothing changed underneath). Hard-fail otherwise.
5. **Exact assertions.** dashboard bridge set === `[expectedTarget]` exactly (exactly once);
   `dashboard-flows-anthropic-bridge` === `expectedPlugin`; no `dashboard-*` plugin value outside
   `releaseRoot`; unrelated state (masked) byte-identical to PRE; mode === PRE_MODE (644).
   `expectedTarget`/`expectedPlugin` are derived the same way `registerBridge` derives them
   (`releaseRoot = realpathSync(prodRoot/current)`), confirmed own-hand.
6. **Sibling-temp atomic rollback + receipt schema.** Rollback writes a same-directory temp,
   JSON-validates, `chmod`, `renameSync` (never plain `cp`). Both phases emit a machine-checkable
   **receipt** (schema in the plan); a FAIL exits nonzero *before* the receipt is emitted.

## Own-hand proof the verifier actually hard-fails
See `r11-verifier-hardfail-proof.txt` — the exact post-apply check logic run against a temp
fixture (never live settings): a correct post-state → `PASS` / exit 0; a post-state with the
stale bridge still present → `FAIL` / exit 1 (caught `stale` + `target`). This is the
empirical proof of the property Pete blocked on: nonzero exit on mismatch.

## Holds (unchanged)
No live settings mutation, no `--register-bridge-only` against real prod-root, no restart, no
deploy, no push, no operator surface, no door-2/3 interleaving. Does NOT repair already-running
sessions. Live apply remains Lane-gated, executed by CommsLayer/Lane (Pete verifies only).
