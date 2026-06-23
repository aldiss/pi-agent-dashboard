# PWA end-to-end test framework (`npm run test:e2e`)

Real-browser end-to-end coverage for the pi-dashboard web client — the safety
net for the **Editorial Craft** redesign and the PWA platform surface.

This is the first-class full-PWA e2e suite (distinct from the jsdom/vitest
component tests under `packages/*/__tests__/` and the Appium/WDIO iOS harness in
`qa/ios-visual/`). It promotes the proven single-cell pattern from
`qa/playwright-mobile/` into a general suite.

## Run

```bash
npm run test:e2e                 # full suite, all projects
npm run test:e2e:update          # re-capture visual-regression baselines

# scope to one project / spec:
npx playwright test --config e2e/playwright.config.ts --project=iphone-14-pro-max
npx playwright test --config e2e/playwright.config.ts 02-skin-switch

# HTML report (written to e2e/playwright-report/):
npx playwright show-report e2e/playwright-report
```

## Projects (device matrix)

| Project | Engine | Viewport | Why |
|---|---|---|---|
| `iphone-14-pro-max` | WebKit | 430×932 | the REAL installed-PWA target (iOS home-screen) |
| `desktop-chromium` | Chromium | 1440×900 | desktop happy path |
| `desktop-webkit` | WebKit | 1440×900 | operator's Mac-default engine |

WebKit (not Chromium emulation) is the canonical iOS Safari engine, so the
mobile project pins `browserName: "webkit"`.

## Server fixture — v1 runs against the live `:8000` server

The suite targets the live dashboard at `http://127.0.0.1:8000` (override with
`PI_DASHBOARD_BASE_URL`). `global-setup.ts` verifies the server is reachable +
identity-healthy and fails fast with a clear message otherwise.

Start a server first:

```bash
pi-dashboard start
```

**Why live, not a seeded ephemeral boot (yet):** running against the live
instance is the v1 path explicitly sanctioned by the build brief. It also avoids
rebuilding the client — a `npm run build` regenerates
`packages/client/src/generated/plugin-registry.tsx`, which can carry another
lane's in-progress plugin set. The live `:8000` already serves the committed
editorial build, so the redesign-under-test is exactly what ships.

**Follow-up (flagged, not v1-blocking):** a deterministic `globalSetup` that
boots the dashboard on an ephemeral port seeded from `seed/` (the fake-workspace
fixtures). That would (a) remove the "start a server first" precondition and
(b) unlock stable session-list visual snapshots (see Visual regression below).

## Non-destructive contract

The suite runs against a live server that may hold real operator sessions. The
in-page WebSocket shim (`helpers.ts → primeApp`) **records** every control frame
the client sends, and by default **swallows** the mutating ones
(`set_model` / `set_thinking_level` / `set_push_prefs`) so a test run never
permanently re-models a live session. The MVP-parity spec therefore asserts the
exact frame the client emitted (the parity contract) plus client-side sheet
behavior — not the server echo.

## Specs

| Spec | Covers | Gate |
|---|---|---|
| `01-boot-connect` | app boots, WS connects, session list renders | core |
| `02-skin-switch` | Editorial⇄Legacy flips `data-skin`/tokens/fonts, persists across reload, composes with Light/Dark/Auto | core |
| `03-mvp-parity` | mobile model/thinking/bell sheet emits `set_model`/`set_thinking_level`/`set_push_prefs` (both skins) | core |
| `04-settings-tabbar` | no clip at mobile width; Security/Advanced reachable via scroll-snap | core |
| `05-navigation` | list⇄detail slide (back-button); left-edge swipe-back | core (slide) |
| `06-pwa-platform` | manifest valid + installable, SW registers, offline shell | mixed |
| `07-visual-regression` | skin×theme×viewport appearance gallery | core |

## Gating policy (brief §9.3)

- **Core flows MUST be green to land:** skin-switch persistence, MVP parity,
  settings-tab, navigation (back-button slide), visual-regression snapshots.
- **Deep PWA-platform + gesture tests are required-to-EXIST but non-blocking if
  environment-flaky** — they degrade to a documented `test.skip` with a reason
  rather than a hard failure. Current documented skips:
  - **`05-navigation` swipe-back** — Playwright WebKit forbids synthetic
    `Touch`/`TouchEvent` construction ("Illegal constructor"), so the edge
    gesture isn't drivable headlessly. The equivalent navigation capability
    (return to list) is hard-gated by the back-button test. `useSwipeBack` is
    unit-tested in jsdom.
  - **`06-pwa-platform` offline shell (WebKit only)** — Playwright's WebKit
    driver throws an internal error on `reload()` while offline. The SW + its
    substituted precache manifest are verified by sibling tests, and Chromium
    exercises the real offline shell.

## Visual regression — the operator-facing gallery

`07-visual-regression` snapshots the **Settings → Appearance** section per
skin×theme×viewport (editorial-dark/light, legacy-dark/light × the 3 projects).
Baselines live in `e2e/specs/__screenshots__/`.

The Appearance section is the deterministic design-system surface — the skin
cards + theme control rendered in the live skin's own tokens, fonts, and
terracotta accent. The live **session list** is intentionally NOT snapshotted:
its names/costs/status/timestamps change run-to-run and can't be a stable
baseline. The seeded-fixture follow-up above would unlock session-list snapshots.

Re-capture baselines after an intentional visual change:

```bash
npm run test:e2e:update
```

## Selectors

All selectors + the skin/theme localStorage contract + the WS-frame capture live
in `helpers.ts` (one place to update when the DOM moves). They were read off the
committed editorial components, not guessed. Most testids ship in the redesign
(`skin-selector`, `model-sheet`, `sheet-thinking-*`, `sheet-bell`,
`settings-tab-bar`, `mobile-header-model-row`, …); the only additive one this
suite introduces is `appearance-section` (anchored version-agnostically in
`helpers.ts` so it resolves whether or not the running build carries it).
