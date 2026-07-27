# AMENDMENT dl-12308 — recheck package (four defects fixed, originals preserved)

Pete blocked the dl-12247 package (`dl-12308`) with four bounded defects. This is the recheck. The
original commits and their evidence are **preserved untouched**; this amendment sits **on top** so review
can diff what changed.

- **Original commits (parents, unchanged):** sidecar `8fd473a`, dashboard `e65ca1c`.
- **This is a build package for review — NOT a privacy-clear and NOT a quality-clear.** Pete's block
  stands until Pete rechecks.
- **Boundaries held throughout:** no deploy, no device test, no real ASR backend, no operator contact,
  one Claude Code session, no fan-out. Live repos + prod read read-only.

Read alongside: `mutation-log.md` (this dir), the original `../EVIDENCE.md` / `../TELEMETRY.md` /
`../ROLLBACK.md`, and the sidecar-side copies under
`pi-config …/voice-input/telemetry-evidence/`.

---

## 0. The two findings that matter most (stated with weight, not tidied away)

### 0a. Supervisor verification failure (preserved, not corrected)

The dl-12247 E2E **synthesized** both POSTs — it hand-built the sink body and the transcribe body via
`fastify.inject`, so the "chain proof" was a claim about a hand-written payload, not about the client's
real `emit`/`drain`. The supervisor certified that package's **verdict file** (`e2e-chain-verdict.json`)
**without reading the test that produced it**.

The lesson, for the next reader: **a verdict file is a claim ABOUT a test; only the test is a claim about
the system.** A green verdict reviewed at the wrong level is not evidence. This is recorded as a stated
limitation of the original package, not edited out of it. D4 (below) closes it: the E2E now invokes the
real client path, and its **mutation** — not its green run — is the proof (breaking `drainOnce`'s ack
parse drops the E2E to `pass:false`, which is only possible if the real drain is genuinely running).

### 0b. The sentinel false-green (a load-bearing test broken in the reassuring direction)

The privacy test was the load-bearing test — the entire structural-privacy argument rested on it — and it
was **silently broken toward passing**. The Python sentinel contained a non-ASCII `ΩΩ`, and `to_json`
serialises with `ensure_ascii=True`. So a **real transcript leak** would serialise as escaped `ΩΩ`
while the assertion searched for the raw `ΩΩ` character: **the test would have gone green WHILE LEAKING.**
The failure is invisible at exactly the layer everyone reads. Same class as 0a, one level deeper — the
assertion measured its *label*, not what it *recorded*. Found in my own suite before shipping, disclosed,
and fixed by making the sentinel ASCII-only so detection is honest in both escaping modes. (No non-ASCII
sentinel remains; verified by grep.)

---

## 1. The four defects and their fixes

| # | Defect (Pete dl-12308) | Fix | Files |
|---|---|---|---|
| D1 | The **leading zero-POST branch** — the unhealthy/stale health-gate — emitted nothing (button natively disabled OR onClick silent-returned). The primary suspected incident cause was invisible. | Health gate is now a **JS refusal**, not a native disable: `disabled` reflects only the consumer prop; a click while unhealthy mints an id and `emit`s `no_post{reason:"sidecar_unhealthy_gate"}` **before** returning. Accessibility preserved with `aria-disabled` + dimmed styling (announced unavailable, still clickable). | `PushToTalkButton.tsx`, `telemetry.ts` (enum) |
| D2 | **Drain race / state loss** — a concurrent emit was stale-overwritten (id-2 lost); seq/entries could desync; degraded reverted; sendBeacon=false treated as handled. | **Single atomic state blob** (seq+entries+overflow+degraded, one `setItem`); drain **re-reads current state after the await** and removes only acked keys; **serialised drains**; **sticky degraded**; quota fallback never reverts to a stale on-disk blob; **sendBeacon=false falls through to fetch**. | `telemetry.ts` |
| D3 | **Privacy hole (the serious one)** — sanitise at PERSIST but trust the buffer on the WIRE, so a poisoned buffer transmitted transcript/audio. | Treat the stored record as **untrusted on the way OUT**: `toWire` **re-sanitises** (covers drain + beacon). **Strict validation at all three ingresses** (token/enum/MIME/numeric) — client `sanitize`, dashboard `sanitizeRecord` + `resolveRequestId` header, sidecar `_sanitize` + `resolve_request_id`. Non-conforming values **dropped**, not truncated; invalid ids **re-minted**. | `telemetry.ts`, `telemetry-sink.ts`, `index.ts`, `_telemetry.py` |
| D4 | The **E2E synthesized the POST** — chain proof did not prove the chain; 5s health poll floods the receipt record. | E2E **rebuilt** to invoke the **real** client `emit`/`drain` (Node localStorage shim, listening Fastify server, real `fetch`, no `inject`); distinctness via **two real transcribe ids**. Sidecar **receipt scoped to exclude `/health`**. | `e2e/…chain.e2e.ts`, `_serve.py` |

---

## 2. Full mutation table — red-then-green per property (Pete B)

Green means something only because breaking the real implementation turns the guarding test RED. Full
detail (with the exact source mutation per row) is in `mutation-log.md`. Summary:

