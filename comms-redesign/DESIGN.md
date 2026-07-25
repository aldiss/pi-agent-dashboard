# Comms-layer redesign: source-bound plain delivery

## Outcome and governing premise

The operator must reliably receive plain-language versions of agent-to-operator
prose: the same human-relevant facts and decisions, without ledger identifiers,
section citations, internal code-names, orchestration jargon, or process theater.

The premise is deliberately honest. Build-1 passed several component and safety
gates, but it **failed Pete's final strict-spec/outcome gate**. It did not pass
every review gate. Its agent-willingness path could be internally coherent while
the operator still received no plain version. This rebuild therefore treats
plain text reaching the operator surface—not a detector verdict, directive, or
component test—as the controlling outcome.

The new path is system-owned. A provider request outside the emitting agent loop
creates a candidate, deterministic checks and a mandatory semantic/plainness
comparison gate it, the result is bound to the exact finalized source, and the
dashboard renders only the bound result. The emitting agent is never asked to
rewrite and cannot turn compliance, narration, or refusal into the delivery
mechanism.

## Scope

The plain-delivery contract covers:

- finalized assistant prose classified `operator` or `unknown`;
- every rendered `ask_user` question field and option label;
- `push_notify_user` title and body; and
- the complete herald body before its external POST.

It does not rewrite the operator's own user text, positively proven
`audience:"agent"` mesh traffic, arbitrary tool/subagent result payloads, or raw
diagnostic telemetry. The dashboard still makes the two operator-facing tool
lifecycles status-only so their arguments and results cannot become an alternate
prose leak. Agent-only source and finalized thinking remain available under the
existing Agent-only chat filter, but only after a digest-bound agent envelope.

## Verified baseline: what actually failed

The baseline was checked at the two pinned commits before choosing the
replacement architecture.

- In `pi-config` at `96d7a16b73708799b0c7867fac4a12328341eeb8`, the
  Door-2 header explicitly says the recompose loop is agent-borne
  (`pi-extensions/pi-operator-voice/src/herald-recompose.ts:17-21`). Door 3
  conditionally calls the follow-up re-drive and stamps `held`/`terminal`
  (`pi-extensions/pi-operator-voice/src/index.ts:511-547`). Door 1 blocks with a
  rewrite directive and eventually lets the original ask proceed
  (`pi-extensions/pi-operator-voice/src/doors/ask-user-door.ts:269-297`). None of
  those sites independently produces the required plain prose.
- In `pi-agent-dashboard` at
  `846e787f6f5a1b5a3aa38c6726c3ed54538a84b0`, the reducer masks selected spans
  while retaining the surrounding sentence
  (`packages/client/src/lib/event-reducer.ts:476-517`) and decides whether to
  hold, strip, or release source text from producer verdict stamps
  (`packages/client/src/lib/event-reducer.ts:1476-1534`). `ChatView` separately
  hides injected recompose directives
  (`packages/client/src/components/ChatView.tsx:537-550`). These are render belts,
  not a plain-language producer.

The later deterministic span-substitution direction described in the mission
brief was proposed and rejected before implementation. It is not treated here
as the built failure. This redesign replaces the compliance-contingent system in
the preceding bullets.

## End-to-end architecture

```text
final assistant source + authoritative audience
                    |
                    v
 independent whole-message rewrite request
                    |
                    v
 deterministic invariants + semantic/plainness verifier
                    |
                    v
 source-SHA-bound ready / failed / agent envelope
                    |
                    v
 append-bound bridge -> persistence -> live/cold replay
                    |
                    v
 shared selector -> event reducer -> ChatMessage -> DOM
```

There is no follow-up turn, retry directive, single-in-flight temporal join, or
later agent response to correlate with the source.

## Producer: where plain prose is made

### Finalized assistant prose

`materializeOperatorDelivery` is the load-bearing producer
(`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:1186-1258`).
It rejects empty/oversized sources and provider-control text before a request,
then makes at most two rewrite attempts under one 24-second deadline. Every
candidate—including byte-identical already-plain text—must pass both:

