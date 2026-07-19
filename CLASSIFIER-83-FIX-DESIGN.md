# Classifier `:83` fix — DESIGN + APPLIED (Joan's session-field pin landed)

**Status:** **APPLIED** (Joan's `:83` wiring pin landed — reuse the existing `classifyTier`; resolve
`DashboardSession` from `sessionId` via `state` in App.tsx; thread `sessionCtx={tier}` through
`filterMessages`/`countMessagesByCategory`). Committed on `feat/build1-comms-dashboard`. This doc
records the design + the applied wiring; the real-seam test is
`packages/client/src/lib/__tests__/message-filter-classifier-audience.test.ts` (+ the
emit→reduce→classify corpus in `event-reducer-audience-stamp.test.ts`).

Coverage-contract item #1 (the shared operator-addressed classifier). The `:83` bug:

```ts
// packages/client/src/lib/message-filter-classifier.ts:83 (current)
if (m.role === "user" || m.role === "assistant") return "meshChatter";
```

returns `meshChatter` for EVERY plain user/assistant row — so an agent's reply *to the operator* AND
the operator's own typed prompts are both mislabeled chatter, and the "Mesh chatter" toggle hides both.

## The fix — ADD an `audience` field (grep-confirmed none exists), two parts

### Part 1 — STAMP (forward, authoritative / source-of-truth)

The emit path stamps `audience: 'operator' | 'agent'` on the `ChatMessage` envelope. The classifier
READS `msg.audience` for stamped rows. The extension's Door-3 (`src/audience.ts` in pi-operator-voice)
is the emit-side authority; the dashboard reads the same stamp — ONE classification, two projections.

Add to `ChatMessage` (event-reducer.ts:15):

```ts
export interface ChatMessage {
  // …existing fields…
  /**
   * Stamp-at-emit audience (operator-addressed vs mesh). Source of truth for
   * the operator-voice classifier + the "Mesh chatter" toggle. Absent on
   * pre-stamp history → the retrospective heuristic (Part 2) fills it.
   * See: pi-operator-voice src/audience.ts (the emit-side authority).
   */
  audience?: "operator" | "agent";
}
```

### Part 2 — RETROSPECTIVE (pre-stamp history ONLY)

`classifyMessage` takes an optional `sessionCtx` (server-side session metadata) and, for a `user`/
`assistant` row WITHOUT a stamp, derives the audience from **spawn-source + role-registry canonical
name**, NOT `role` alone (v2-c3), NOT `PI_AGENT_NAME` alone.

**The retrospective signal ALREADY EXISTS in the codebase** — `session-grouping.ts:classifyTier`
maps a session to `standing-crew | cell-executor | operator-chat-pane | worker | other` from
`session.source` (`tui` → operator-chat-pane) + the standing-crew canonical-name regex. The
`sessionCtx` maps directly onto it:

| classifyTier result   | audience  | rationale                                             |
|-----------------------|-----------|-------------------------------------------------------|
| `operator-chat-pane`  | operator  | `source === "tui"` = the operator's own chat pane     |
| `standing-crew`       | operator  | standing-crew output is operator-facing               |
| `cell-executor`       | agent     | mesh-dispatched cell work → addressed to dispatcher   |
| `worker`              | agent     | subagent worker → addressed to dispatcher             |
| `other`               | operator  | **FAIL-OPEN**: unclassifiable → shown + linted        |

### The patch to `classifyMessage` (`:50` + `:83`)

```ts
// ── add a sessionCtx param (optional; back-compat: undefined → current behavior
//    EXCEPT the :83 line, which now fails OPEN to operator-addressed) ──
export interface AudienceSessionCtx {
  /** The session tier from classifyTier (spawn-source + canonical name). */
  tier?: import("./session-grouping.js").SessionTier;
}

export function classifyMessage(
  msg: ChatMessage | ToolCallGroup,
  sessionCtx?: AudienceSessionCtx,          // NEW — optional, back-compat
): MessageCategory {
  // …unchanged through the interactiveUi / thinking / SYSTEM_ROLES / TOOL_CALL_ROLES / skill checks…

  // ── REPLACED :83 ──────────────────────────────────────────────────────────
  if (m.role === "user" || m.role === "assistant") {
    // (1) stamp wins (source of truth).
    const audience = m.audience ?? retrospectiveAudience(sessionCtx);
    // operator-addressed → NOT chatter (keep it visible + let the lint see it);
    // agent-addressed → meshChatter (internal mesh; §16 left alone).
    return audience === "operator" ? "tierB" : "meshChatter";
  }
  // …unchanged defensive tierB default…
}

/**
 * Retrospective audience for a pre-stamp row. Fail-open to "operator" (shown +
 * linted) when the tier is absent/unknown — never hidden-and-unlinted (§1.9).
 */
function retrospectiveAudience(ctx?: AudienceSessionCtx): "operator" | "agent" {
  switch (ctx?.tier) {
    case "cell-executor":
    case "worker":
      return "agent";
    case "operator-chat-pane":
    case "standing-crew":
    case "other":
    case undefined:
    default:
      return "operator";                    // FAIL-OPEN (show-when-unsure)
  }
}
```

**Projection note (v2-c1+c4):** the operator-voice LINT consumes `audience === "operator"` DIRECTION;
the dashboard "Mesh chatter" toggle keeps the whole operator CONVERSATION. Mapping operator-addressed
rows to `tierB` (visible-by-default) rather than `meshChatter` fixes the hide-both bug while leaving
`meshChatter` for genuinely agent-addressed rows. **This is the minimal `:83` change; the toggle-UX +
PWA parity are the #2 driver's consumer side (do NOT scope-grow here).**

## THE ONE PIN (Joan × Commwright, build-context S3 JIT-PIN)

`AudienceSessionCtx.tier` is populated from the server-side session that owns the row. **The exact
server-session field that carries `source`/tier to the ingestion path where `classifyMessage` is
called is what Joan pins.** Candidate (own-hand recon): the `DashboardSession.source` (`"tui" | "tmux"
| …`) surfaced via `session-grouping.ts:classifyTier`. The call site that threads a session into
`classifyMessage`/`filterMessages` is where the tier is resolved once and passed down.

**Blocking question for the pin:** at the `filterMessages` / `classifyMessage` call site(s) in the
client, is the owning `DashboardSession` (or its `source`/tier) in scope? If yes → thread
`classifyTier(session)` in as `sessionCtx.tier`. If the ingestion path is server-side (event-wiring),
Joan pins the server session field instead + the stamp is applied at emit (Part 1) so the retrospective
path is only for backfill.

APPLIED: `:83` now reads the stamp (`readAudienceStamp(m.audience)`) then falls back to the
retrospective `tier` heuristic (fail-open to operator/shown). The forward stamp (Part 1) is the
authoritative signal — emitted by the extension's Door-3 and RETAINED by the real reducer constructors
(`event-reducer.ts`), validated on read (M4). The `tier` is threaded from
`classifyTier(selectedSession)` in App.tsx → ChatView → filterMessages/countMessagesByCategory.

## Tests to land with the apply (sister to the extension's exemption corpus)

1. a stamped `audience:"operator"` assistant row → NOT `meshChatter`.
2. a stamped `audience:"agent"` row → `meshChatter`.
3. pre-stamp + `tier:"operator-chat-pane"` → operator (not chatter).
4. pre-stamp + `tier:"worker"` → `meshChatter`.
5. pre-stamp + no ctx (unknown) → **fail-open operator** (shown), NOT hidden.
6. the operator's own `user` row in a chat-pane session → operator (not chatter) — the second half of the `:83` bug.
