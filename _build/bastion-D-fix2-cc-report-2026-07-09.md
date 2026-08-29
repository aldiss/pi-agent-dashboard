# CC build-muscle report — Stream-2 **D** FIX-CYCLE 2 (Concourse-4 arm-(b) MAJOR-2 + folds) — **FROZEN**

**Status: fix-2 complete, gates pass, worktree FROZEN. UNCOMMITTED at bc0f91b.** Supervisor = Bastion.
Zero add/commit/push. Addresses arm-(b): MAJOR-2 (commit-then-refuse REST slot-strand) + MINOR-3 (fail-closed
on absent sessionId) + NIT (member/count not an allow-input). One design tension surfaced + Bastion-gated
mid-cycle (spawn exemption, below).

---

## 1. What changed this cycle (delta on fix-1)

| Finding | Fix | File(s) |
|---|---|---|
| **MAJOR-2** — `tryAdmit` MUTATED at admission-first, then a later operator-only refusal stranded the slot (REST-only → locked out op-2 for the session) | **check-then-commit**: split `tryAdmit` → `canAdmit` (non-mutating) + `commit` (the only mutation); `canAdmit` at admission-first, `commit` ONLY on the allowed path (before final `return {allowed:true}`) → a refused action strands nothing | `operator-set-tracker.ts`, `session-authz.ts` |
| **MINOR-3** — flag-ON + operatorSet threaded + human + sessionId ABSENT was SKIPPED (a caller opting into admission with no sessionId = inconsistency) | **fail-closed** (refuse `session-full`) instead of skip; the fully-opt-out path (no operatorSet) still SKIPPED (byte-unchanged) | `session-authz.ts` |
| **NIT** — `member`/`count` must not become an authz allow-input (union risk) | `member` used ONLY for `needsCommit` (commit-vs-skip); `count` doc'd DIAGNOSTIC/test-only; intersection red-arm (Test 4) kept green + strengthened | `operator-set-tracker.ts`, test |
| **spawn exemption** (net-new, Bastion-gated mid-cycle — see §4) | MINOR-3 fail-closed EXEMPTS session-CREATING actions (`SESSION_CREATING_ACTIONS={spawn}`): `spawn` has no sessionId by nature → skip admission, fall through to operator-only | `session-authz.ts` |

**`git diff --stat bc0f91b` (10 modified + 2 new untracked):**
```
 packages/server/src/agent-presence.ts              |  86 ++++  (fix-1, unchanged)
 packages/server/src/browser-gateway.ts             |  44 ++++  (fix-1, unchanged)
 packages/server/src/browser-handlers/handler-context.ts | 10 ++ (fix-1, unchanged)
 packages/server/src/browser-handlers/session-action-handler.ts | 24 ++ (fix-1, unchanged)
 packages/server/src/rest-session-gate.ts           |  28 ++   (fix-1, unchanged)
 packages/server/src/routes/session-routes.ts       |   8 ++   (fix-1, unchanged)
 packages/server/src/server.ts                      |  35 ++   (fix-1, unchanged)
 packages/server/src/session-api.ts                 |   9 ++   (fix-1, unchanged)
 packages/server/src/session-authz.ts               | 114 +++  (fix-2: check-then-commit + MINOR-3 + spawn exempt)
 packages/server/src/ws-session-gate.ts             |  13 ++   (fix-1, unchanged)
 10 files changed, 350 insertions(+), 21 deletions(-)
 NEW: operator-set-tracker.ts (canAdmit+commit split), __tests__/stream2-d-admission.test.ts (Test 10/11 + strengthened Test 4)
```

**Contract-3** — fix-2's substantive change is confined to `session-authz.ts` (chokepoint) + `operator-set-tracker.ts` (the cell). `session-action-handler.ts` is UNCHANGED from fix-1 (admission-threading only; zero author/message-flow/speaker/reconciliation hunks — grep-verified).

---

## 2. Gates

- **`npm run lint` (tsc): 10 = baseline, line-normalized set IDENTICAL, ZERO NEW.** Zero tsc in any D file.
- **D-suite `stream2-d-admission.test.ts`: 25/25 GREEN** (19 fix-1 + Test 10 ×2 MAJOR-2 + Test 11 ×4 MINOR-3
  incl. spawn-exemption; Test 4 strengthened). `_build/redarm-evidence/fix2-all-GREEN-restored.log`.
- **Full suite (`vitest run --no-file-parallelism`): 10 failed | 6039 passed | 17 skipped.**
  - **`build1b-rest-coverage` (the fix-2 interaction) CLEARED** — was 2/5 failing on the spawn strand, now 5/5.
  - The 9 deterministic baseline reds (`no-direct-process-kill`=pre-existing `driver-liveness.ts:65`,
    `worktree-manager`, `ChatView`×2) + **1 rotating client flake** (`chat-input-images-integration` this run;
    `MarkdownContent` last run) — **both proven to PASS isolated** (4/4, 42/42), load-contention only.
  - **Zero D-file failures.** D touches ZERO client files (mechanically verified).
