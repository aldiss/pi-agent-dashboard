# APPLY + ROLLBACK PLAN — bridge-pruner identity fix (dl-13727 / dl-13803 / dl-13808 / dl-13823 / dl-13824 / dl-13827)

**STATUS: HELD. NOT EXECUTED.** This is a plan only. NO settings.json mutation, NO
`--register-bridge-only` against the real prod-root, NO restart, NO deploy, NO push has been
performed. Every command below is for a later, Lane-gated live action.

**r12 amendment (docs-only, dl-13827):** the r11 plan's post-verify failure path only *printed*
`roll back now` and exited 1 — it never invoked the rollback, so a rejected settings write could
stay live and recovery became a second manual action (a §23 violation — rollback must be
automatic). r12 makes APPLY **one self-contained transaction**: rollback is a **callable
hash-bound procedure defined before apply**, and any failure (registrar / post-verify / receipt)
**auto-invokes** it, emits an `applyFAIL` + `rollback` receipt, **proves final bytes+mode == PRE**,
then exits nonzero. The `e6ae9b9` code/tests are unchanged and immutable; docs-only.

**r11 (dl-13823/dl-13824):** hard-fail executable verifiers, clean-exact-e6 precondition, PRE
recheck, exact target/plugin/unrelated/mode assertions, sibling-temp atomic rollback, receipt
schema — all retained below.

## Ownership
The live apply is a **LANE-gated action executed by the CommsLayer driver (or Lane)** —
NOT read-only Pete. Pete is the **verifier only**: Pete re-derives own-hand and reviews this
plan + the emitted receipts; Pete does not run the apply. All "execute" steps below are for the
CommsLayer/Lane operator.

## What the fix changes
`scripts/deploy.mjs` `registerBridge` prunes stale dashboard extension bridges by CANONICAL
PACKAGE IDENTITY (`package.json` name === `@blackbelt-technology/pi-dashboard-extension`),
authoritative for existing paths, legacy path-substring fallback ONLY for missing/unreadable
paths (`isDashboardBridge` / `planPackages` / `dashboardExtIdentity`, module scope). The module
is importable (`REPO` from `import.meta.url`) and `main()` runs only on direct invocation.

## Atomicity invariant (both apply and rollback)
Every write to `~/.pi/agent/settings.json` goes through a **sibling temp file IN THE SAME
DIRECTORY** followed by `renameSync` over the target. A same-filesystem `rename` is atomic; a
cross-filesystem rename is NOT (it degrades to copy+unlink and can leave a torn file). So the temp
MUST be a sibling of `settings.json`, never `/tmp`.
- Apply: `registerBridge` writes `settings.json.deploytmp` (a sibling) then
  `renameSync(tmp, settingsPath)` — atomic. Do NOT hand-edit settings.json.
- Rollback: writes backup bytes to a sibling temp, JSON-validate, `chmod`, `renameSync` —
  atomic. NEVER a plain `cp` (a non-atomic in-place overwrite).

## Confirmed live pre-state (read-only observation at plan time — NOT mutated)
`~/.pi/agent/settings.json` mode `644`. `packages` contains, in order:
1. `/private/tmp/build1-pw-20260726/dashboard/release/packages/extension`  ← STALE (July-26)
2. `/Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`  ← release-211
Both declare name `@blackbelt-technology/pi-dashboard-extension`. The stale `/tmp` entry has no
`pi-agent-dashboard`/`pi-dashboard-prod` substring — the pre-fix pruner's blind spot.
`~/.pi-dashboard-prod/current` → the 211f7d8 release. Derived expected post-apply values (computed
own-hand the same way `registerBridge` derives them — `releaseRoot = realpathSync(prodRoot/current)`):
- `expectedTarget = /Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/extension`
- `expectedPlugin = /Users/vdrobkov/.pi-dashboard-prod/releases/211f7d8100301d17218412156c738369fb2b635a/packages/flows-anthropic-bridge-plugin/src/bridge/index.ts`

---

## FIRE-TIME PRECONDITION — exact clean-e6 binding (hard-fail, run FIRST)
Binds the apply to the exact verified code. Any failure exits nonzero and aborts (no apply, so
nothing to roll back).
```sh
set -u
WT="/Users/vdrobkov/build1-picker-cand-e0-wt"
E6="e6ae9b9756b9daaba3341d7d5a2c89dc5b998cde"
E6_DEPLOY_BLOB="60db298023cf3baa7749ea89829374e8045d783a"   # git blob of e6:scripts/deploy.mjs
test "$( (cd "$WT" && git hash-object scripts/deploy.mjs) )" = "$E6_DEPLOY_BLOB" \
  || { echo "PRECOND FAIL: deploy.mjs blob != e6"; exit 1; }
git -C "$WT" diff --quiet "$E6" -- scripts/ \
  || { echo "PRECOND FAIL: scripts/ differs from e6"; exit 1; }
test -z "$(git -C "$WT" status --porcelain)" \
  || { echo "PRECOND FAIL: worktree dirty"; exit 1; }
DEPLOY="$WT/scripts/deploy.mjs"   # bind the apply to THIS verified script
echo "PRECOND OK: bound to e6 deploy.mjs ($E6_DEPLOY_BLOB)"
```

