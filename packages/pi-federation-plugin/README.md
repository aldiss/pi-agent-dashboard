# pi-federation-plugin

WebSocket-over-Tailscale federation plugin for pi-agent-dashboard.

**Status:** v0.1 MVP — operator's TWO-TRANSPORT MVP (Schema 7 §3.5 Option E
live-coordination half). Substrate-state sync (Option A — Tailscale-ssh-rsync)
is the sister scope and ships via separate dispatch.

## What it does

When you have pi-agent-dashboard running on multiple machines on your Tailnet
(e.g. iMac + MacBook), this plugin lets your local dashboard see + display
sessions from peer machines side-by-side with local ones.

- **Server-side WebSocket clients** — opens one persistent `ws://peer:8000/ws`
  connection per configured peer; subscribes to their session events;
  re-broadcasts to local browsers
- **Auth handshake** — relies on peer's `trustedNetworks` bypass for Tailscale
  CGNAT range (default; works out of the box) OR mints a shared-secret JWT
  cookie for tightened-`trustedNetworks` deployments per Schema 7 §9.3
- **mDNS LAN-shortcut** — when peer is reachable on the local LAN via mDNS,
  prefers the LAN address over the Tailscale relay (lower latency)
- **Reconnect with backoff** — 1s → 2s → 4s → … → 30s cap, reset on success;
  60s liveness watchdog mirrors `packages/extension/src/connection.ts`
- **Session-id namespace prefix** — every peer session id is prefixed with
  the peer's `machineId` (e.g. `imac:019e2363-...`) so cross-machine
  collisions are impossible

## What it does NOT do (v0.1 honest scope)

- **Reverse-routing of mutating commands** — local browser `send_prompt` /
  `abort` / `shutdown` for a federated session id is NOT routed back to the
  peer. The local dashboard's `browser-gateway.ts` routes by `sessionId`
  before the plugin can intercept; would require a core router change. v0.1
  is read-only federation: see peer sessions; control still requires the
  ServerSelector switch.
- **Authorization enforcement** — investigator #1 §5.3 recommends per-action
  authorization (read vs mutate), deferred to v0.5 hardening.
- **Substrate state sync** — that's Option A (sister scope; dispatched
  separately).
- **Auto-reconnect across `auth.secret` rotation** — if you rotate the
  shared secret on the peer, the federation plugin will fail-to-connect
  with HTTP 401 until restarted with the new secret. v0.5 candidate.

## Install

The plugin is a workspace package in pi-agent-dashboard. After cloning:

```bash
cd ~/Copilot/pi-agent-dashboard
npm install   # or pnpm install — bonjour-service + ws are added as deps
```

The Vite plugin (`viteDashboardPluginsPlugin`) auto-discovers the manifest
via `packages/*/package.json`. On next dashboard build:

```bash
npm run build               # rebuilds client + regenerates plugin-registry
npm --prefix packages/server start    # OR however you launch the server
```

For dev mode + hot-reload of plugin config:

```bash
# In ~/.pi/dashboard/config.json:
{ "devBuildOnReload": true }
```

## Enable + configure

1. Open the dashboard at `http://localhost:8000`.
2. Settings (gear icon) → General tab → scroll to **"Federation (cross-machine sessions)"**.
3. Set **This machine's id** (e.g. `imac` on your iMac, `macbook` on the
   MacBook). This becomes the prefix when peers federate back to you.
4. Add peers — one row per remote dashboard. Fields:
   - **host** — Tailscale IP (e.g. `100.85.193.46`) OR Tailscale MagicDNS name
     (e.g. `vyacheslavs-imac`)
   - **port** — `8000` (default pi-dashboard port)
   - **machineId** — short id matching the peer's "This machine's id" config
   - **label** — optional human-readable label
5. **Auth mode** — leave as `Trust Tailscale` if peer's `trustedNetworks` includes
   `100.64.0.0/10` (the CGNAT default). Switch to `Shared-secret JWT` if peer
   has tightened `trustedNetworks` to specific IPs (per Schema 7 §9.3 hardening).
