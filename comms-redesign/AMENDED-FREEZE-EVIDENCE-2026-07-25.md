# Amended comms-layer freeze evidence — 2026-07-25

## Frozen scope

- Producer frozen baseline: `a5f06faff07446aeb4e16ef60faaac19c78bbdae`
- Producer amended head: `6ba787837d29275ab431db710f768f2a5ebacbfd`
- Dashboard frozen baseline: `f61b175dfedc131d052812f3c449069fda963721`
- Dashboard amended head: the commit containing this record on
  `fix/comms-reset-dashboard-2026-07-25`; its SHA is printed in the external
  freeze summary because a commit cannot contain its own SHA.

The frozen baseline commits were not rewritten. No deployment, live-tree write,
enablement change, publication, or go-live action was performed.

## Acceptance evidence

| Item | Disposition and green proof | Able-to-fail proof |
| --- | --- | --- |
| M1 — disabled herald fail-open | One grammar in `enabled-grammar.ts` drives config and the generated bridge for `0`, `false`, `no`, and `off`. The CLI and bridge use the fixed failure sentence. `herald-fake-telegram-e2e.test.ts`: “every disabled spelling emits and posts the fixed notice, never source” passes for the built CLI and installed bridge. | Reverting the grammar/CLI/bridge production changes while retaining the tests made both direct CLI and bridge `ENABLED=0` assertions receive the full jargon source instead of the fixed sentence. |
| M1/#4 — bridge provenance | The bridge supplies a per-invocation nonce and accepts stdout only when the validator frames it with the matching provenance line. `herald-fake-telegram-e2e.test.ts`: the argument-ignoring passthrough and exact `PI_OPERATOR_VOICE_LINT=/bin/cat` cases both post only the fixed failure. `herald-install.test.ts` pins the framing contract. | Reverting provenance made an exit-zero, argument-ignoring passthrough post the full source. On this Darwin host `/bin/cat` itself rejects `--door`; the exact `/bin/cat` acceptance remains independently green, while the equivalent exit-zero passthrough proves the provenance test can go RED. |
| M2 — deterministic id nets | Producer `operator-delivery.test.ts` and dashboard `operator-delivery.test.ts` reject `Completed 1234567890 successfully` and a 65-character hexadecimal token. Both sides now reject long decimal runs and hexadecimal runs of any length at or above 16 characters deterministically. | Reverting producer checks removed `internal-id` for the decimal and `hash` for the 65-hex case. Reverting the dashboard selector rendered both candidates instead of `OPERATOR_DELIVERY_FALLBACK`. |
| M3 — default-CI anti-build-1 proof | Client Vitest defaults `OPERATOR_VOICE_WORKTREE` to a committed repository-relative bundle generated from producer `6ba7878`; the fixture manifest binds the source tree, source, lexicon, bundle, and esbuild version. With the environment variable explicitly unset, the verbose default command executed and passed the real-producer→replay/store→reducer→`ChatView` DOM test 1/1. The generator `--check` reproduced the fixture. | Reverting only the Vitest default made the unconditional test fail with `OPERATOR_VOICE_WORKTREE must be set by the client Vitest config` (1 failed, 0 skipped). |
| B — real rewrite and semantic verifier | `real-provider-semantic-e2e.test.ts` calls the production `createContextRewriteProvider` on both legs, with no mock or stub. Provider/model/API: `copilot-api/claude-sonnet-4.6` via `anthropic-messages`. Ten messages ran three times: 30 real rewrites, 30/30 faithful candidates accepted, 30/30 independently corrupted candidates rejected. The test asserts each rewrite's material facts and case-specific non-fabrication. | Every BAD candidate is constructed by dropping or changing a material fact before calling the actual verifier. If any BAD verdict becomes true, or any GOOD verdict false, the test fails. The recorded matrix is GOOD 3/3 and BAD-rejected 3/3 for every case. |
| #5 — plain-copy asset scrub | `OperatorDelivery.presentation.test.tsx`: “copies plain text without exposing the transport asset id” passes and expects `[image: chart]`. | Reverting `ChatView.tsx` made the clipboard receive `![chart](pi-asset:abc12345def67890)` and the test failed. |
| #6 — blank ready candidate | The producer materializer test rejects two whitespace candidates without calling semantic verification. The dashboard selector table rejects `ready("   ")` to the exact fallback. The dashboard gate was already present at the frozen commit; the amendment adds explicit producer coverage and preserves the selector regression. | A narrow producer mutation that treated the empty verdict as valid returned `status:"ready"`; its test failed. Removing the dashboard `text.trim().length === 0` gate rendered three spaces instead of the fallback; its test failed. Both mutations were restored. |
| #7 — typed wire envelope | `protocol.ts` defines exact ready/failed/agent delivery and presentation types. Constructors, replay/event forwarding, image inlining, selector guards, and the reducer consume the shared contract. `operator-delivery-wire-types.test.ts` asserts exact type equality and invalid-shape compile errors. | Reverting only `protocol.ts` produced missing-contract imports, failed exact-type assertions, and unused `@ts-expect-error` diagnostics. The unchanged shared baseline also has one unrelated `rootDir` diagnostic; the contract-specific errors were additional. Positive faithfulness is covered by B. |