## APPLY — one self-contained transaction (auto-rollback on ANY failure; HELD)
Run the whole block in ONE shell. On registrar OR post-verify OR receipt failure the transaction
**automatically** calls `rollback()`, emits an `applyFAIL` receipt + a `rollback` receipt, proves
final bytes+mode == PRE, and exits nonzero. Rollback is never a manual second step (§23).
```sh
set -u
S="$HOME/.pi/agent/settings.json"; UTC="$(date -u +%Y%m%dT%H%M%SZ)"
RECEIPT_APPLY="$S.apply-receipt-$UTC.json"; RECEIPT_RB="$S.rollback-receipt-$UTC.json"

# 1. capture pre-state (sha + mode)
PRE_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); PRE_MODE=$(stat -f '%Lp' "$S")
echo "pre: sha256=$PRE_SHA mode=$PRE_MODE"

# 2. backup atomically (exact bytes, sibling temp, preserve mode); backup-hash MUST equal pre.
#    Nothing has been applied yet -> a failure here is a plain abort (no rollback needed).
BAK="$S.bak-$UTC"; TMP_B="$S.bak-$UTC.tmp"          # sibling temp = same fs
cat "$S" > "$TMP_B"; chmod "$PRE_MODE" "$TMP_B"; mv "$TMP_B" "$BAK"   # atomic
test "$(shasum -a 256 "$BAK" | awk '{print $1}')" = "$PRE_SHA" \
  || { echo "BACKUP HASH MISMATCH — abort (nothing applied)"; exit 1; }

# --- rollback(): callable, hash-bound, atomic. Restores exact PRE bytes; proves sha+mode==PRE. ---
#     Defined BEFORE apply so it is available the instant apply runs.
rollback() {
  reason="$1"; TMP_R="$S.rollback.tmp"                # sibling temp = same fs
  cat "$BAK" > "$TMP_R"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP_R" \
    || { echo "ROLLBACK ABORT: backup not valid JSON — MANUAL: restore $BAK"; rm -f "$TMP_R"; return 2; }
  chmod "$PRE_MODE" "$TMP_R"; mv "$TMP_R" "$S"        # atomic same-fs swap
  RB_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); RB_MODE=$(stat -f '%Lp' "$S")
  RES=FAIL; { [ "$RB_SHA" = "$PRE_SHA" ] && [ "$RB_MODE" = "$PRE_MODE" ]; } && RES=PASS
  printf '{"phase":"rollback","ts_utc":"%s","reason":"%s","restored_sha":"%s","pre_sha":"%s","restored_mode":"%s","pre_mode":"%s","result":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$reason" "$RB_SHA" "$PRE_SHA" "$RB_MODE" "$PRE_MODE" "$RES" | tee "$RECEIPT_RB"
  [ "$RES" = PASS ] || return 1     # final bytes+mode != PRE -> hard fail
  return 0
}

# --- fail_apply(): the automatic failure path. applyFAIL receipt + auto-rollback + prove==PRE + exit. ---
fail_apply() {
  reason="$1"
  # keep the verifier's detailed FAIL receipt if it already wrote one; else emit a minimal applyFAIL
  [ -f "$RECEIPT_APPLY" ] || printf '{"phase":"apply","result":"FAIL","reason":"%s","ts_utc":"%s"}\n' \
    "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RECEIPT_APPLY"
  echo "APPLY FAILED ($reason) — auto-rolling back"
  if rollback "$reason"; then
    echo "AUTO-ROLLBACK OK: final bytes+mode == PRE (receipts: $RECEIPT_APPLY + $RECEIPT_RB)"; exit 1
  else
    echo "AUTO-ROLLBACK DID NOT REACH PRE — MANUAL INTERVENTION; backup=$BAK"; exit 2
  fi
}

# 3. immediate fire-time PRE recheck (still nothing applied -> plain abort)
NOW_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); NOW_MODE=$(stat -f '%Lp' "$S")
{ [ "$NOW_SHA" = "$PRE_SHA" ] && [ "$NOW_MODE" = "$PRE_MODE" ]; } \
  || { echo "FIRE-TIME FAIL: settings changed since capture — abort (nothing applied)"; exit 1; }

# 4. APPLY (the e6-bound FIXED registrar; writes via its own .deploytmp sibling + atomic rename;
#    default --prod-root is ~/.pi-dashboard-prod so isRealProdRoot passes — isolated would SKIP).
#    On nonzero exit -> auto-rollback.
node "$DEPLOY" --register-bridge-only || fail_apply "registrar-nonzero-exit"

# 5. post-apply HARD verify -> apply receipt (result PASS/FAIL). On FAIL -> auto-rollback.
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
test "${PIPESTATUS[0]}" = "0" || fail_apply "postverify-failed"

echo "APPLY VERIFIED PASS — receipt: $RECEIPT_APPLY (no rollback needed)"
```