| Property | Mutation of real source | Under mutation | On revert |
|---|---|---|---|
| D1 health-gate observable | onClick gate → silent `return` (no emit) | RED (gate test) | GREEN 10/10 |
| D2a drain re-read+merge | drainOnce after-await → stale snapshot | RED | GREEN |
| D2b serialised drains | drain → unserialised `drainOnce` | RED | GREEN |
| D2c sticky degraded | writeState catch → drop `stickyDegraded=true` | RED | GREEN |
| D2d beacon fall-through | beaconUnload → `return true` (skip fetch) | RED | GREEN |
| D3a re-sanitise on wire | toWire → strip-only (no sanitize) | RED | GREEN |
| D3b client token validation | sanitize request_id → truncate-only | RED | GREEN |
| D3c dashboard token validation | sanitizeRecord request_id → truncate-only | RED | GREEN |
| D3d sidecar field validation | _sanitize → keep string fields unvalidated | RED | GREEN |
| D3e sidecar header validation | resolve_request_id → accept-any truncate | RED | GREEN |
| D4 real assembled chain | drainOnce → ignore server ack body | RED (E2E pass:false, drain_confirmed:0, buffer_after:2) | GREEN (pass:true) |
| D4b receipt scoping load-bearing | `_serve.py` is_health_poll = False | RED | GREEN |

**A mutation that fails to go red is itself a finding** (§0 discipline): my **first** D2 sticky mutation
(single-site in `readState`) did **not** turn the sticky test red — stickiness is enforced
defence-in-depth in more than one place. I re-targeted the actual set-site (`writeState` catch), which
does, and recorded *why* rather than quietly reporting only the successful mutation. It means the property
lives in more than one place, and the evidence now says so.

---

## 3. Case lists + results (fresh, this recheck)

Full verbose logs in this dir: `vitest-verbose.txt` (TS), `pytest-verbose.txt` (Python). E2E verdict +
human trace: `e2e-real-chain-verdict.json`.

- **TypeScript (plugin): 70 passed / 3 files.** PushToTalkButton 10 (7 original + 3 D1); client-telemetry
  43 (D2 + D3 hostile added); telemetry-sink 17 (D3 hostile added).
- **Python (sidecar): 35 passed / 4 skipped.** test_telemetry 20 (D3 hostile + D4 receipt-scope added);
  test_serve 4 pass / 2 skip; test_voice_input 11 pass / 2 skip. Skips are pre-existing
  latency/backend-absent gates, not mine.
- **E2E assembled chain: pass:true** via the REAL client path. Trace:
  `persist-first 2 → drain confirmed 2 → buffer after ack 0`; dashboard client-layer ids `[A,A]`; proxy
  ids `[A,A,B,B]`; sidecar `A:[receipt,transcribe] B:[receipt,transcribe]`; distinct ids `{A,B}` (no
  `/health` noise); transcript absent.

---

## 4. Invariant manifest — BY HASH (unchanged through D1–D4)

Frozen pre-state to preserve: **pi-config** HEAD `e765775…` / branch `fix/recompose-per-message-binding`
/ **158** dirty; **pi-agent-dashboard** HEAD `713cf76…` / branch `stage3-hardening-2026-07-05` / **9**
dirty. **Measured after D1–D4 (unchanged):**

| Repo | HEAD | Dirty | Match |
|---|---|---|---|
| pi-config (live) | `e765775` | 158 | ✅ |
| pi-agent-dashboard (live) | `713cf76` | 9 | ✅ |

Live files I edit in the worktrees remain **byte-identical to their HEAD blobs in the live trees** (my
work never leaked to live):

| Live file | HEAD blob sha1 | Match |
|---|---|---|
| pi-config `…/_serve.py` | `69fc58a0027b64b7f4900477e9598ea4a5eba4ce` | ✅ |
| pi-config `…/_voice.py` | `276778e28cd968fefb936c348b6c548096ace915` | ✅ |
| dashboard `…/PushToTalkButton.tsx` | `dccf55a360ca9a8209ed649682cdf221260280b5` | ✅ |
| dashboard `…/server/index.ts` | `ff956951fb7a5c30564b25c327bb012df4951755` | ✅ |

Prod release (`~/.pi-dashboard-prod`): `voice-input-plugin` tree sha256
**`ea014fd8da223ef75c3d3fefa2f149f8962b6acfa8fdf7bfc51bdfd155e2156f`** — **identical** to the dl-12247
value; still contains **no** `voiceTelemetry` (un-instrumented, nothing deployed).

---

## 5. Rollback

The dl-12247 `../ROLLBACK.md` still applies (additive, response-byte-identical, discard-the-worktree is a
live no-op). Amendment-specific delta:

- The amendment is **commits on top of** `8fd473a` (sidecar) and `e65ca1c` (dashboard); reverting the
  amendment commit returns to the dl-12247 package exactly. The originals are never rewritten.
- New/changed surface in the amendment is confined to: `PushToTalkButton.tsx`, `telemetry.ts`,
  `telemetry-sink.ts`, `index.ts` (dashboard) and `_serve.py`, `_telemetry.py` (sidecar), plus tests and
  this evidence. Response bodies and public props remain unchanged (health gate keeps `aria-disabled`; the
  only wire additions remain the `X-Voice-Request-Id` header + the separate `/telemetry` route).
- `git revert <amendment-sha>` on each branch is the clean back-out; the dl-12247 suites + E2E were green
  at `8fd473a`/`e65ca1c` and remain the fallback.

---

## 6. Disposition

Instrumentation-ready and defect-rechecked, **not** defect-reproduced (the 4 Python skips mean the sidecar
telemetry is still proven by unit+integration only, never against live Parakeet/Whisper — where the
decode-to-zero defect actually lives). **No privacy-clear or quality-clear claimed.** Frozen for Pete's
recheck.
