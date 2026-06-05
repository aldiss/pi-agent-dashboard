# File Index — Infrastructure (seed, sandbox, skills)

Covers: `seed/`, `sandbox/`, `qa/playwright-mobile/`, `.pi/skills/sandbox-designer/`. Read this split when locating an infrastructure file or understanding its responsibilities.

> **Update protocol**: see `AGENTS.md` → "Documentation Update Protocol". Rows included here are ≤ 200 characters for AGENTS.md consumption; full annotations live here.

## Rows

| File | Purpose |
|---|---|
| `seed/active-project/` | Fake workspace: 3 sessions (ask_user waiting, streaming, completed), 2 pinned dirs, flows |
| `seed/empty-workspace/` | Fake workspace: 0 sessions, landing-page state, spawn-cta affordance |
| `seed/error-states/` | Fake workspace: disconnected session card, failed tool calls, error banner |
| `seed/multi-folder/` | Fake workspace: 4 pinned dirs with 2-4 sessions each, folder focus/compaction |
| `seed/openspec-heavy/` | Fake workspace: 3 active OpenSpec changes, 2 archived, attach/detach flow |
| `sandbox/Dockerfile` | Docker image: node:22-bookworm-slim + pi + openspec + dashboard deps |
| `sandbox/docker-compose.yml` | Two-service composition: dashboard (:8000) + headless Chromium (:9222) |
| `sandbox/entrypoint.sh` | Dashboard container entrypoint: start pi-dashboard → poll /api/health → tail logs |
| `qa/playwright-mobile/playwright.config.ts` | Playwright config. 3 projects: iphone-14-pro-max-portrait (webkit), desktop-chromium, desktop-webkit. Targets `PI_DASHBOARD_BASE_URL` (default `http://127.0.0.1:8000`). `fullyParallel: false`. |
| `qa/playwright-mobile/specs/_helpers/measure.ts` | Session-history load-time primitives: `getChatScrollGeometry`, `waitForChatFirstPaint`, `waitForChatScrollStable`, `attachWsReplayCounter`, `clearServiceWorkerAndCaches`, `primeServiceWorker`. |
| `qa/playwright-mobile/specs/chatview-desktop-resize.spec.ts` | Desktop window-resize empirical-cycle test. Asserts ChatView visualViewport.resize patch re-anchors scroll-to-bottom across DESKTOP_LARGE/NARROW/SHORT (chromium + webkit). |
| `qa/playwright-mobile/specs/chatview-rotation-scroll.spec.ts` | iOS WebKit rotation test. Asserts 350ms-debounced re-anchor on portrait↔landscape (430x932 ↔ 932x430) preserves bottom-anchor or scroll-position per pre-rotation state. |
| `qa/playwright-mobile/specs/session-history-load-time.spec.ts` | dashboard-dev/v1 W1 baseline harness. Fresh-SW + primed-SW × 3 projects = 6 tests. PRIMARY: click-to-first-paint. SECONDARY: ws-replay-frames + scroll-stable. Override via `TEST_SESSION_ID`. |
| `.pi/skills/sandbox-designer/SKILL.md` | Vision-capable design agent: before-screenshots + user story → Tailwind HTML mockup |

## Seed workspace format

Each workspace under `seed/` is a self-contained subdirectory:

- `*.jsonl` — Session event files in native pi format (one JSON object per line).
- `*.meta.json` — Session metadata sidecars (cwd, status, model, tokens, cost, attachedProposal).
- `preferences.json` — Pinned directories + per-directory session order.
- `README.md` — Documents covered UI states.

Dashboard server reads these natively — no mock adapter, no fixtures. Format matches real `~/.pi/agent/sessions/` layout.

## Growth via archive-merge

Seed data grows when OpenSpec changes contribute `seed.patch` / `Dockerfile.patch`. Applied by `openspec-archive-change` skill BEFORE `openspec archive` moves the change directory.
