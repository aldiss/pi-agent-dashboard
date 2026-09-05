# File Index — Native iOS

> Part of [pi-agent-dashboard file index](./file-index.md). Loaded on demand.
>
> **Update protocol**: see `AGENTS.md` → "Documentation Update Protocol".

| File | Purpose |
|------|---------|
| `ios/PiDashboard/Sources/DashboardStore.swift` | Fetches external transcript through connected `RestClient` without chat subscription. |
| `ios/PiDashboard/Sources/ExternalTranscriptView.swift` | Renders read-only external transcript with existing `ChatMessageRow`; exposes truncation and load states. |
| `ios/PiDashboard/Sources/SessionCard.swift` | Renders context usage from `contextFraction`. Hides context bar when usage unknown. |
| `ios/PiDashboard/Sources/SessionListView.swift` | Routes external session cards to `ExternalTranscriptView`; routes native sessions to `ChatView`. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/ExternalTranscript.swift` | Decodes transcript entries defensively. Maps entries to existing `ChatMessage` rows plus status rows. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/Session.swift` | Stores `contextTokens` and `contextWindow`. Computes clamped `contextFraction` from complete pair. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/SessionPatch.swift` | Applies context pair atomically. Invalidates missing half when patch supplies one context field. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Net/DashboardClient.swift` | Fetches external transcripts through percent-encoded session path. Maps non-2xx responses to `.httpStatus`. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/ContextUsageDisplayTests.swift` | Locks B6 display behavior: stale-window rejection, live 45%, paired update, genuine 100%. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/ExternalTranscriptTests.swift` | Locks defensive decode, chat-row mapping, timestamp handling, truncation, fallback shape, 404 distinction, transport failure, session ID encoding. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/PatchAndModelContractTests.swift` | Locks patch and model contracts, including paired context updates. |
