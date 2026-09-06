# File Index — Native iOS

> Part of [pi-agent-dashboard file index](./file-index.md). Loaded on demand.
>
> **Update protocol**: see `AGENTS.md` → "Documentation Update Protocol".

| File | Purpose |
|------|---------|
| `ios/PiDashboard/Sources/DashboardStore.swift` | Fetches external transcript through connected `RestClient` without chat subscription. |
| `ios/PiDashboard/Sources/ExternalTranscriptView.swift` | Renders read-only external transcript with existing `ChatMessageRow`; exposes truncation and load states. |
| `ios/PiDashboard/Sources/MainView.swift` | Maps `horizontalSizeClass` through `DashboardNavigationPolicy`. Keeps compact `NavigationStack` destination links unchanged. Uses regular `NavigationSplitView` with session sidebar and selected detail keyed by session ID. Routes native sessions to `ChatView`, external sessions to read-only `ExternalTranscriptView`. Shows empty-selection placeholder. Preserves settings/new-session sheets. Does not migrate navigation state across compact/regular transitions. |
| `ios/PiDashboard/Sources/SessionCard.swift` | Renders context usage from `contextFraction`. Hides context bar when usage unknown. |
| `ios/PiDashboard/Sources/SessionListView.swift` | Offers optional regular-width selection buttons. Defaults to existing `NavigationLink` destinations: external sessions → read-only `ExternalTranscriptView`, native sessions → `ChatView`. Preserves accessibility identifiers. |
| `ios/PiDashboard/project.yml` | Targets phone/tablet (`TARGETED_DEVICE_FAMILY: "1,2"`). Enables phone portrait/landscape and all iPad orientations. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/ExternalTranscript.swift` | Decodes transcript entries defensively. Maps entries to existing `ChatMessage` rows plus status rows. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/Session.swift` | Stores `contextTokens` and `contextWindow`. Computes clamped `contextFraction` from complete pair. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/SessionPatch.swift` | Applies context pair atomically. Invalidates missing half when patch supplies one context field. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Net/DashboardClient.swift` | Fetches external transcripts through percent-encoded session path. Maps non-2xx responses to `.httpStatus`. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Sessions/DashboardNavigationPolicy.swift` | Maps optional `Width` to `Layout` through pure policy: `.compact` → `.stack`, `.regular` → `.splitView`, `nil` → `.stack`. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/ContextUsageDisplayTests.swift` | Locks B6 display behavior: stale-window rejection, live 45%, paired update, genuine 100%. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/DashboardNavigationPolicyTests.swift` | Defines 4 tests for compact/regular/nil width contract and layout re-evaluation. Records observed always-stack mutation caught by `testRegularWidthUsesSplitView`. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/ExternalTranscriptTests.swift` | Locks defensive decode, chat-row mapping, timestamp handling, truncation, fallback shape, 404 distinction, transport failure, session ID encoding. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/PatchAndModelContractTests.swift` | Locks patch and model contracts, including paired context updates. |
| `ios/qa-e2e/PiDashboardUITests/AdaptiveNavigationUITests.swift` | Adds 4 unexecuted UI guards: phone push/pop; tablet sidebar/empty selection; detail replacement/session drafts; settings trace/new-session sheets. |
| `ios/qa-e2e/PiDashboardUITests/ComposerScrollDismissUITests.swift` | Defines gesture-only keyboard dismissal checks; exact draft/no-send and queue checks. Requires software keyboard harness precondition. UNRUN: host swapouts rose before simulator boot. |
