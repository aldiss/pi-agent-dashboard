# Native iOS app — backlog

Durable record of defects and gaps for the native iOS dashboard app. Updated as items
move. One line per item; evidence lives next to the claim so a later reader can check it
rather than trust it.

**Status values:** `SHIPPED` (landed + pushed) · `IN PROGRESS` · `OPEN` (verified, not
started) · `BLOCKED` (needs someone else) · `UNRUN` (cannot be claimed either way yet).

**Rule for this file:** nothing is marked SHIPPED on the strength of a passing test alone.
A fix is SHIPPED when it is committed, pushed, and the check that proves it is one that
could have failed. Where a cause is not established, the item says so instead of guessing.

---

## Bugs — shipped

| ID | Title | Commit | Evidence |
|---|---|---|---|
| B1 | Updates stop arriving; reply stuck on "thinking…" | `8247acb` | Foreground return replaced a healthy socket unconditionally: 5 returns produced 6 accepted sockets, old ones leaked. Now probes liveness (ping/pong, 2s budget) before replacing. Harness `revalidate-idle` asserts ACCEPTED==1 and that the probe ran; must-fail control confirmed (defeated probe → ACCEPTED=6, exit 1). |
| B2 | Unchecking "Folders" hides sessions | `dca7888` | Two same-named sessions in different directories rendered as 1 row instead of 2; with 3 directories, 3 rows became 1. Directory was the only discriminator for non-crew identity. Independent probe measured 2→1 before, 2→2 after. |
| B3 | Harry and Dawn missing from Standing Crew | `c531f10` | Native roster had 8 names, web had 10. Their sessions fell into `other`, which is collapsed by default → invisible. Reproduced against the live 23-session set: native bucketed 8/1/14, web 10/1/12, matching the device screenshot exactly. |
| B4 | Rows render under the wrong tier header; expanded sections render empty | `654d869` | Row-group identity was the directory alone, but SwiftUI identity must be unique across the whole List. Measured on live data: with Folders on, `orchestration-state` was claimed by both `other` and `standing-crew`; with Folders off every cwd is `""` and three tiers collided. Duplicate identities make SwiftUI drop rows, not just misplace them. |
| B5 | Every Xcode Cloud archive failed — missing `Info.plist` | `4bec650` | Self-inflicted. An earlier CI change skipped `xcodegen` when the committed `.xcodeproj` was present, but xcodegen also emits the gitignored `Sources/Info.plist`, a build input. Verified by running the broken script against a fresh worktree (plist absent, failure reproduced) and the fixed one (plist produced). |

## Bugs — open

| ID | Title | Status | What is established, and what is not |
|---|---|---|---|
| B6 | Context shows 100% for a session that is at 45% | OPEN | Operationally serious: the operator rotates a seat above 50%, and the app is the only view available from mobile. **Server is correct** — live Hearth-19 payload is `contextTokens 450620 / contextWindow 1000000` → 45%, matching the TUI. Both server broadcast paths set tokens and window together. Native formula is correct. A proposed "it shows the cache-hit ratio" explanation is **refuted**: cacheRead is 22.8M and never enters the calculation. **Cause not established** — remaining candidates are client-side staleness or patch merge. Contract test landed (`0805de9`) pinning 45%-not-100% plus the stale-window arithmetic that produces a false 100%. |
| B7 | Scrolling back through history is yanked to the bottom by new messages | OPEN | Root cause found. Auto-follow is gated on distance-from-bottom, measured by a 1px marker at the end of a **lazy** list. Scrolling far up destroys the marker; its preference then reverts to the default `0`, which reads as "at the bottom", so the guard passes and the view snaps down. Scrolling up does not disable follow — it guarantees it. The code comment claims the opposite, which is why it shipped. **Second defect, same cause:** the same value drives mark-as-read, so scrolling up silently clears unread state for messages never seen. |
| B8 | The `+N` badge is inert — folded sessions are unreachable | OPEN | `olderIds` is computed and unit-tested but read by no view; tapping opens the surviving row. Any session folded behind `+N` cannot be reached at all. Raised in severity by F6: crew tenures fold globally across directories. |

## Bugs — not the app

