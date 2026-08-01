# APPLY + ROLLBACK PLAN — bridge-pruner identity fix (dl-13727 / dl-13803 / dl-13808 / dl-13823 / dl-13824)

**STATUS: HELD. NOT EXECUTED.** This is a plan only. NO settings.json mutation, NO
`--register-bridge-only` against the real prod-root, NO restart, NO deploy, NO push has
been performed. Every command below is for a later, Lane-gated live action.

**r11 amendment (docs-only, dl-13823 / dl-13824):** the r10 plan's verifiers only *printed*
booleans / `echo OK || echo MISMATCH` and exited 0 even on mismatch. This revision makes
**every** pre-, post-apply and rollback condition executable and **exit nonzero on any
mismatch**, binds the apply to the exact clean `e6ae9b9` code, adds an immediate fire-time
`PRE_SHA`/`PRE_MODE` recheck, asserts the **exact** target/plugin/unrelated-state/mode, and
emits a machine-checkable **receipt**. The `e6ae9b9` code/tests/evidence are unchanged and
immutable; this is a docs-only amendment.

## Ownership
The live apply is a **LANE-gated action executed by the CommsLayer driver (or Lane)** —
NOT read-only Pete. Pete is the **verifier only**: Pete re-derives own-hand and reviews this
plan + the emitted receipts; Pete does not run the apply. All "execute" steps below are for
the CommsLayer/Lane operator.

## What the fix changes
`scripts/deploy.mjs` `registerBridge` prunes stale dashboard extension bridges by CANONICAL
PACKAGE IDENTITY (`package.json` name === `@blackbelt-technology/pi-dashboard-extension`),
authoritative for existing paths, legacy path-substring fallback ONLY for missing/unreadable
paths (`isDashboardBridge` / `planPackages` / `dashboardExtIdentity`, module scope). The module
is importable (`REPO` from `import.meta.url`) and `main()` runs only on direct invocation.

## Atomicity invariant (both apply and rollback)
Every write to `~/.pi/agent/settings.json` goes through a **sibling temp file IN THE SAME
DIRECTORY** followed by `renameSync` over the target. A same-filesystem `rename` is atomic; a
cross-filesystem rename is NOT (it degrades to copy+unlink and can leave a torn file). So the
temp MUST be a sibling of `settings.json`, never `/tmp`.
- Apply: `registerBridge` writes `settings.json.deploytmp` (a sibling) then
  `renameSync(tmp, settingsPath)` — atomic. Do NOT hand-edit settings.json.
- Rollback: write backup bytes to a sibling temp, JSON-validate, `chmod`, `renameSync` —
  atomic. NEVER a plain `cp` (a non-atomic in-place overwrite).

## Confirmed live pre-state (read-only observation at plan time — NOT mutated)
`~/.pi/agent/settings.json` mode `644`. `packages` contains, in order:
1. `/private/tmp/build1-pw-20260726/dashboard/release/packages/extension`  ← STALE (July-26)
2. `/Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`  ← release-211
Both declare name `@blackbelt-technology/pi-dashboard-extension`. The stale `/tmp` entry has no
`pi-agent-dashboard`/`pi-dashboard-prod` substring — the pre-fix pruner's blind spot.
`~/.pi-dashboard-prod/current` → the 211f7d8 release. Derived expected post-apply values
(computed own-hand the same way `registerBridge` derives them — `releaseRoot =
realpathSync(prodRoot/current)`):
- `expectedTarget = /Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`
- `expectedPlugin = /Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/flows-anthropic-bridge-plugin/src/bridge/index.ts`

---

## FIRE-TIME PRECONDITION — exact clean-e6 binding (hard-fail, run FIRST)
Binds the apply to the exact verified code. Any failure exits nonzero and aborts (no apply).
```sh
set -u
WT="/Users/vdrobkov/build1-picker-cand-e0-wt"
E6="e6ae9b9756b9daaba3341d7d5a2c89dc5b998cde"
E6_DEPLOY_BLOB="60db298023cf3baa7749ea89829374e8045d783a"   # git blob of e6:scripts/deploy.mjs
# (a) the executing deploy.mjs is byte-identical to the e6-verified code
test "$( (cd "$WT" && git hash-object scripts/deploy.mjs) )" = "$E6_DEPLOY_BLOB" \
  || { echo "PRECOND FAIL: deploy.mjs blob != e6"; exit 1; }
# (b) no code drift from e6 (docs-only commits on top are allowed; scripts/ must equal e6)
git -C "$WT" diff --quiet "$E6" -- scripts/ \
  || { echo "PRECOND FAIL: scripts/ differs from e6"; exit 1; }
# (c) clean worktree (no uncommitted changes anywhere)
test -z "$(git -C "$WT" status --porcelain)" \
  || { echo "PRECOND FAIL: worktree dirty"; exit 1; }
DEPLOY="$WT/scripts/deploy.mjs"   # bind the apply to THIS verified script
echo "PRECOND OK: bound to e6 deploy.mjs ($E6_DEPLOY_BLOB)"
```

