# CC build-muscle report — Stream-2 **D**: bounded 2-operator cell (N=2) + intersection + agent-as-presence

**Status: gate-ready. UNCOMMITTED at bc0f91b.** Build session = CC build-muscle; supervisor = Bastion.
Zero `git add`/commit/push/merge performed. Propose-before-LAND honored.

---

## 1. Files changed (`git diff --stat` off `bc0f91b`) — Contract-3 confirmed

**Modified (9):**
```
 packages/server/src/agent-presence.ts              | 86 +++++-----   (3.3 fill)
 packages/server/src/browser-gateway.ts             | 26 ++++         (cell wiring + release hooks)
 packages/server/src/browser-handlers/handler-context.ts | 10 ++     (ctx.operatorSet)
 packages/server/src/rest-session-gate.ts           | 28 ++++         (REST arm admission)
 packages/server/src/routes/session-routes.ts       |  8 ++          (retire gate wiring)
 packages/server/src/server.ts                      | 29 ++++         (one cell instance + agent-presence config)
 packages/server/src/session-api.ts                 |  9 ++          (REST deps wiring)
 packages/server/src/session-authz.ts               | 54 ++++++       (admission-first at chokepoint)
 packages/server/src/ws-session-gate.ts             |  6 ++          (WS arm admission)
 9 files changed, 235 insertions(+), 21 deletions(-)
```
**New untracked (2):**
```
 packages/server/src/operator-set-tracker.ts                    (3.1 cell primitive)
 packages/server/src/__tests__/stream2-d-admission.test.ts      (the D red-arm suite)
```

**Contract-3 disjointness — VERIFIED.** The diff touches ONLY authz / session-state hunks + the one
`getAgentPresence` body fill + the test. Mechanical grep over the changeset for
`author|attribut|speaker|reconcil|queue|reducer|message-flow|prompt-bus|send-prompt` → **zero matches**.
No message-flow / `author` field / attribution / `<speaker>` wrap / reconciliation / queue / reducer touched
(that is Stream-1 {A→B}, untouched).

---

## 2. `npm run lint` (tsc --noEmit) — ZERO NEW over baseline

- Baseline = **10** pre-existing errors (`_build/bastion-D-baseline-tsc-2026-07-09.txt`): 7 client
  (`App.tsx`×3, `CommandInput.tsx`, `MobileComposer.tsx`×2, `useImagePaste.test.ts`) + 3 server
  (`browser-gateway.ts` ping-union ×1, `server.ts` dup `resurrectionSweepMs` ×2).
- **After D: 10 errors, line-normalized set IDENTICAL to baseline** (diff of `sed 's/(L,/…'`-normalized
  signatures = empty). The 2 server baseline errors shifted line number only (browser-gateway 501→510 from
  D's +9 lines; server.ts 122/152→123/153 from D's +1 import) — SAME errors, git-diff-provable pre-existing.
- **Zero tsc errors in any D file** (`session-authz.ts`, `operator-set-tracker.ts`, `agent-presence.ts`,
  `rest-session-gate.ts`, `ws-session-gate.ts`, wiring). ✓

## 3. vitest — D suite GREEN; full-suite failing set = baseline (ZERO NEW)

- **D suite `stream2-d-admission.test.ts`: 14/14 GREEN** (`_build/redarm-evidence/all-GREEN-restored.log`).
- **Full suite (`vitest run --no-file-parallelism`, per brief §1): 9 failed | 6029 passed | 17 skipped.**
  - The **9 = exactly the deterministic baseline** (Signet-reconciled). The **1 known-flaky**
    `build1b-ws-closure > op-2 WS shutdown REFUSED` **PASSED** under `--no-file-parallelism` (as the brief
    predicted). So failing set = baseline, **ZERO NEW**.
  - The 9 failing FILES: `no-direct-process-kill.test.ts` (pre-existing `driver-liveness.ts:65`
    `process.kill` — a file D never touched), `worktree-manager.test.ts`, `ChatView.test.ts`,
    `ChatView.streaming-text-flush.test.ts`. **Zero overlap** with D's 11-file changeset (mechanically
    verified). My new D test is NOT among failures.
  - None of the 9 touch authz / presence.

---

## 4. The 6 (+1) red-arm bites — each PROVEN to bite (GREEN → planted-RED → restored-GREEN)

Method per bite: suite GREEN → plant ONE-line violation in the production seam → run RED (captured) →
restore → **sha256 byte-identical to pristine** → suite GREEN. All 4 plant-target files verified
byte-identical to pristine after the run (`operator-set-tracker.ts` `c0ec397…`, `session-authz.ts`
`9e46207…`, `agent-presence.ts` `1c02e9e…`, `rest-session-gate.ts` `6d0ab2f…`).

| # | Test (in `stream2-d-admission.test.ts`) | Plant (seam) | RED evidence | Failing assertion |
|---|---|---|---|---|
| 1 | N=2 admission WS — 3rd sub refused; 2 tabs deduped | per-connection key in `tryAdmit` (`operator-set-tracker.ts`) | `redarm-evidence/bite1-RED.log` | `expected 2 to be 1` (2 tabs trip cap) |
| 2 | N=2 admission REST — 3rd sub refused via REST | drop `operatorSet` from `makeRestSessionGate` (`rest-session-gate.ts`) | `bite2-RED.log` | `expected undefined to be 403` (3rd REST allowed) |
| 3 | Composition order — admission BEFORE per-action | gate admission behind `actionClass≠operator-only` (`session-authz.ts`) | `bite3-RED.log` | `expected 'operator-only' to be 'session-full'` |
| 4 | Intersection (vs union) — op-2 refused op-1-only | UNION: admitted member inherits operator-only (`session-authz.ts`) | `bite4-RED.log` | `expected true to be false` (op-2 shutdown passed) |
| 5 | det-spawn-inherit — service can't satisfy operator-only | special-case service OUT of chokepoint (`session-authz.ts`) | `bite5-RED.log` | `expected true to be false` (service passed operator-only) |
| 6 | Flag-OFF byte-unchanged — admission inert | admission fires ABOVE flag-off early-return (`session-authz.ts`) | `bite6-RED.log` | `expected false to be true` / `cell 1 not 0` |
| 7 | Agent-as-presence — ended/unknown → null | drop `status==="ended"` guard (`agent-presence.ts`) | `bite7-RED.log` | dead `agent:dead` shows present (`… to be null`) |