## Manual / standalone ROLLBACK (same `rollback()` procedure — if ever needed after a PASSED apply)
The apply block auto-rolls-back on failure. Should a problem be found AFTER a passed apply, run the
identical hash-bound atomic procedure by hand (NO plain `cp`, NO `|| echo` success path):
```sh
S="$HOME/.pi/agent/settings.json"; BAK="$S.bak-<UTC>"   # exact filename from APPLY step 2
# PRE_SHA / PRE_MODE / UTC as recorded at apply time
TMP_R="$S.rollback.tmp"
cat "$BAK" > "$TMP_R"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$TMP_R" \
  || { echo "ROLLBACK ABORT: backup not valid JSON"; rm -f "$TMP_R"; exit 1; }
chmod "$PRE_MODE" "$TMP_R"; mv "$TMP_R" "$S"              # atomic same-fs swap
RB_SHA=$(shasum -a 256 "$S" | awk '{print $1}'); RB_MODE=$(stat -f '%Lp' "$S")
test "$RB_SHA" = "$PRE_SHA" || { echo "ROLLBACK FAIL: sha $RB_SHA != PRE $PRE_SHA"; exit 1; }
test "$RB_MODE" = "$PRE_MODE" || { echo "ROLLBACK FAIL: mode $RB_MODE != PRE $PRE_MODE"; exit 1; }
printf '{"phase":"rollback","ts_utc":"%s","restored_sha":"%s","pre_sha":"%s","restored_mode":"%s","pre_mode":"%s","result":"PASS"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RB_SHA" "$PRE_SHA" "$RB_MODE" "$PRE_MODE" | tee "$S.rollback-receipt-<UTC>.json"
```
Because the backup is the exact pre-apply bytes and `RB_SHA === PRE_SHA` is a hard gate, a PASS
proves EVERY key (dashboard and non-dashboard alike) is byte-identical to pre-state — a full
unrelated-state restoration, not merely the masked subset.

## Own-hand proof (temp fixture — never live settings)
- `tests/r11-verifier-hardfail-proof.txt` — the post-apply verifier PASSes a correct post-state
  (exit 0) and FAILs a stale-present post-state (exit 1).
- `tests/r12-forced-failure-autorollback-proof.txt` — a forced post-verify failure drives the
  transaction control flow: the auto-rollback fires, the temp settings are restored to PRE
  (sha + mode), and the overall run exits nonzero — with the happy path (PASS, no rollback,
  exit 0) shown alongside.

## Receipt schema (all phases; result=FAIL ⇒ the transaction already auto-rolled-back + exited nonzero)
**apply receipt** (`$S.apply-receipt-<UTC>.json`):
| field | meaning |
|---|---|
| `phase` | `"apply"` |
| `ts_utc` | genuine UTC (`date -u`) of the verify |
| `candidate_code` | `e6ae9b9…` — the code the apply was bound to |
| `post_sha` | sha256 of the written settings.json |
| `expected_target` / `target_bridges` | derived release target / actual dashboard bridge set |
| `expected_plugin` / `plugin_actual` | derived release plugin-bridge / written value |
| `mode` / `pre_mode` | post mode / pre mode (octal) |
| `checks{}` | `stale_absent, target_exact_once, plugin_exact, no_stale_plugin, unrelated_byte_identical, mode_ok` — all must be `true` |
| `result` | `PASS` iff every check true; else `FAIL` (→ auto-rollback) |
| `failed_checks[]` | the specific failed assertions (empty on PASS) |

(registrar-fail before the verifier runs: a minimal `{phase:"apply",result:"FAIL",reason,ts_utc}`
receipt is emitted by `fail_apply`.)

**rollback receipt** (`$S.rollback-receipt-<UTC>.json`): `phase, ts_utc, reason, restored_sha,
pre_sha, restored_mode, pre_mode, result`. `result=PASS` iff `restored_sha === pre_sha` AND
`restored_mode === pre_mode` — the proof of full restore. A `result=FAIL` here means the rollback
did not reach PRE → the transaction exits `2` and flags manual intervention (the backup is intact).

## CRITICAL NOTE — does NOT repair any already-running session
Applying corrects `settings.json` for **FUTURE** session loads only. Sessions that have ALREADY
loaded the stale pre-receipt extension into memory (including the current Lane tenure-67 session)
are **NOT** repaired by this settings change — they keep running the stale in-memory tool until
separately RELOADED. Do NOT claim this fix repairs any already-running process; a session reload
is a distinct, out-of-scope step.