| ID | Title | Status | Note |
|---|---|---|---|
| N1 | Repeated "X appears stuck (idle 15m…)" cards | BLOCKED (pi-messenger) | `pi-messenger` warns when a peer is idle past 900s while holding a file reservation. Atlas-3 had ended ~4.6 days earlier but never released its mesh reservation. Repeats occur because the dedup entry is cleared whenever the peer stops appearing stuck, and a peer being reaped flickers in and out. Registry now shows zero dead-PID entries. Off-switch: `stuckNotify: false` in `~/.pi/agent/pi-messenger.json`. App-side note: the dashboard renders a passive toast as a card that looks like it needs an answer. |
| N2 | Web login: "Token exchange failed" | BLOCKED (operator) | Not app or server code. The machine cannot resolve the apex `github.com` through the system resolver, while `www.`, `api.` and `codeload.` all resolve and `dig` answers `140.82.121.4`. Primary nameserver is Tailscale MagicDNS (100.100.100.100). `dscacheutil -flushcache` did not clear it; needs `sudo killall -HUP mDNSResponder`. Separately, the server folds every exchange failure into one silent message — DNS, rotated secret and redirect mismatch are indistinguishable. Worth fixing in the web repo (Joan's domain). |

## Features — parity gaps vs the web client

| ID | Title | Status | Detail |
|---|---|---|---|
| F1 | No image downscaling before send | IN PROGRESS | Web caps the long edge at 1568px @ 0.85 (~6× smaller base64 for a 12MP photo) and skips animated GIF. Native base64-encoded raw picker data. Ported with pure geometry + MIME policy; oversized HEIC re-encodes to JPEG and is labelled truthfully. |
| F2 | Cannot pin a folder | OPEN | The app honours pins (`pinned_dirs_updated` inbound, pinned-first ordering) but has **no outbound** `pin_directory` / `unpin_directory` / `reorder_pinned_dirs`, and no context menu, long-press or swipe affordance to hang the control on. Needs a design decision, not just wiring. Reorder is a separate, heavier interaction. |
| F3 | No `external` tier, no external-session source | OPEN | Web has 7 tiers including `external` (read-only Codex / Claude Code panes) and fetches an external-sessions response with owners/drivers plus cell grouping. Native has 6 tiers and none of that data path. Larger than it looks: a data-source integration, not a filter. |
| F4 | "Active only" filter missing | OPEN | Web exposes Folders / Hide ended / Hide stale / **Active only**; native exposes Folders / Hide ended / Hide stale / **Hidden**, and hardcodes `activeOnly: false`. The two clients cannot be driven to the same visible set. |
| F5 | Composer wastes a full row when multiline | OPEN | Multiline moves attach + controls to their own full-width row with a spacer between, so the middle is empty by construction. Single-line keeps them inline. Deliberate layout (the stable text slot prevents editor teardown mid-stream), so changing it needs care. |
| F6 | Crew tenures fold across directories; the web never folds | OPEN | Native folds crew canonical names globally into one row; the web client has no same-name collapse at all and renders every tenure. Combined with B8 the folded tenures are unreachable. Largest remaining "I can't see all my sessions" contributor. |

## Verification debts — must not be reported as passing

| ID | Item | Status |
|---|---|---|
| V1 | Physical microphone acceptance | UNRUN — requires the operator's device |
| V2 | Physical OAuth + real Keychain migration over an installed build | UNRUN — green results to date are against a memory stub, not the Security framework |
| V3 | On-screen render check for B4 | UNRUN — three local simulator attempts died before any assertion (CoreSimulator "Failed to locate promise" ×2, Mach -308 once) on a box at 196 five-minute load. CI runs this suite nightly/on-demand only; a push-triggered green tick does **not** cover it. Triggered explicitly via workflow_dispatch. |

---

## Working notes

- Xcode Cloud builds on push; no manual Rebuild needed. A green Cloud build proves compile
  and archive only — never rendering.
- Build numbers are owned by Xcode Cloud. Do not assert one.
- To tell whether a build carries B4's fix without a build number: expand **Other →
  orchestration-state**. Crew names there (Joan/Peggy/Bert) means the old build; utility
  sessions there (StubBoot/Nameplate/DiskCleanup-4) means the fix is live.