## Fast-follow dispositions

All seven requested fast-follows were fixed rather than retained.

| Item | Fix and green proof | Able-to-fail proof |
| --- | --- | --- |
| POSIX path ReDoS | The path expression has unambiguous non-empty segments. Producer `operator-delivery.test.ts` scans a 64,000-character slash string within its bound. | Reverting the expression classified the whole adversarial string as a giant path, failing the test. |
| Replay-hold watchdog | A nonterminal replay page with an open hold receives a receipt-time watchdog. `useMessageHandler.operator-delivery-timeout.test.tsx` passes. | Reverting the hook left zero timers where the test requires one. |
| Forwarder map growth | Pending finals are capped at 256 and cleared, including markers, on session reset. `message-end-forwarder.test.ts` passes cap and clear cases. | Reverting the forwarder produced two failures: no `clear()` and no bounded eviction behavior. |
| Marker `$` splice/collision | Image restoration uses collision-free markers and a replacement callback, keeping `$&`, `$'`, `$1`, and literal PUA marker text unchanged. Dashboard `operator-delivery.test.ts` passes. | Reverting produced relocated/corrupted image Markdown and failed the literal equality assertion. |
| Option-prefix counting | The option bound applies to the rewritten label, excluding the presentation-owned ordinal. Producer `door1-materialize.test.ts` passes a label exactly at the cap. | Reverting yielded `materializedFields:0, failedFields:1` instead of `1,0`. |
| Sentence-initial name preservation | Sentence-initial actors followed by the pinned action vocabulary enter the protected name multiset. The Alice approval case passes. | Reverting left only `semantic-review-required`, omitting the required `fact-term-missing` issue. |
| Duplicate-row boundary fallback | Boundary fallbacks retain nonce/entry aliases and a late final replaces the correlated row. `event-reducer.operator-delivery.test.ts` passes. | Reverting left `timedOutAssistantFallbackKey` undefined and failed before the late-final replacement assertion. |

The review's additional choice-restore edge was also fixed. The id-less exact
object path transfers its selection mapping when the real tool id arrives.
`extension-runner-delivery.test.ts` restores the second raw `Track-2` choice;
reverting the transfer left `restored.details` undefined.

## Honest-risk dispositions

`DESIGN.md` now explicitly records all six review omissions:

1. the historical `=0`/`=false` grammar split and the shared amended grammar;
2. the historical CLI raw-source success-channel echo and provenance boundary;
3. sibling code-name registry lag;
4. the id-less choice-restore seam and its amended regression test;
5. the trusted, non-adversarial extension→persistence→replay transport assumption;
6. the finite/porous nature of deterministic jargon detection despite the closed
   long-decimal and unlimited-hex gaps.

Sibling registry lag, non-adversarial transport, and the finite vocabulary are
retained residual assumptions with explicit rationale. The other three are fixed
and pinned by tests.

## Green verification

### Producer

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm run typecheck:core`: passed.
- Default `npm test`: 32 files and 385 tests passed; the opt-in real-provider
  file/test skipped as intended; 9.83 seconds.
- Real-provider test: 1/1 passed; 184.970 seconds.
- Focused post-RED set: 68/68 passed.
- `git diff --check`: passed.

Real-provider cost record:

- calls: 30 rewrite + 60 verifier = 90;
- estimated input tokens: 32,666;
- observable output-token estimate: 1,945;
- conservative configured output-token ceiling: 72,000;
- registry rates and estimated known cost: $0.

The exact output, all rewrites, and per-case stability are preserved in
`pi-extensions/pi-operator-voice/test/real-provider-semantic-e2e.results.json`
and summarized in the adjacent `.results.md`.

### Dashboard

- Portable M3 fixture `--check`: passed against producer `6ba7878`.
- Environment-unset verbose M3 test: 1/1 passed and was printed as executed.
- Focused amendment set: 9/9 files, 146/146 tests passed in 4.69 seconds.
- `npm run build`: passed, 4,046 modules; warnings were nonfatal.
- Full `npm test`: 629 files and 6,594 tests passed, 2 files and 17 tests
  skipped, and one test failed in 342.27 seconds. The sole failure is the frozen
  baseline policy test `no-direct-process-kill.test.ts`, which reports unchanged
  `packages/server/src/driver-liveness.ts:65`. That path is byte-identical to
  `f61b175`.
- `npm run lint` reports the same nine frozen-baseline errors in five unchanged
  paths: `App.tsx` (3), `CommandInput.tsx` (1), `MobileComposer.tsx` (2),
  `useImagePaste.test.ts` (1), and `server.ts` (2). Each path is byte-identical
  to `f61b175`; no amendment path adds a TypeScript error.
- `git diff --check`: passed.

The baseline-only test and typecheck failures are reported as caveats, not as
green results.
