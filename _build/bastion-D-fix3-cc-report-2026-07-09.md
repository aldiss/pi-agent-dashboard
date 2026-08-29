# CC build-muscle report — Stream-2 **D** FIX-CYCLE 3 (TEST-ONLY, close the PASS-WITH-NIT) — **FROZEN**

**Status: fix-3 complete, gates pass, worktree FROZEN. UNCOMMITTED at bc0f91b.** Supervisor = Bastion.
TEST-ONLY: zero production edits. Closes the dl-6314 NIT — Test 9 drove a LOCAL copy of the ws.close logic;
fix-3 adds a REAL-SEAM integration test (Test 12) that drives the ACTUAL `browser-gateway.ts` ws.close →
`operatorSet.release`, red-armed by neutering the real gateway release loop.

---

## 1. What changed (TEST-ONLY)

**One new test block — Test 12 — appended to `stream2-d-admission.test.ts`.** Test 9 (the unit-level helper
mechanism test) is KEPT intact alongside it, per directive.

Test 12 drives the REAL seam end-to-end:
1. Real `createBrowserGateway(...)` wired with a REAL `createOperatorSetTracker()` (the SAME instance the test
   asserts on), flag-ON (`requireBrowserAuth=true`).
2. op-2's principal bound at the REAL connection seam (`gateway.wss.emit("connection", ws, {wsPrincipal})` —
   the exact `req.wsPrincipal` path the `/ws` upgrade uses, `browser-gateway.ts:351`).
3. op-2 ADMITTED through the REAL `send_prompt` handler (`ws.emit("message", …)` → `handleSendPrompt` →
   `authorizeSessionAction` → commit), on a LIVE session → asserts `operatorSet.count(sid)===1`, op-2 member.
4. The ACTUAL gateway close fired (`ws.emit("close")` → the real `:781-820` handler → release loop `:809-819`)
   → asserts the slot freed (`count` dropped, op-2 not a member, a fresh 3rd now admittable).
5. Last-socket guard over the REAL seam: two sockets of the SAME sub — closing ONE does NOT free (the real
   `hasOtherSocket` scan), closing the LAST does.

**`git diff --stat bc0f91b`:** production files **byte-identical to fix-2** (10 files, 350+/21−, sha256-
verified) — only the untracked test file grew (Test 12 + its harness).
```
 (production, unchanged since fix-2 — every sha256 matches:)
 agent-presence.ts 86 · browser-gateway.ts 44 · handler-context.ts 10 · session-action-handler.ts 24
 rest-session-gate.ts 28 · routes/session-routes.ts 8 · server.ts 35 · session-api.ts 9
 session-authz.ts 114 · ws-session-gate.ts 13   →  10 files, 350 insertions(+), 21 deletions(-)
 NEW untracked: operator-set-tracker.ts (fix-2), __tests__/stream2-d-admission.test.ts (+ Test 12 this cycle)
```

**Contract-3** — Test 12 exercises the presence/session-state seam ONLY (ws.close → operatorSet.release); no
message-flow / author / attribution touched. It sends a `send_prompt` purely to admit op-2 through the real
path; it asserts nothing about the forward.

---

## 2. Gates

- **`npm run lint` (tsc): 10 = baseline, IDENTICAL set, ZERO NEW.**
- **D-suite `stream2-d-admission.test.ts`: 27/27 GREEN** (25 fix-2 + Test 12 ×2). `_build/redarm-evidence/fix3-all-GREEN-restored.log`.
- **Full suite (`vitest run --no-file-parallelism`): 9 failed | 6042 passed | 17 skipped** — the 9 are EXACTLY
  the deterministic baseline (`no-direct-process-kill`=pre-existing `driver-liveness.ts:65`, `worktree-manager`,
  `ChatView`×2); **zero D-file/D-suite failures**, no client flake this run. Cleanest posture yet (baseline-9 only).
- **All 11 production files byte-identical to fix-2** (sha256, before AND after the red-arm neuter/restore).

---

## 3. The red-arm — proves Test 12 guards the REAL seam (the whole point)

Plant: neuter the REAL gateway release loop (`browser-gateway.ts` ws.close `:809-819` — comment out
`operatorSet.release(sessionId, closingSub)`). Run BOTH tests:

| Test | Under neutered real gateway | Meaning |
|---|---|---|
| **Test 12 (real seam)** | **RED** — `expected 2 to be 1` (op-2's slot leaks on the actual `ws.close`); guard case `expected true to be false` | ✓ Test 12 DRIVES the real wiring — a regression there bites |
| **Test 9 (helper)** | **GREEN (2/2)** | ✓ confirms the NIT: the helper does NOT guard the real seam — exactly the gap fix-3 closes |

- RED evidence: `_build/redarm-evidence/fix3-test12-REALGATEWAY-NEUTERED-RED.log`
- Test-9-stays-green evidence: `_build/redarm-evidence/fix3-test9-helper-STAYS-GREEN-when-gateway-neutered.log`
- Restore: gateway byte-identical to fix-2 (sha256 `7aeaf24…`), full D-suite back to 27/27 GREEN.

This is the same proxy-test class as the original BLOCKER-1 (Test drove `abort`, not the real `send_prompt`
seam): the helper hid no defect but didn't regression-guard the DoS-prevention wiring. Test 12 now does.

---

## 4. Harness notes (own-hand)

- **Fake WS = `EventEmitter`** with `send`/`close`/`terminate`/`readyState` stubs → `ws.emit("close")` fires
  the REAL gateway close handler (not a copied helper). This is the canonical direct-gateway pattern already
  in the suite (`browser-gateway-snapshot-on-connect.test.ts`).
- **Admission via the real path:** a LIVE session (`sessionManager.register` sets `status:"active"`) so
  `handleSendPrompt` takes the co-drive forward branch (not ended→resume); the commit at
  `session-action-handler.ts:236` fires before the (stubbed) bridge forward, so op-2 lands in the cell.
- **`operatorUsers` unset:** operator-only enforcement stays inert, but `send_prompt` is co-drive → admission
  still commits op-2 (the cell fills), which is all Test 12 needs.
- **Async flush:** the gateway message listener is `async`; the harness awaits a `setTimeout(0)` so
  `handleSendPrompt` completes before asserting the commit.

---

## 5. FREEZE
Fix-3 complete, gates pass, all production files byte-identical to fix-2, worktree UNCOMMITTED at bc0f91b,
index clean. **I have STOPPED editing the worktree.** Bastion reproduces the red-arm own-hand (neuter the real
gateway release → Test 12 RED, Test 9 GREEN), then hands the FROZEN tree to Concourse-4 for the CONTAINED
re-verify.

**Bastion — fix-3 done, FROZEN.**