6. **mDNS LAN-shortcut** — leave on; lowers latency when peer is on same LAN.
7. **Save**.
8. Server-restart may be required for the new peer connections to spin up
   (Fastify can't re-register routes after `.listen()` — same as voice-input
   plugin's spawn-on-config-change limitation).

Equivalently, edit `~/.pi/dashboard/config.json` directly:

```jsonc
{
  "plugins": {
    "federation": {
      "enabled": true,
      "machineId": "imac",
      "discoverLan": true,
      "authMode": "loopback-trusted-networks",
      "peers": [
        { "host": "100.126.219.9", "port": 8000, "machineId": "macbook", "label": "MacBook Pro" }
      ]
    }
  }
}
```

## Test

### Unit + behavioral tests

```bash
cd packages/pi-federation-plugin
npx vitest run
```

Tests cover:
- `isFederatedSession` + `machineIdOf` predicate semantics (5 tests)
- `mintFederationJwt` HS256 RFC 7519 compliance (4 tests; signature verifies
  under HMAC-SHA256)

### Smoke test against live dashboard

```bash
bash packages/pi-federation-plugin/smoke/verify-plugin-loaded.sh
```

Verifies plugin loaded + REST endpoints work + returns OK for empty + populated
peer lists.

### Cross-machine smoke (manual)

1. Install the plugin on both machines (iMac + MacBook).
2. Configure each to peer with the other (machineId + Tailscale IP).
3. Restart both dashboards.
4. From iMac browser, open `http://localhost:8000`. Sidebar should show
   `imac` sessions normally + new `macbook` sessions with a `↗ macbook` badge.
5. Verify by curl:
   ```bash
   curl -s http://localhost:8000/api/federation/sessions | jq .
   ```
   should list MacBook sessions with `imac:...` prefix.

## Architectural composition

- **With Schema 7 §3.5 (Option E)** — this plugin implements the
  WebSocket-over-Tailscale + mDNS-LAN-shortcut transport for live coordination.
- **With investigator #1 §6.3 federation-hook sketch** — same shape; this is
  the bounded-engineering MVP referenced as "concrete starting point".
- **With Option A (substrate-state sync)** — orthogonal; sister subagent
  ships rsync-over-Tailscale for substrate `.md` file sync. Together they
  form the TWO-TRANSPORT MVP per Schema 7 §4.
- **With AGENTS.md operator-state focus filter (v1.1)** — federation plugin
  client SHOULD read `~/.pi/orchestration-state/operator-state.json` before
  surfacing peer sessions. v0.1 surfaces all peer sessions unconditionally;
  v0.5 hardening adds focus-mode filtering (defer non-focus-project peers
  to a collapsed lane).
- **With Pattern 113 substrate-rev defenses** — when the design-surface plugin
  ships and federates the operator-view.html iframe across peers, this
  federation plugin MUST forward `design_surface_rerender` events; the iframe
  bakes substrate-rev in `<meta>` so staleness is detected at render-time
  per AGENTS.md § Operator-interface architecture defenses.

## Honest gaps + Bar 4 accounting

1. **Reverse-routing not implemented in v0.1** (read-only federation). Operator
   sees peer sessions but can't `send_prompt` to them locally. v0.5 candidate.
2. **`registerBrowserHandler` stub on server-side** — pi-agent-dashboard's
   `createServerPluginContext` exposes the API but the actual implementation
   in `packages/server/src/server.ts:L1190` is `(_type, _handler) => {}`
   (stub). Until the core extracts the handler-registration to a proper
   registry (see openspec changes `extract-*-as-plugin`), federation's
   inverse-routing path can't be wired. Documented as upstream blocker.
3. **WS upgrade auth verified at code level, not at handshake-time empirically**
   — investigator #1 §8 honest-uncertainty #3. Smoke test doesn't exercise
   the JWT path because the operator's current dashboard has auth disabled.
4. **Cross-machine smoke test impossible right now** — MacBook (Tailscale
   `100.126.219.9`) is reachable but `tailscale status` shows
   `"offline, last seen 50m ago"` at the time of writing. v0.1 verified
   with loopback-self-test (peer = `127.0.0.1:8000`); cross-machine validation
   deferred to operator's next two-machine session.
5. **Plugin manifest in monorepo-only**: per investigator #1 §8 #1, third-party
   `node_modules` plugin discovery is documented as Future Work. This plugin
   ships in the same monorepo as pi-agent-dashboard; npm-install distribution
   is post-MVP.
6. **bonjour-service may not load on Linux Docker without zeroconf** — mDNS
   layer fails-soft (logged + continues without LAN-shortcut). Tailscale path
   continues working.
7. **Session-id collision-by-coincidence**: if two peers both use machineId
   `local` (or same string), federated ids collide. Mitigation: configSchema
   makes machineId required + UI nudges toward conventions per AGENTS.md
   machine inventory (`imac` / `macbook` / `win`).

## Versioning + composition

- Plugin version `0.4.6` matches pi-agent-dashboard lockstep version per
  `docs/publishing-plugins.md` lockstep-versioning rule. Bump together with
  dashboard releases.
- Plugin pins `@blackbelt-technology/dashboard-plugin-runtime ^0.4.6` and
  `@blackbelt-technology/pi-dashboard-shared ^0.4.6` per investigator #1
  §7.1 #1.
- Plugin imports from `@blackbelt-technology/dashboard-plugin-runtime/context`
  + `@blackbelt-technology/dashboard-plugin-runtime/server` only — never
  `packages/client/` or `packages/server/` directly per investigator #1
  §7.1 #2 (lint suite enforces this).