1. deterministic checks for forbidden identifiers, citations, hashes,
   code-names, orchestration/rewrite/control narration, exact number/URL/path/
   flag/image anchors, likely names, action/polarity/modality, status/count
   relations, and same-vocabulary clause swaps
   (`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:988-1117`);
2. a separate bidirectional semantic/plainness comparison request that must
   return one exact source-and-candidate-digest-bound token
   (`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:1148-1180`,
   `:1224-1238`, `:1324-1334`).

Provider absence, error, timeout, missing semantic verifier, wrong verifier
token, or a second invalid candidate produces a typed failure. A source or
candidate containing provider-control language fails closed. Valid
`pi-asset:` references are anchors only when they are complete lowercase
16-hex Markdown image destinations; bare, malformed, link, HTML, and alt-text
uses are not certifiable
(`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:148-182`,
`:1018-1037`, `:1192-1201`).

The provider binding calls the current configured provider and credentials
directly; it does not call `sendUserMessage`, add a user row, or enter the
emitting agent loop
(`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:1270-1334`).
The envelope is:

```ts
type OperatorDelivery =
  | {
      version: 1;
      sourceSha256: string;
      status: "ready";
      text: string;
      checks: { plain: true; anchorsPreserved: true };
    }
  | {
      version: 1;
      sourceSha256: string;
      status: "failed";
      code: "provider-unavailable" | "timed-out" | "provider-error" | "invalid-rewrite";
    }
  | {
      version: 1;
      sourceSha256: string;
      status: "agent";
    };
```

The exact implementation is at
`pi-config: pi-extensions/pi-operator-voice/src/operator-delivery.ts:21-52`.
The agent variant is a positive, source-bound authorization to retain internal
source; a mutable `audience:"agent"` field alone is insufficient.

At `message_end`, the extension overwrites the audience, starts embedded tool
materialization and finalized-prose materialization concurrently, then writes
the resulting envelope on that same message
(`pi-config: pi-extensions/pi-operator-voice/src/index.ts:521-590`). Current
process identity is added to the live registry name set, closing the interval
before a newly started internal name appears in the registry (`index.ts:343-350`).

Production delivery hooks do not run legacy diagnostic lint or audit I/O. That
work was removed from the critical path after adversarial review showed that a
synchronous lint or slow log sink could wedge an otherwise successful delivery.
The retained helpers are offline compatibility utilities, not architecture.

### Operator-facing tools

Pinned core emits assistant `message_end` before `tool_execution_start`. The
extension therefore materializes every embedded `ask_user` title, message,
placeholder, nested question, and option, plus each push title/body, by mutating
the real tool arguments before the start event
(`pi-config: pi-extensions/pi-operator-voice/src/doors/operator-tool-calls.ts:38-78`).

The later `tool_call` hook is a backstop. A canonical snapshot plus tool-call id
recognizes the exact `structuredClone` produced by core and avoids a second
provider pass; a normalized or direct unmatched call is materialized there
(`pi-config: pi-extensions/pi-operator-voice/src/index.ts:351-460`). Plain-string
question choices receive stable ordinals. Source choices are captured before
presentation, composed across a normalized second pass, and restored in result
content/details before agent context
(`pi-config: pi-extensions/pi-operator-voice/src/doors/ask-user-selection.ts:42-169`,
`index.ts:441-471`). This prevents two plain labels from changing the machine
choice.

Push title/body use exact 200/500 UTF-16-unit bounds and fixed failure wording;
the URL is never assigned or normalized
(`pi-config: pi-extensions/pi-operator-voice/src/doors/push-notify-user-door.ts:45-92`).
Question fields similarly use fixed failure text, never source text
(`pi-config: pi-extensions/pi-operator-voice/src/doors/ask-user-door.ts:140-145`,
`:236-305`). Chat asset references fail to fixed wording on these plain-string
surfaces because they cannot resolve an image sidecar.

### Herald

The herald CLI passes the current process name and live transient registry names
into the same materializer, selects ready text or the fixed failure sentence,
and writes that body directly to stdout. It performs no diagnostic I/O first
(`pi-config: pi-extensions/pi-operator-voice/src/herald-lint-cli.ts:34-69`). Its
default provider is a separate print-only process with session, tools,
extensions, skills, templates, themes, and context files disabled
(`pi-config: pi-extensions/pi-operator-voice/src/headless-rewrite-provider.ts:108-165`).
The machine-applicable Bash bridge replaces `TEXT` before the POST and never
uses source as its failure fallback
(`pi-config: pi-extensions/pi-operator-voice/src/herald-bridge-install.ts:44-82`).