## APPLY (HELD — CommsLayer/Lane executes, hash-bound, hard-fail)
Let `S=~/.pi/agent/settings.json`, `UTC=$(date -u +%Y%m%dT%H%M%SZ)`.

**1. Capture pre-state (sha + mode):**
```sh
S="$HOME/.pi/agent/settings.json"; UTC="$(date -u +%Y%m%dT%H%M%SZ)"
PRE_SHA=$(shasum -a 256 "$S" | awk '{print $1}')
PRE_MODE=$(stat -f '%Lp' "$S")          # octal, e.g. 644
echo "pre: sha256=$PRE_SHA mode=$PRE_MODE"
```

**2. Backup atomically (exact bytes, sibling temp, preserve mode; backup-hash MUST equal pre):**
```sh
BAK="$S.bak-$UTC"; TMP_B="$S.bak-$UTC.tmp"      # sibling temp = same fs
cat "$S" > "$TMP_B"; chmod "$PRE_MODE" "$TMP_B"; mv "$TMP_B" "$BAK"   # atomic
BAK_SHA=$(shasum -a 256 "$BAK" | awk '{print $1}')
test "$BAK_SHA" = "$PRE_SHA" || { echo "BACKUP HASH MISMATCH — abort"; exit 1; }
```

**3. Immediate fire-time PRE recheck (live settings must STILL equal pre, right before apply):**
```sh
NOW_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); NOW_MODE=$(stat -f '%Lp' "$S")
test "$NOW_SHA" = "$PRE_SHA" || { echo "FIRE-TIME FAIL: settings sha changed since capture ($NOW_SHA != $PRE_SHA)"; exit 1; }
test "$NOW_MODE" = "$PRE_MODE" || { echo "FIRE-TIME FAIL: settings mode changed since capture ($NOW_MODE != $PRE_MODE)"; exit 1; }
```

**4. Apply (the e6-bound FIXED registrar; writes via its own `.deploytmp` sibling + atomic
rename; default `--prod-root` is `~/.pi-dashboard-prod` so `isRealProdRoot` passes — an
isolated `--prod-root` would SKIP):**
```sh
node "$DEPLOY" --register-bridge-only
```

**5. Post-apply HARD verify (exit nonzero on ANY mismatch; emits the apply receipt).**
Asserts, executably: valid JSON; stale `/tmp` absent; dashboard bridge set === `[expectedTarget]`
exactly (exactly once); `dashboard-flows-anthropic-bridge` === `expectedPlugin`; no stale
`dashboard-*` plugin value (every one under `releaseRoot`); unrelated state byte-identical to
pre; mode === pre-mode. On FAIL → exit 1 → roll back.
```sh
RECEIPT_APPLY="$S.apply-receipt-$UTC.json"
BAK="$BAK" PRE_MODE="$PRE_MODE" UTC_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
node --input-type=module <<'NODE' | tee "$RECEIPT_APPLY"
import { readFileSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
const S = join(homedir(), ".pi", "agent", "settings.json");
const BAK = process.env.BAK, PRE_MODE = process.env.PRE_MODE;
const prodRoot = join(homedir(), ".pi-dashboard-prod");
const releaseRoot = realpathSync(join(prodRoot, "current"));
const expectedTarget = join(releaseRoot, "packages", "extension");
const expectedPlugin = join(releaseRoot, "packages", "flows-anthropic-bridge-plugin", "src", "bridge", "index.ts");
const preRaw = readFileSync(BAK, "utf8"), postRaw = readFileSync(S, "utf8");
const pre = JSON.parse(preRaw);
const fails = [];
let post = null;
try { post = JSON.parse(postRaw); } catch (e) { fails.push("post-not-valid-json:" + e.message); }
const isBridge = p => /packages[\/\\]extension\/?$/.test(p);
const bridges = post ? (post.packages || []).filter(isBridge) : [];
const pb = (post && post.dashboardPluginBridges) || {};
const chkStale = !bridges.some(p => p.includes("build1-pw-"));
const chkTarget = bridges.length === 1 && bridges[0] === expectedTarget;
const chkPlugin = pb["dashboard-flows-anthropic-bridge"] === expectedPlugin;
const chkNoStalePB = Object.entries(pb).every(([k, v]) => !k.startsWith("dashboard-") || String(v).startsWith(releaseRoot + "/"));
const mask = o => { const c = JSON.parse(JSON.stringify(o));
  c.packages = (c.packages || []).filter(p => !isBridge(p));
  c.dashboardPluginBridges = Object.fromEntries(Object.entries(c.dashboardPluginBridges || {}).filter(([k]) => !k.startsWith("dashboard-")));
  return c; };
const chkUnrelated = post ? JSON.stringify(mask(pre)) === JSON.stringify(mask(post)) : false;
const mode = (statSync(S).mode & 0o777).toString(8);
const chkMode = mode === PRE_MODE;
if (!chkStale) fails.push("stale-tmp-bridge-present:" + JSON.stringify(bridges));
if (!chkTarget) fails.push("target-not-exactly-[expectedTarget]:" + JSON.stringify(bridges));
if (!chkPlugin) fails.push("plugin-not-exact:" + (pb["dashboard-flows-anthropic-bridge"] || null));
if (!chkNoStalePB) fails.push("stale-dashboard-plugin-value");
if (!chkUnrelated) fails.push("unrelated-state-changed");
if (!chkMode) fails.push("mode-changed:" + mode + "!=" + PRE_MODE);
const receipt = {
  phase: "apply", ts_utc: process.env.UTC_TS, candidate_code: "e6ae9b9756b9daaba3341d7d5a2c89dc5b998cde",
  post_sha: createHash("sha256").update(postRaw).digest("hex"),
  expected_target: expectedTarget, target_bridges: bridges,
  expected_plugin: expectedPlugin, plugin_actual: pb["dashboard-flows-anthropic-bridge"] || null,
  mode, pre_mode: PRE_MODE,
  checks: { stale_absent: chkStale, target_exact_once: chkTarget, plugin_exact: chkPlugin, no_stale_plugin: chkNoStalePB, unrelated_byte_identical: chkUnrelated, mode_ok: chkMode },
  result: fails.length === 0 ? "PASS" : "FAIL", failed_checks: fails,
};
process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
process.exit(fails.length === 0 ? 0 : 1);
NODE
test "${PIPESTATUS[0]}" = "0" || { echo "POST-APPLY VERIFY FAILED — see $RECEIPT_APPLY; roll back now"; exit 1; }
echo "APPLY VERIFIED PASS — receipt: $RECEIPT_APPLY"
```

