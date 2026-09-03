# File Index — Native iOS

> Part of [pi-agent-dashboard file index](./file-index.md). Loaded on demand.
>
> **Update protocol**: see `AGENTS.md` → "Documentation Update Protocol".

| File | Purpose |
|------|---------|
| `ios/PiDashboard/Sources/SessionCard.swift` | Renders context usage from `contextFraction`. Hides context bar when usage unknown. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/Session.swift` | Stores `contextTokens` and `contextWindow`. Computes clamped `contextFraction` from complete pair. |
| `ios/PiDashboardKit/Sources/PiDashboardKit/Models/SessionPatch.swift` | Applies context pair atomically. Invalidates missing half when patch supplies one context field. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/ContextUsageDisplayTests.swift` | Locks B6 display behavior: stale-window rejection, live 45%, paired update, genuine 100%. |
| `ios/PiDashboardKit/Tests/PiDashboardKitTests/PatchAndModelContractTests.swift` | Locks patch and model contracts, including paired context updates. |