## Dashboard transport and render integration

### Append-bound final forwarding

The dashboard bridge does not forward `message_end` from handler timing. It
holds the shared message, wraps `sessionManager.appendMessage`, prepares the
final object immediately before persistence, and sends it immediately after
persistence
(`pi-agent-dashboard: packages/extension/src/message-end-forwarder.ts:40-118`,
`packages/extension/src/bridge.ts:404-456`, `:1121-1143`). Consequently a producer
ordered before or after the bridge handler still completes before the final
event is stored and sent. The old unsafe early-flush timer is absent. If append
never occurs after a text partial, the client-side missing-final fallback
handles degradation.

The event store preserves source, delivery, and optional presentation sidecar
even through its over-cap summary path
(`pi-agent-dashboard: packages/server/src/memory-event-store.ts:185-229`,
`:280-320`). Cold replay preserves the message envelope and rebuilds protected
tool events
(`pi-agent-dashboard: packages/shared/src/state-replay.ts:67-103`, `:123-270`).

### Images without weakening the source proof

The bridge never mutates certified delivery bytes. For a local Markdown image it
creates a separate `operatorDeliveryPresentation` sidecar bound to the SHA-256 of
the ready text and permits only an image-destination substitution
(`pi-agent-dashboard: packages/extension/src/markdown-image-inliner.ts:352-408`).
Image bytes are persisted as bounded message sidecars, registered before live
or replayed text, then removed from event frames
(`packages/extension/src/session-sync.ts:107-127`,
`packages/shared/src/state-replay.ts:9-64`).

The shared selector independently validates exact keys, source digest, ready or
agent status, plainness safety forms, and the image-only presentation mutation
(`pi-agent-dashboard: packages/shared/src/operator-delivery.ts:90-238`). Only a
valid `audience:"agent"` plus a matching agent envelope releases source. Bare or
malformed transport ids are neutralized; Markdown copy, plain copy, pin previews,
unresolved-image titles, and file-diff context do not expose asset hashes
(`packages/shared/src/operator-delivery.ts:245-276`,
`packages/client/src/components/ChatView.tsx:152-177`,
`packages/client/src/components/PinnedMessagesSection.tsx:87-99`,
`packages/server/src/session-diff.ts:33-46`).

### Final selection, buffering, and degradation

The exact render seam is the assistant `message_end` arm in
`pi-agent-dashboard: packages/client/src/lib/event-reducer.ts:1456-1593`.
It extracts finalized source, validates the source-bound envelope through the
shared selector, and commits exactly one of:

- ready plain text for operator/unknown traffic;
- source text for a matching audience-plus-agent-envelope pair; or
- the fixed honest fallback.

Every assistant text and thinking partial is hidden before finalization; no
pre-final audience assertion can release it (`event-reducer.ts:400-405`,
`:1405-1453`). Finalized thinking is reconstructed only for a positively bound
agent row and follows the existing Agent-only chat category
(`event-reducer.ts:802-832`, `:1532-1541`).

A 30-second inactivity timeout, a new-message boundary, session removal,
session reset, and full-replay reset all resolve an unmatched hold to the same
fallback. Nonce/entry-id aliases let a late matching final replace that one row;
an unrelated later message cannot replace it
(`event-reducer.ts:416-466`, `:1231-1292`,
`packages/client/src/hooks/useMessageHandler.ts:122-183`, `:314-382`, `:511-609`).

`ask_user` and `push_notify_user` wire lifecycles are cloned into status-only
forms. A session-lifetime tool-id map closes name-less update/end/result frames;
the reducer repeats the denial and all operator-facing chrome uses fixed
"Question" / "Device notification" labels
(`pi-agent-dashboard: packages/shared/src/operator-tool-visibility.ts:1-63`,
`packages/extension/src/operator-tool-wire-tracker.ts:14-68`,
`packages/client/src/lib/event-reducer.ts:1640-1810`). Unknown protected-tool
debug events are dropped rather than rendered as raw JSON.

