# CC build-muscle report — Stream-2 **D** FIX-CYCLE 1 (Concourse-4 dl-5825 D-gate FAIL → fixed)

**Status: fixes applied, gate-ready. UNCOMMITTED at bc0f91b.** Supervisor = Bastion. Zero add/commit/push.
Addresses the dual cross-family verdict: BLOCKER-1 + MAJOR-1 + MINOR-1 (all required) + MINOR-2 (optional, documented).

---

## 1. What changed this cycle (delta on top of the original D slice)

| Finding | Fix | File(s) |
|---|---|---|
| **BLOCKER-1** — WS `send_prompt` (primary co-drive) bypassed N=2 | thread `sessionId`+`operatorSet` into the self-gated `send_prompt` gate (admission-first, before bridge forward) + the :266 reload / :303 prompt-command / :338 resume gates | `session-action-handler.ts` |
| **MAJOR-1** — slot-leak: freed only via presence-view path | free the slot on LAST-socket-close INDEPENDENT of presence; new `sessionsAdmitted(sub)` reverse-lookup + last-socket guard; removed the premature unview-release | `operator-set-tracker.ts`, `browser-gateway.ts` |
| **MINOR-1** — flag-off stale `agentSource` | `resetAgentPresence()` in the flag-off `else` | `server.ts` |
| **MINOR-2** (optional) — ui_management READ not admission-bound | documented (reads aren't the WRITE surface N=2 bounds; mutations DO thread admission; forged fail-closed) | `ws-session-gate.ts` |

**`git diff --stat bc0f91b` (10 modified + 2 new untracked):**
```
 packages/server/src/agent-presence.ts              | 86 ++++++-----   (unchanged from D)
 packages/server/src/browser-gateway.ts             | 44 ++++++       (MAJOR-1 close-release + unview-release removal)
 packages/server/src/browser-handlers/handler-context.ts | 10 ++     (unchanged from D)
 packages/server/src/browser-handlers/session-action-handler.ts | 24 ++++  (BLOCKER-1 — 4 gates × sessionId+operatorSet)
 packages/server/src/rest-session-gate.ts           | 28 ++++         (unchanged from D)
 packages/server/src/routes/session-routes.ts       |  8 ++          (unchanged from D)
 packages/server/src/server.ts                      | 35 ++++         (MINOR-1 resetAgentPresence else)
 packages/server/src/session-api.ts                 |  9 ++          (unchanged from D)
 packages/server/src/session-authz.ts               | 54 +++++++      (unchanged from D)
 packages/server/src/ws-session-gate.ts             | 13 ++          (MINOR-2 read-exemption comment)
 10 files changed, 290 insertions(+), 21 deletions(-)
 NEW: operator-set-tracker.ts (+ sessionsAdmitted), __tests__/stream2-d-admission.test.ts (+ Test 8/9)
```

**Contract-3 — the shared `session-action-handler.ts` (A+B landed message-flow hunks) touched surgically.**
The ONLY code added is 8 lines = 4 gates × `{sessionId, operatorSet}` spread props (verified own-hand:
non-comment added lines are exactly `...(msg.sessionId ? …)` / `...(ctx.operatorSet ? …)`). Zero
`deriveAuthor` / `MessageAuthor` / `resumeAuthor` / `<speaker>` / reconciliation code changed — disjoint
from the author/message-flow hunks.

---

## 2. Gates

- **`npm run lint` (tsc): 10 = baseline, line-normalized set IDENTICAL, ZERO NEW.** Zero tsc in any D file.
- **D-suite `stream2-d-admission.test.ts`: 19/19 GREEN** (14 original + 5 new: Test 8 ×3 send_prompt
  admission, Test 9 ×2 socket-close release). `_build/redarm-evidence/fix1-all-GREEN-restored.log`.
- **Full suite (`vitest run --no-file-parallelism`): 10 failed | 6033 passed | 17 skipped.**
  - The 9 deterministic baseline reds (`no-direct-process-kill` = pre-existing `driver-liveness.ts:65`,
    `worktree-manager`, `ChatView`×2) — **zero overlap with D's files**, all pre-existing.
  - **+1 = `MarkdownContent.test.ts > renders fenced code block with syntax highlighter`** — a CLIENT
    React/markdown test, **load-flaky** under parallel contention: **PASSES 42/42 in ISOLATION** (proven
    own-hand). My diff touches ZERO client files (mechanically verified) → not a D regression.
  - **Zero of the failures are in D's edited files; my new D suite is GREEN.** No A/B regression from the
    shared-file change.
- **flag-off byte-unchanged — re-confirmed.** The `authorizeSessionAction` flag-off early-return
  (`session-authz.ts:376`) PRECEDES the admission block, so the new send_prompt admission threading is INERT
  flag-off. The build1b `handleSendPrompt` handler-arm test stays GREEN.

---

## 3. The 2 NEW red-arm bites (each proven GREEN → planted-RED → restored-GREEN, sha256 byte-identical)

Restore verified byte-identical: `session-action-handler.ts` `8a6d617…`, `operator-set-tracker.ts`
`c75e2e0…` (pre = post).

| Bite | Test | Plant (the exact regression) | RED evidence | Failing assertion |
|---|---|---|---|---|
| **8 (BLOCKER-1)** | Test 8 — send_prompt admission via `handleSendPrompt` | revert the :236 `sessionId`/`operatorSet` threading | `redarm-evidence/bite8-BLOCKER1-RED.log` | cell never fills (`+0 to be 2`); **3rd sub's prompt REACHES the bridge** (`length +0 but got 1`); dedup broken — all 3 fail |
| **9 (MAJOR-1)** | Test 9 — last-socket-close release | neuter `sessionsAdmitted` → `[]` | `redarm-evidence/bite9-MAJOR1-RED.log` | write-admitted slot LEAKS (`2 to be 1`) → fresh 3rd human refused; one-of-two-tabs guard also bites |

Bite 8 is the exact coverage gap the cross-family arm caught: driving admission through the SELF-gated
`send_prompt` seam (not `abort`). With the fix reverted, a 3rd distinct human's raw co-drive prompt reaches
the bridge despite a full cell — the BLOCKER-1 defeat — and the test now catches it.

The 7 original D bites remain valid (unchanged files); this cycle adds the 2 that close the gap.

---

## 4. MAJOR-1 mechanism chosen (flagged per directive)

**Free on last-socket-close, presence-independent, via a tracker reverse-lookup.**
- Added `operator-set-tracker.sessionsAdmitted(sub): string[]` (reverse lookup: every session admitting `sub`).
- On `ws.on("close")` (`browser-gateway.ts`): capture the closing `sub`; scan the remaining `principals` for
  another live socket of the SAME `sub`; if NONE, `release` it from EVERY session `sessionsAdmitted` returns.
  This is independent of `session_view` — a WRITE-admitted-never-viewed human's slot now frees on disconnect.
- **Removed the premature `session_unview` operator-release** (it was a bug: un-viewing while still
  socket-connected would cost a still-connected co-driver their seat and let a 3rd human bump them). Admission
  is WRITE-based; the slot frees on last-socket-close, NOT view-change. Presence (view-based) still updates on
  unview.
- **Residual (documented):** a PURE-REST-only admit (no socket ever) is still freed only by the
  `broadcastSessionRemoved → clearSession` leak-guard (bounded — cannot outlive the session). A per-`sub` TTL
  remains the optional cleaner follow-up; deliberately not built to keep the cell a simple, testable primitive.
  **Bastion gates whether the TTL is wanted this cycle.**

---

## 5. Discipline
- **propose-before-LAND** — HEAD still `bc0f91b`, index clean, nothing staged/committed/pushed.
- **NOS §3** — no AI-attribution anywhere.
- All 4 gate calls thread admission-first; the 3 operator-only gates (:266/:303/:338) are idempotent for a
  member already admitted at :236 and refuse a non-member `session-full` at admission before operator-only.

**Bastion — D fix-cycle 1 complete, gate-ready.** Reproduce the 2 new bites own-hand, then hand back to
Concourse-4 for the re-gate (new perturbation).
