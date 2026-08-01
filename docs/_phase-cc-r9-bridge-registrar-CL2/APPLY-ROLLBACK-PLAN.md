# APPLY + ROLLBACK PLAN — bridge-pruner identity fix (dl-13727) — HELD, FOR PETE

**STATUS: HELD. DO NOT EXECUTE.** This document is a plan only. CC did NOT run any
of the steps below. No settings.json mutation, no `--register-bridge-only` run, no
restart, no deploy, no push were performed. Executing these steps is a DELIBERATE,
watched operator action reserved for Pete.

## What the fix changes
`scripts/deploy.mjs` `registerBridge` now prunes stale dashboard extension bridges by
CANONICAL PACKAGE IDENTITY (`package.json` name === `@blackbelt-technology/pi-dashboard-extension`),
authoritative for existing paths, with the old path-substring heuristic kept ONLY as a
fallback for missing/unreadable paths. See `isDashboardBridge` / `planPackages` /
`dashboardExtIdentity` at module scope in `scripts/deploy.mjs`.

## Confirmed live state (read-only observation at plan time — NOT mutated)
`~/.pi/agent/settings.json` `packages` currently contains, in order:
1. `/private/tmp/build1-pw-20260726/dashboard/release/packages/extension`  ← STALE (July-26)
2. `/Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`  ← release-211
Both declare name `@blackbelt-technology/pi-dashboard-extension`. The stale `/tmp` entry
has NO "pi-agent-dashboard"/"pi-dashboard-prod" substring, which is why the pre-fix
pruner never removed it. `~/.pi-dashboard-prod/current` → the 211f7d8 release.

## APPLY (HELD — Pete executes deliberately)
1. **Backup** the live settings with a UTC-stamped copy:
   ```sh
   cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak-$(date -u +%Y%m%dT%H%M%SZ)
   ```
2. **Run the FIXED registrar** against the REAL prod-root (so `isRealProdRoot` passes and
   it operates on live settings; an isolated `--prod-root` would SKIP):
   ```sh
   node scripts/deploy.mjs --register-bridge-only
   ```
   (Default `--prod-root` is `~/.pi-dashboard-prod`. It resolves `current` →
   `releases/211f7d8.../packages/extension` = the target, prunes every OTHER canonical
   dashboard bridge — i.e. the stale `/tmp` path — and keeps the target exactly once.)
3. **Verify** `~/.pi/agent/settings.json`:
   - the `/private/tmp/build1-pw-20260726/...` path is **ABSENT** from `packages`.
   - the release-211 extension path is present **exactly once**.
   - every non-dashboard entry (e.g. `npm:@earendil-works/pi-workflows`, `defaultProvider`,
     `defaultModel`, `thinking`, `dashboardPluginBridges`) is **intact/unchanged**.
   Quick check:
   ```sh
   node -e 'const s=require("os").homedir()+"/.pi/agent/settings.json";const j=JSON.parse(require("fs").readFileSync(s,"utf8"));const b=j.packages.filter(p=>/packages\/extension\/?$/.test(p));console.log("bridges:",b);console.log("stale /tmp present:",b.some(p=>p.includes("build1-pw-20260726")));console.log("release-211 count:",b.filter(p=>p.includes("releases/211f7d8")).length);'
   ```
   Expect: stale `/tmp` present = false; release-211 count = 1.

## ROLLBACK (HELD)
Restore the backup over the live settings:
```sh
cp ~/.pi/agent/settings.json.bak-<UTC> ~/.pi/agent/settings.json
```
(Use the exact `.bak-<UTC>` filename created in APPLY step 1.)

## CRITICAL NOTE — this does NOT repair any already-running session
Applying the fix corrects `settings.json` for **FUTURE** session loads only. Sessions
that have ALREADY loaded the stale pre-receipt extension into memory (including the
current Lane tenure-67 session) are **NOT** repaired by this settings change — they
continue running the stale in-memory tool until they are separately RELOADED. Do NOT
claim this fix repairs any already-running process. A session reload is a separate,
explicit step outside the scope of this settings fix.