## ROLLBACK (HELD — CommsLayer/Lane, atomic, hash+mode hard-fail)
Restore exact backup bytes atomically (sibling temp + JSON-validate + chmod + atomic rename),
then PROVE full restore by sha AND mode. NO plain `cp`; NO `|| echo` success path.
```sh
S="$HOME/.pi/agent/settings.json"; BAK="$S.bak-<UTC>"   # exact filename from APPLY step 2
# PRE_SHA / PRE_MODE / UTC as recorded at apply time
TMP_R="$S.rollback.tmp"                                   # sibling temp = same fs
cat "$BAK" > "$TMP_R"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP_R" \
  || { echo "ROLLBACK ABORT: backup not valid JSON"; rm -f "$TMP_R"; exit 1; }
chmod "$PRE_MODE" "$TMP_R"
mv "$TMP_R" "$S"                                          # atomic same-fs swap
RB_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); RB_MODE=$(stat -f '%Lp' "$S")
test "$RB_SHA" = "$PRE_SHA" || { echo "ROLLBACK FAIL: sha $RB_SHA != PRE $PRE_SHA"; exit 1; }
test "$RB_MODE" = "$PRE_MODE" || { echo "ROLLBACK FAIL: mode $RB_MODE != PRE $PRE_MODE"; exit 1; }
printf '{"phase":"rollback","ts_utc":"%s","restored_sha":"%s","pre_sha":"%s","restored_mode":"%s","pre_mode":"%s","result":"PASS"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RB_SHA" "$PRE_SHA" "$RB_MODE" "$PRE_MODE" | tee "$S.rollback-receipt-<UTC>.json"
```
Because the backup is the exact pre-apply bytes and `RB_SHA === PRE_SHA` is a hard gate, a PASS
proves EVERY key (dashboard and non-dashboard alike) is byte-identical to pre-state — a full
unrelated-state restoration, not merely the masked subset.

## Receipt schema (both phases; result=FAIL ⇒ the emitting command already exited nonzero)
**apply receipt** (`$S.apply-receipt-<UTC>.json`):
| field | meaning |
|---|---|
| `phase` | `"apply"` |
| `ts_utc` | genuine UTC (`date -u`) of the verify |
| `candidate_code` | `e6ae9b9…` — the code the apply was bound to |
| `post_sha` | sha256 of the written settings.json |
| `expected_target` / `target_bridges` | the derived release target / the actual dashboard bridge set |
| `expected_plugin` / `plugin_actual` | derived release plugin-bridge / the written value |
| `mode` / `pre_mode` | post mode / pre mode (octal) |
| `checks{}` | `stale_absent, target_exact_once, plugin_exact, no_stale_plugin, unrelated_byte_identical, mode_ok` — all must be `true` |
| `result` | `PASS` iff every check true; else `FAIL` |
| `failed_checks[]` | the specific failed assertions (empty on PASS) |

**rollback receipt** (`$S.rollback-receipt-<UTC>.json`): `phase, ts_utc, restored_sha, pre_sha,
restored_mode, pre_mode, result` — only written on the PASS path (a mismatch exits nonzero before
emit). `restored_sha === pre_sha` AND `restored_mode === pre_mode` are the proof of full restore.

## CRITICAL NOTE — does NOT repair any already-running session
Applying corrects `settings.json` for **FUTURE** session loads only. Sessions that have ALREADY
loaded the stale pre-receipt extension into memory (including the current Lane tenure-67 session)
are **NOT** repaired by this settings change — they keep running the stale in-memory tool until
separately RELOADED. Do NOT claim this fix repairs any already-running process; a session reload
is a distinct, out-of-scope step.
