# File Index — Web client hooks

> Part of [file index](./file-index.md).
>
> Change-history annotations → `openspec/changes/archive/`.
>
> Update protocol → `AGENTS.md` → Documentation Update Protocol.

| File | Purpose |
|---|---|
| `packages/client/src/hooks/__tests__/useMessageHandler.snapshot-replace.test.tsx` | Pins `sessions_snapshot` replacement of `sessions` Map and `sessionOrderMap`: stale ID drops, ended overwrites active, empty snapshot clears both. See change: fix-stale-sessions-on-reconnect. |
| `packages/client/src/hooks/__tests__/useSessionActions.spawn-runtime.test.tsx` | Tests explicit Codex spawn discriminator and unchanged pi payload. |
| `packages/client/src/hooks/useBootstrapStatus.ts` | Fetches `/api/bootstrap/status` on mount. Subscribes to `bootstrap-status` `CustomEvent` from `useMessageHandler` on `bootstrap_status_update` WS broadcasts. Exposes `{ state, isLoading, error, refresh, retry, upgradePi }`. |
| `packages/client/src/hooks/usePiChangelog.ts` | Loads lazily behind enabled gate. Refetches matching `pkg` on `pi_core_update_complete`. Never throws. See change: pi-update-whats-new-panel. |
| `packages/client/src/hooks/useQueueStuckTimeout.ts` | Marks unconfirmed optimistic queue entries failed after per-entry 30s timeout. UI shows "tap to retry". Mirrors `usePendingPromptTimeout`. See change: dashboard-message-queue. |
| `packages/client/src/hooks/useSessionActions.ts` | Preserves spawn correlation while forwarding optional runtime selection. |
| `src/client/hooks/useArchiveListing.ts` | Fetches archive endpoint. Exposes pure `groupByDate` and `filterEntries` helpers. |
| `src/client/hooks/useAuthStatus.ts` | Fetches auth status and provides login redirect helper. |
| `src/client/hooks/useContentViews.ts` | Owns state/fetch for pi resources, readme, and file previews. `clearAll()` resets hook-owned state. `onBeforeOpen` coordinates cross-component clearing. |
| `src/client/hooks/useDesktopBack.ts` | Wraps `selectDesktopBackTarget` with live overlay setters and `navigate`. Returns memoised `goBack()` for `App.tsx` desktop session-header. Replaces `window.history.back()` cold-load no-op. See change: fix-desktop-back-navigation. |
| `src/client/hooks/useImagePaste.ts` | Handles clipboard images in controlled/uncontrolled modes. `useImagePaste()` owns `pendingImages` in local `useState` for `ExploreDialog` lifetime. `useImagePaste({ images, onImagesChange })` delegates array ownership through `<CommandInput>` to App, keyed by `sessionId`. `imageError` stays local in both modes; clears after 3s. Supports image/png, image/jpeg, image/gif, image/webp; 10 MB base64 cap. See change: lift-pending-images-to-app. |
| `src/client/hooks/useInstalledPackages.ts` | Fetches `/api/packages/installed`. |
| `src/client/hooks/useMessageHandler.ts` | Dispatches WS messages extracted from `App.tsx`. Handles `spawn_register_timeout` and `spawn_register_recovered`; `spawnErrors` uses `Map<string, SpawnErrorDetail>`. See change: spawn-failure-diagnostics. `event_replay` resets `SessionState` via `createInitialState()` when `firstSeq === 1` OR `firstSeq <= maxSeqMapRef.current.get(sessionId)`; clears session `maxSeqMapRef` to 0 before restamping applied events. Covers paginated/lazy/multi-batch replay starting after seq=1; prevents 14–16× duplicate tool/assistant rows over 5-day sessions. See change: fix-replay-duplicates-tool-and-flushed-rows. `sessions_snapshot` REPLACES `sessions` Map and `sessionOrderMap` Map, never merges; drops prior-server IDs below "Show N ended" divider. See change: fix-stale-sessions-on-reconnect. `session_state_reset` and `event_replay` `shouldReset` preserve `pendingPrompt` across `createInitialState()` during auto-resume bridge re-register. Only reducer `message_start`/`agent_start`, 30s safety timeout, or explicit cancel clears pending prompt. See change: preserve-pending-prompt-across-replay. `case 'models_refreshed'` stays no-op; preserves global `modelsMap` and older-bridge protocol compatibility. See change: simplify-model-selection-channels. |
| `src/client/hooks/useMobile.tsx` | Exposes `MobileProvider` and `useMobile()`. `useMediaQuery("(max-width: 767px), (max-height: 599px)")` selects mobile at width <768px OR height <600px. Landscape iPhone 14 (844×390) and Pixel 8 (915×412) receive single-panel layout. Desktop windows below 600px height also enter mobile mode; regression pinned by `useMobile.test.tsx`. See change: fix-mobile-header-and-orientation. |
| `src/client/hooks/useOpenSpecActions.ts` | Dispatches OpenSpec refresh/archive/attach/detach callbacks. Calls `clearAllContentViews` before preview. |
| `src/client/hooks/useOpenSpecReader.ts` | Maps OpenSpec artifacts to file paths, fetches content, and concatenates specs. |
| `src/client/hooks/usePackageOperations.ts` | Subscribes React to singleton `packageQueue`. Preserves `operation`, `install/remove/update`, and `clearOperation` for `PackageBrowser`, `RecommendedExtensions`, `MissingRequiredBanner`, `PiResourcesView`, and `SettingsPanel`. Adds `statusFor(source)` (`idle\|queued\|running\|success\|error`), `messageFor(source)`, and `queueDepth` for row state. Single `pi-package-event` window listener lives in `package-queue`, not hook. See change: package-install-queue. |
| `src/client/hooks/usePackageSearch.ts` | Debounces fetches to `/api/packages/search`. |
| `src/client/hooks/usePendingPromptTimeout.ts` | Clears stuck `pendingPrompt` spinners after 30s safety timeout. |
| `src/client/hooks/usePiResources.ts` | Fetches pi resources API and polls every 30s. |
| `src/client/hooks/useRecommendedExtensions.ts` | Fetches `/api/packages/recommended`; refreshes on `package_operation_complete`. |
| `src/client/hooks/useSessionActions.ts` | Provides send/abort/resume/spawn session-action callbacks. |
| `src/client/hooks/useSessionDiff.ts` | Fetches `/api/session-diff`. |
| `src/client/hooks/useSwipeBack.ts` | Implements iOS-style left-edge swipe-back with 40px edge zone and document-level listeners. |
| `src/client/hooks/useViewDispatcher.ts` | Watches `selectViewedSessionId(...)` and `useWebSocket` connection state from `App.tsx`. Sends `session_unview` for previous ID and `session_view` for current ID on view changes. Resends current `session_view` on transition into `connected`. `useWebSocket.send` drops sends while not OPEN; reconnect resend restores server view state. See change: session-card-unread-stripes. |
| `src/client/hooks/useZoomPan.ts` | Handles zoom/pan through wheel, drag, pinch, and buttons. |
