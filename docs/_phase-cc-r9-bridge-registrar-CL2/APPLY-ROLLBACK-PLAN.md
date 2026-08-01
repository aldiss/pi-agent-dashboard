# APPLY + ROLLBACK PLAN — bridge-pruner identity fix (dl-13727 / dl-13803 / dl-13808)

**STATUS: HELD. NOT EXECUTED.** This is a plan only. CC performed NO settings.json
mutation, NO `--register-bridge-only` run against the real prod-root, NO restart,
NO deploy, NO push. Every command below is for a later, gated live action.

## Ownership
The live apply is a **LANE-gated action executed by the CommsLayer driver (or Lane)** —
NOT read-only Pete. Pete is the **verifier only**: Pete re-derives own-hand and reviews
this plan + the pre/post state proofs; Pete does not run the apply. All "execute" steps
below are for the CommsLayer/Lane operator.

## What the fix changes
`scripts/deploy.mjs` `registerBridge` prunes stale dashboard extension bridges by
CANONICAL PACKAGE IDENTITY (`package.json` name === `@blackbelt-technology/pi-dashboard-extension`),
authoritative for existing paths, legacy path-substring fallback ONLY for missing/unreadable
paths (`isDashboardBridge` / `planPackages` / `dashboardExtIdentity`, module scope). The
module is importable (REPO from `import.meta.url`) and `main()` runs only on direct invocation.

## Atomicity invariant (both apply and rollback)
Every write to `~/.pi/agent/settings.json` goes through a **sibling temp file IN THE SAME
DIRECTORY** followed by `renameSync` over the target. A same-filesystem `rename` is atomic;
a cross-filesystem rename is NOT (it degrades to copy+unlink and can leave a torn file).
So the temp MUST be a sibling of `settings.json`, never in `/tmp` or elsewhere.
- Apply: `registerBridge` already writes `settings.json.deploytmp` (a sibling) then
  `renameSync(tmp, settingsPath)` — atomic. Do NOT hand-edit settings.json.
- Rollback (below): write the backup bytes to a sibling temp, JSON-validate, `renameSync` —
  atomic. NOT a plain `cp` (a `cp` is a non-atomic in-place overwrite).

## Confirmed live pre-state (read-only observation at plan time — NOT mutated)
`~/.pi/agent/settings.json` mode `644`. `packages` contains, in order:
1. `/private/tmp/build1-pw-20260726/dashboard/release/packages/extension`  ← STALE (July-26)
2. `/Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`  ← release-211
Both declare name `@blackbelt-technology/pi-dashboard-extension`. The stale `/tmp` entry has
no `pi-agent-dashboard`/`pi-dashboard-prod` substring — the pre-fix pruner's blind spot.
`~/.pi-dashboard-prod/current` → the 211f7d8 release.

## APPLY (HELD — CommsLayer/Lane executes, hash-bound)
Let `S = ~/.pi/agent/settings.json`, `UTC = $(date -u +%Y%m%dT%H%M%SZ)`.

1. **Capture pre-state** (hash + mode):
   ```sh
   PRE_SHA=$(shasum -a 256 "$S" | awk '{print $1}')
   PRE_MODE=$(stat -f '%Lp' "$S")   # octal, e.g. 644
   echo "pre: sha256=$PRE_SHA mode=$PRE_MODE"
   ```
2. **Backup atomically** (exact bytes, same-directory temp, preserve mode; record hash):
   ```sh
   BAK="$S.bak-$UTC"
   TMP_B="$S.bak-$UTC.tmp"          # sibling temp (same dir = same fs)
   cat "$S" > "$TMP_B"             # exact bytes
   chmod "$PRE_MODE" "$TMP_B"
   mv "$TMP_B" "$BAK"             # atomic same-fs rename
   BAK_SHA=$(shasum -a 256 "$BAK" | awk '{print $1}')
   test "$BAK_SHA" = "$PRE_SHA" || { echo "BACKUP HASH MISMATCH — abort"; exit 1; }
   ```
3. **Apply** (the FIXED registrar; writes via its own `.deploytmp` sibling + atomic rename;
   default `--prod-root` is `~/.pi-dashboard-prod` so `isRealProdRoot` passes and it operates
   on live settings — an isolated `--prod-root` would SKIP):
   ```sh
   node scripts/deploy.mjs --register-bridge-only
   ```
4. **Post-apply verify** (valid JSON; stale absent; release once; unrelated byte-identical):
   ```sh
   node -e '
     const fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto");
     const S=path.join(os.homedir(),".pi","agent","settings.json");
     const preRaw=fs.readFileSync(process.argv[1],"utf8");   // the .bak-<UTC>
     const postRaw=fs.readFileSync(S,"utf8");
     const pre=JSON.parse(preRaw), post=JSON.parse(postRaw); // post must be valid JSON
     const isBridge=p=>/packages[\/\\]extension\/?$/.test(p);
     const bridges=(post.packages||[]).filter(isBridge);
     console.log("post sha256:", crypto.createHash("sha256").update(postRaw).digest("hex"));
     console.log("stale /tmp absent:", !bridges.some(p=>p.includes("build1-pw-")));
     console.log("release-211 count:", bridges.filter(p=>p.includes("releases/211f7d8")).length, "(expect 1)");
     // Mask dashboard-managed entries, compare the rest byte-for-byte (JSON-normalized).
     const mask=o=>{const c=JSON.parse(JSON.stringify(o));
       c.packages=(c.packages||[]).filter(p=>!isBridge(p));
       c.dashboardPluginBridges=Object.fromEntries(Object.entries(c.dashboardPluginBridges||{}).filter(([k])=>!k.startsWith("dashboard-")));
       return c;};
     console.log("unrelated byte-identical:", JSON.stringify(mask(pre))===JSON.stringify(mask(post)));
   ' "$BAK"
   ```
   Expect: `stale /tmp absent: true`, `release-211 count: 1`, `unrelated byte-identical: true`.
   Record the printed `post sha256`.

## ROLLBACK (HELD — CommsLayer/Lane, atomic, hash-proven)
Restore the exact backup bytes atomically (same-directory temp + JSON-validate + atomic
rename + restore mode), then PROVE full restore. NOT a plain `cp`.
```sh
S="$HOME/.pi/agent/settings.json"; BAK="$S.bak-<UTC>"   # the exact filename from APPLY step 2
TMP_R="$S.rollback.tmp"                                   # sibling temp (same dir = same fs)
cat "$BAK" > "$TMP_R"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP_R"   # validate JSON or abort
chmod "$PRE_MODE" "$TMP_R"
mv "$TMP_R" "$S"                                          # atomic same-fs swap
# Prove full restore: hash === recorded pre-state, and unrelated state byte-identical.
POST_SHA=$(shasum -a 256 "$S" | awk '{print $1}')
test "$POST_SHA" = "$PRE_SHA" && echo "ROLLBACK OK: settings.json sha256 === pre-state" || echo "ROLLBACK MISMATCH — investigate"
```
Because the backup is the exact pre-apply bytes, `POST_SHA === PRE_SHA` proves EVERY key
(dashboard and non-dashboard alike) is byte-identical to pre-state — a full unrelated-state
restoration, not merely the masked subset.

## CRITICAL NOTE — does NOT repair any already-running session
Applying corrects `settings.json` for **FUTURE** session loads only. Sessions that have
ALREADY loaded the stale pre-receipt extension into memory (including the current Lane
tenure-67 session) are **NOT** repaired by this settings change — they keep running the
stale in-memory tool until separately RELOADED. Do NOT claim this fix repairs any
already-running process; a session reload is a distinct, out-of-scope step.