## Failure behavior

The finalized-chat fallback is exactly:

> I couldn't translate this update into plain language, so the original message is hidden.

It is shown for missing, malformed, failed, digest-mismatched, unsafe, or
timed-out deliveries and for unmatched holds. It states the loss, confirms that
source was hidden,
retains row correlation metadata, and does not pretend to preserve facts. Tool
and herald surfaces use equivalent bounded failure wording appropriate to their
UI. There is no automatic source fallback, silent drop, indefinite hold, or
agent repair request.

The original source remains in the session record because persistence, agent
context, exact digest verification, and tool execution need it. The guarantee is
an operator-presentation contract, not deletion or encryption of raw session
data.

## Load-bearing mechanisms and safety nets

Load-bearing mechanisms are:

- direct whole-message materialization outside the emitting agent loop;
- deterministic rejection plus mandatory semantic/plainness comparison;
- an exact source-bound delivery or agent envelope on the same finalized row;
- pre-tool-start question/push materialization and exact choice restoration;
- append-bound persistence/forwarding;
- unconditional pre-final buffering; and
- reducer selection of ready text or fixed failure.

Safety nets are:

- dashboard exact-key/digest/jargon/control validation;
- status-only protected-tool transport and fixed labels;
- timeout/boundary/reset fallbacks with late-final replacement;
- image presentation binding and asset-id scrubbing; and
- the retained historical directive-hide belt for old rows.

The safety nets can deny or degrade a bad delivery. They do not create plain
prose and are not counted as the outcome mechanism.

## Why this is not build-1

| Build-1 failure mechanism | Replacement |
| --- | --- |
| The emitting agent was instructed to rewrite after emitting jargon. | A direct provider request produces the candidate; no instruction reaches the emitting agent. |
| A natural agent could narrate, decline, or ignore the instruction. | The candidate is a same-message system artifact; narration/control text is rejected. |
| A lagged follow-up id could bind to a later message. | The delivery lives on its source row and is accepted only when the source SHA-256 matches. |
| Bounded retries could end in original wording or a neutral placeholder presented as success. | Failure is a visible translation failure and source remains hidden. |
| The dashboard belt only hid directives or masked spans. | The shared selector positively selects a ready plain artifact before `ChatMessage.content` reaches the DOM. |
| Green component checks were treated as outcome success. | The controlling cross-worktree test begins with jargon source and ends at the real `ChatView` DOM. |

## Proof strategy and executed results

The cross-worktree proof imports the real producer TypeScript in a child
process, uses fake rewrite/verifier functions, builds a persisted entry, then
runs real `replayEntriesAsEvents -> MemoryEventStore -> reduceEvent -> ChatView`
and asserts facts/decision present and source-only jargon absent
(`pi-agent-dashboard: packages/client/src/components/__tests__/ChatView.operator-delivery-cross-worktree.test.tsx:39-108`).
It does **not** call a real language provider or exercise the complete live
bridge lifecycle. Producer ExtensionRunner tests and dashboard append-forwarder
tests cover those seams separately; this distinction is intentional.

Executed own-hand on the settled worktrees:

- Producer: `npm run build && npm run typecheck && npm run typecheck:core && npm test && git diff --check`
  passed. Vitest: 32/32 files, 377/377 tests, 8.98 seconds.
- Dashboard focused safety set: the 12 explicit operator-delivery, reducer,
  presentation, timeout, tool-wire, replay, push, and thinking test files passed
  12/12 files and 254/254 tests in 7.12 seconds.
- Cross-worktree command:
  `OPERATOR_VOICE_WORKTREE=/private/tmp/codex-comms-2026-07-24/operator-voice npm test -- packages/client/src/components/__tests__/ChatView.operator-delivery-cross-worktree.test.tsx`
  passed 1/1.
- Dashboard: `npm run build` passed with 4,046 modules. Its CSS, mixed-import,
  and chunk-size warnings were nonfatal. `git diff --check` passed.