Each is a green-that-CAN-go-red (no vacuous pass). Evidence dir: `_build/redarm-evidence/`.

---

## 5. Design decisions made own-hand (+ seams flagged)

### 5.1 operatorSet state-home + the seam design (§3.1)
- **New `operator-set-tracker.ts`** (sister to `session-presence-tracker.ts`): `Map<sessionId, Set<sub>>`,
  `OPERATOR_CELL_LIMIT=2`, pure `tryAdmit/isMember/release/clearSession/count/operatorsOf`. Distinct-`sub`
  dedup is inherent (a `Set` keyed by `sub`; two tabs = one slot). Refusal allocates nothing.
- **ONE seam, both arms.** I extended `AuthorizeSessionActionInput` with optional `sessionId?` +
  `operatorSet?` and did **admission-first INSIDE `authorizeSessionAction`** (the ONE chokepoint). WS
  (`ws-session-gate.ts`) and REST (`rest-session-gate.ts` — sessionId from `request.params.id`) BOTH thread
  the **same instance** (created once in `server.ts`, passed to the gateway + both REST gate policies). Not
  scattered; a 3rd distinct human cannot bypass a connection-only cap via REST.
- **Additive to C.** C's per-action operator-only logic is byte-unchanged; admission is a NEW block placed
  after the identity checks and before classification (Contract-2 / Joan pin 2: admission-FIRST).
- **Optional-by-design = byte-safe.** When `operatorSet`/`sessionId` are absent (the send-seam's own
  in-handler gate, the Build-1b unit tests), admission is SKIPPED — every existing caller is byte-unchanged.
  Flag-OFF returns `{allowed:true}` before admission is ever consulted.

### 5.2 admit/free lifecycle (§3.1 — DECISION, flag for Bastion gate)
**v1 chosen (recommended shape):** admit-on-authorized-write (a slot is taken the first time a distinct
`sub` passes admission). Freed on:
1. **last-socket-leave** — symmetric with the presence tracker. In `browser-gateway.ts` I release the `sub`
   at exactly the points the presence tracker reports the distinct-human set changed: `session_unview`
   (`leave` true) and `ws.close` (each session in `removeSocket(ws)`). I capture `principals.get(ws)?.sub`
   BEFORE `principals.delete(ws)` so the release keys correctly.
2. **session removal** — `broadcastSessionRemoved(sessionId)` calls `operatorSet.clearSession` (leak guard).

**Flagged residual for Bastion:** a **REST-only admit holds no persistent socket**, so it is freed ONLY by
the session-removal leak guard (#2), not by last-socket-leave (#1). This is bounded (cannot outlive the
session) and documented, but a long-lived session driven purely by a one-shot REST co-drive from a 3rd
identity could hold a slot until the session ends. If Bastion wants tighter REST bounding, the clean follow-up
is a per-`sub` TTL in the tracker (idle-evict) — deliberately NOT built in v1 to keep the cell a simple,
testable Set primitive. **Bastion gates the lifecycle choice.**

### 5.3 live-agent signal (§3.3)
- **Signal = `SessionManager.get(sessionId)` present AND `status !== "ended"`** (SessionStatus =
  `active|idle|streaming|ended`). This is the authoritative liveness bit already used across `server.ts`
  session-write branches (not fabricated). A `DashboardSession` IS "a dashboard session representing a
  connected pi instance" — the server-side registry of live agents.
- **Signature frozen.** `getAgentPresence(sessionId): PresenceParticipant | null` shape unchanged. To read
  the signal without changing the signature, I added a **narrow injected source**
  (`configureAgentPresence(source)`) wired in `server.ts` **only when `requireBrowserAuth` is ON**. Flag OFF /
  unconfigured → the B-era NO-OP (`null`) → presence humans-only, byte-unchanged (B's
  `surface-b-presence.test.ts` stays 7/7 GREEN).
- Agent id namespaced `agent:<sessionId>` (never collides with a human `sub`); display = `session.name` else
  a stable `"agent"`.

### 5.4 det-spawn-inherit (§3.4)
- A `service` actor is **NOT admission-counted** (the admission block is guarded by `actor.kind === "human"`)
  and (correctly) **still cannot satisfy operator-only** (C's unchanged service→operator-only refusal). Not
  special-cased out of the chokepoint — it rides the SAME `authorizeSessionAction`. Test 5 pins both halves.

---

## 6. Leftover / not-done (explicit)
- **No live config touched.** No op-2 enabled, no operator VALUES set, no OAuth configured (do-not-flip-live).
  Mechanism tested with principal fixtures (`op1/op2/op3@example.com`, distinct `sub` A/B/C).
- **UNCOMMITTED at `bc0f91b`.** No `git add`/commit/push/merge. Bastion gates; Joan lands.
- Baseline reds (the 9 + 1 flaky) left untouched (pre-existing / flaky, git-diff-provable).

**Bastion — D slice built, gate-ready.**