- **flag-off byte-unchanged — re-confirmed.** `canAdmit`/`commit` run only past the flag-off early-return.

---

## 3. Red-arm bites (each GREEN → planted-RED → restored byte-identical → GREEN)

Restore verified byte-identical: `session-authz.ts` `455e1b9…`, `operator-set-tracker.ts` `281f31f…`,
`session-action-handler.ts` `8a6d617…`.

### New this cycle
| Bite | Test | Plant | RED evidence | Failing assertion |
|---|---|---|---|---|
| **10 (MAJOR-2)** | Test 10 — refused REST action strands no slot | commit AT admission (mutate-at-admission, pre-fix bug) | `redarm-evidence/bite10-MAJOR2-RED.log` | op-3's 403'd shutdown strands a slot → op-2 refused (`2 to be 1`); refusals accumulate (`2 to be +0`) |
| **11 (MINOR-3)** | Test 11 — fail-closed on absent sessionId | guard `&& sessionId` (skip-when-absent) | `redarm-evidence/bite11-MINOR3-RED.log` | send_prompt w/ no sessionId allowed (`true to be false`) |
| **12 (spawn exempt)** | Test 11 — spawn exemption | drop `spawn` from `SESSION_CREATING_ACTIONS` | `redarm-evidence/bite12-MINOR3-spawn-exempt-RED.log` | op-2 spawn → `session-full` not `operator-only` |

### Prior bites re-confirmed against the refactored tracker (directive requirement)
All still bite post-refactor (the plant target moved for some — noted):
- **Test 1 (N=2 cap/dedup)** — plant: per-connection key in the new `commit` (both branches) → `2 to be 1`. ✓
- **Test 4 (union)** — **strengthened** (test-only): op-2 now becomes a genuine COMMITTED member via a prior
  co-drive BEFORE attempting operator-only (under check-then-commit, op-2 is not a member of the refused
  action itself, so the faithful union test must pre-commit). Plant: union `isMember`-inherits → `true to be
  false`. ✓
- **Test 5 (service→operator-only)** — plant: service short-circuit allow → `true to be false`. ✓
- **Test 8 (send_prompt admission)** — plant: revert :236 threading → cell never fills / 3rd reaches bridge. ✓
- **Test 9 (MAJOR-1 socket-close)** — plant: neuter `sessionsAdmitted` → `2 to be 1`. ✓

---

## 4. The mid-cycle design tension I surfaced + Bastion gated (spawn exemption)

**MINOR-3's blanket fail-closed collided with the body-less `spawn` REST route** — the ONLY session-less
operator-only route. `/api/session/spawn` legitimately threads `operatorSet` (shared policy) + is human-
drivable + has NO `sessionId` (it CREATES a session). My initial MINOR-3 fired `session-full` for BOTH op-1
and op-2 on spawn → changed op-2's reason `operator-only`→`session-full` AND refused op-1's spawn (was
allowed) — deterministically breaking the landed `build1b-rest-coverage` (2/5).

I STOPPED and asked Bastion (did not guess). **Bastion gated: "Skip fail-closed for spawn action."**
Implemented as `SESSION_CREATING_ACTIONS = {spawn}` in the pure chokepoint: a session-CREATING action with no
sessionId is NOT the inconsistency MINOR-3 targets → admission SKIPPED → per-action operator-only still
refuses op-2, op-1 allowed. `resume` is session-scoped on REST (`/api/session/:id/resume`) → NOT exempt.
Pinned by Test 11's spawn-exemption case (bite 12) + `build1b-rest-coverage` back to 5/5.

---

## 5. Design decisions (own-hand)

- **check-then-commit shape:** `canAdmit(sessionId,sub):{admissible,member}` (pure) + `commit(sessionId,sub)`
  (idempotent add). The chokepoint records `needsCommit = admissible && !member` at admission-first, and the
  SINGLE `commit` fires immediately before `return {allowed:true}` — every refusal (`session-full` /
  `unclassified` / `operator-only`) returns before it, so no refused action mutates the cell.
- **`commitSub` local:** captured inside the `actor.kind==="human"` narrowing so the deferred commit needs no
  re-narrow (avoids a TS union error; never touches a service actor's shape).
- **NIT honored:** `member` drives only commit-vs-skip; `count` doc'd DIAGNOSTIC/test-only; no membership→allow
  path (intersection stays intersection — Test 4).
- **Test 4 strengthened (test-only, flagged):** pre-commit op-2 via co-drive so the union red-arm is faithful
  under check-then-commit. No production change — the intersection guard is unchanged.

---

## 6. FREEZE
Fix-2 complete, my gates pass, worktree UNCOMMITTED at bc0f91b, index clean. **I have STOPPED editing the
worktree.** Bastion reproduces the MAJOR-2 bite own-hand, then hands the FROZEN tree to Concourse-4 for the
re-gate (new perturbation).

**Bastion — fix-2 done, FROZEN.**