- Dashboard full `npm test`: 627 files and 6,585 tests passed; 3 files and 18
  tests skipped; one file/test failed in 359.27 seconds. The sole failure is the
  baseline policy test `packages/shared/src/__tests__/no-direct-process-kill.test.ts`,
  which flags unchanged baseline `packages/server/src/driver-liveness.ts:65`.
- Dashboard `npm run lint` reports nine existing errors in five unchanged
  baseline files: `App.tsx` (3), `CommandInput.tsx` (1),
  `MobileComposer.tsx` (2), `useImagePaste.test.ts` (1), and `server.ts` (2).
  `git diff --quiet 846e787f6f5a1b5a3aa38c6726c3ed54538a84b0 -- <those paths>` returned 0.

The suite and typecheck caveats are reported rather than described as green.
No deployment, live-tree write, enablement change, or publication was performed.

The producer freeze is baseline
`96d7a16b73708799b0c7867fac4a12328341eeb8` to
`a5f06faff07446aeb4e16ef60faaac19c78bbdae`.

## Honest risks and uncertainties

- Enablement parsing is a security boundary shared by the TypeScript config,
  herald CLI, and generated shell bridge. The frozen implementation treated
  `0` as disabled in config while the bridge recognized only `false`. The
  amendment pins one `0`/`false`/`no`/`off` grammar across the
  boundary. Future implementations must change that grammar and its tests
  together or they can reactivate a supposedly disabled side channel.
- The frozen herald CLI wrote its raw input to the success channel when
  disabled. That made a configuration disagreement, or an executable override
  such as `/bin/cat`, a source-disclosure path. The amended CLI always emits a
  fixed failure sentence when disabled, and the bridge accepts successful
  output only with validator provenance. The bridge remains a security boundary:
  losing either property would reopen the raw-source path.
- Arbitrary natural-language equivalence is not mathematically provable. Exact
  anchors, names, relations, action signatures, source binding, validator
  execution, transport preservation, and DOM selection are mechanically
  checkable; semantic completeness outside them still depends on the verifier.
  The rewrite and verifier currently use the configured provider, so correlated
  model error remains possible. Uncertainty is intended to fail closed, but a
  false semantic approval is the principal residual outcome risk.
- The deterministic jargon net is deliberately finite. Long decimal ids and
  hexadecimal blobs of any length are now rejected mechanically, but novel id
  prefixes, previously unseen internal phrases, and natural-language code-names
  can still reach the semantic verifier. The net is a hard backstop, not a
  complete vocabulary proof.
- The live name registry closes the start-up interval for the current process's
  own name only. A sibling process created inside the registry cache interval
  can have a code-name that is not yet in the deterministic set, leaving the
  semantic verifier as the remaining protection until the cache refreshes.
- Provider calls add latency, cost, and rate-limit exposure. The chain is bounded
  and fields run concurrently, but a dashboard inactivity fallback may appear
  before a late final; correlation replaces it when the final arrives.
- Audience classification remains a routing boundary. Unknown identity is
  materialized and shown; only positive agent evidence receives an agent
  envelope. A mistaken positive agent classification would put prose outside
  this contract.
- Protected tool ids are retained for the session lifetime so a late name-less
  frame cannot leak after eviction. This is fail-closed but memory grows with
  the number of protected calls until session switch.
- Choice restoration depends on retaining the source-to-presentation mapping
  across both identified and id-less exact-object tool-call paths. The frozen
  id-less path could discard that proof and change the machine choice after two
  labels were rewritten. The amended path and regression test pin this seam;
  future tool-call normalization still requires re-verification.
- The pre-tool-start mutation and append wrapper are verified against pinned
  core behavior. Unsupported core versions fail startup, but future core event
  ordering requires re-verification.
- Source hashes and exact-key validation bind an envelope to bytes; they do not
  authenticate an adversarial transport. The dashboard assumes its extension,
  persistence, and replay channel are trusted application components. A party
  able to rewrite both source and envelope inside that boundary could forge a
  matching delivery, so this design is not a cryptographic defense against a
  compromised transport or event store.
- `PI_OPERATOR_VOICE_ENABLED=false` is an explicit operational bypass; the
  guarantees above do not apply while it is disabled.
