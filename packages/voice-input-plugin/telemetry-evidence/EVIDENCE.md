# EVIDENCE (dashboard companion) — voice-input telemetry, Layers 1 & 2

This worktree (`voice/telemetry-dashboard-20260726`, from `713cf76`) holds the **client** (Layer 1) and
**dashboard proxy + sink** (Layer 2) of the three-layer telemetry package. The **canonical** evidence —
cross-cutting invariant manifest, both suites' case lists, the correlated END-TO-END chain, and the
storage-degraded disposition — lives in the primary (pi-config) worktree:

> `/private/tmp/voice-telemetry-daywright-20260726/pi-extensions/voice-input/telemetry-evidence/EVIDENCE.md`

**This is a build package for review — NOT a quality clear.** No deploy, no device test, no operator
contact. Live `pi-agent-dashboard` and `~/.pi-dashboard-prod` were read read-only; this worktree's edits
are byte-identical-to-HEAD in the live tree (proven in the canonical EVIDENCE §1b) — i.e. nothing leaked
to live.

## Files here
- `src/client/telemetry.ts` — local-first ring buffer (count+TTL bound, overflow counter), acknowledged
  drain (delivered only on 2xx **body-ack** of exact `(request_id, seq)`), `sendBeacon` unload backstop
  (never marks delivered), one-shot **degraded signal** on storage-unavailable.
- `src/client/PushToTalkButton.tsx` (M) — id at capture intent; lifecycle emits incl. every zero-POST
  branch (`blob<1024`, mic/permission error, queued-stop, no-navigator); `X-Voice-Request-Id` on the POST;
  drain-on-mount; unload beacon. Public props unchanged (`telemetryEndpoint?` optional w/ default).
- `src/server/index.ts` (M) — `/api/plugins/voice-input/telemetry` sink route; ingress/egress logging in
  the transcribe proxy; id forward + echo; envelope-level degraded/overflow logging. Response body
  byte-identical.
- `src/server/telemetry-sink.ts` — idempotent, **ack-after-side-effect**, sanitising sink.
- `src/__tests__/client-telemetry.test.ts` (22), `src/__tests__/telemetry-sink.test.ts` (14).
- `e2e/voice-telemetry-chain.e2e.ts` — the assembled-chain driver (drives the real proxy → real
  worktree-local sidecar).

## Local results (this worktree)
- `tsc --noEmit -p tsconfig.json` → **exit 0**.
- `vitest run` (HOME-guarded) → **43 passed (3 files)**. Full log: `telemetry-evidence/vitest-verbose.txt`.
- Assembled chain → **pass: true**, verdict saved: `telemetry-evidence/e2e-chain-verdict.json`.

Run:
```bash
cd /private/tmp/voice-telemetry-dashboard-daywright-20260726
npm install --no-audit --no-fund
cd packages/voice-input-plugin && HOME="$(mktemp -d)" ../../node_modules/.bin/vitest run --config vitest.config.ts
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
cd /private/tmp/voice-telemetry-dashboard-daywright-20260726 && HOME="$(mktemp -d)" node_modules/.bin/tsx e2e/voice-telemetry-chain.e2e.ts
```

See the canonical `EVIDENCE.md`, plus `TELEMETRY.md` and `ROLLBACK.md` (in the pi-config worktree) for
design, the privacy field table, and the revert path.
