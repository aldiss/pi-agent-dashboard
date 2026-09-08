# Deployment test gate — verified result

## Covered snapshot

Gate implementation verified at `34b776f6e7115da97130376125d54a46f6d0c8a8`.
Source commits above `b151dad9`:

- `a08586d6`: full-suite gate and safe build-only deployment.
- `123fa358`: prune already-ignored directories before source-lint traversal.
- `938a2e7a`: await the real lazy syntax-highlighting import in its test.
- `34b776f6`: direct OAuth callback test requests to the IPv4 listener they start.

This report proves that gate snapshot. It does not claim a later integration containing additional runtime changes has passed merely because this snapshot did.

## Final independent verification

Machine: iMac, Darwin x86_64, Node 22.22.3.
Temporary root: `/private/tmp/sessiontree-gate-2BJfQC`.
Existing checkout, services and user configuration untouched. Verification used a fresh repo, HOME, and deployment root. No production cutover or `--skip-tests`.

The exact Git snapshot and history were transferred through a bundle; SHA-256 matched on both machines. A one-token broken control was generated from the exact final tree with a temporary Git index. The working tree stayed restored.

| Check | Result |
|---|---|
| Full normal checkout `npm test` | Exit 0; 7,521 passed, 18 pre-existing skips; 703 test files passed, 3 skipped |
| Node gate/safety contracts | 28 passed, zero failed |
| Deliberately broken committed archive | Exit 1; exactly one new failing identity: `platform-git.test.ts > other recipe argv shapes > GIT_HEAD_SHA (full)` |
| Restored committed archive | Exit 0; 7,514 passed, zero failed, 25 skipped; full root test command, no whole-file exclusions |
| Comparator result | Zero known failures, zero new failures, 18 baseline failures resolved |
| Build-only boundary | Isolated `current` still names baseline `b151dad9`; validated candidate stamped with exact final SHA |

Negative control commit: `068364283190647cd38ec84fc0d49280f54cec26` in the isolated verification repo. It changes only the full `GIT_HEAD_SHA` recipe's `HEAD` argument to `HEAD_GATE_CONTROL`. The gate named that exact new failing assertion; unrelated runner failure was not counted as a successful control.

Final positive build completed at **2026-09-08T11:05:58Z**.

Commands, from the isolated repo:

```sh
npm ci
npm test
node scripts/deploy.mjs --ref negative-control --prod-root /private/tmp/sessiontree-gate-2BJfQC/prod
node scripts/deploy.mjs --ref main --prod-root /private/tmp/sessiontree-gate-2BJfQC/prod
```

The negative command must fail; the positive command must pass. No `--restart` is used during validation.

Durable copied evidence and SHA-256 inventory:
`~/.pi/cells/dashboard-multiruntime-and-tree/v1/_verification/gate-imac-34b776f6/`.
Contains `checkout.log`, `negative.log`, `positive.log`, `result.json`, `control.diff`, refs, machine details, and `hashes.json`.

## What changed, and what did not

### Comparator provenance

The baseline comparator already landed in `956511f5` and remained in `b151dad9`. Earlier claims that it was missing came from invoking the older script in a checkout still on `8fec696c`. Run the deployment script from the intended source checkout; updating a ref does not update the checked-out script.

### Git archive preconditions

Only seven assertions that require the checkout's `.git` skip when it is absent. Both a `.git` directory and a worktree's `.git` file satisfy the precondition. Normal checkout runs all 24 Git tests. Archive runs the remaining 17 pure/fallback tests. No whole Git test file is excluded by the gate.

### Process liveness

The lint failure was a genuine direct `process.kill(pid, 0)` call in `driver-liveness.ts`, not release-layout corruption. It now uses the shared process primitive. The shared helper retains `EPERM = alive`; a regression test covers that behavior. The lint's allowlist and assertions are unchanged.

### Rendering tests

The seven original ChatView failures assumed tool activity was visible by default. Tests now assert the hidden state, use the real `Show all activity` control, then keep their tool/status/order assertions. The product component is unchanged. DOM cleanup prevents another test's mounted view from satisfying a query.

The Markdown highlighting test awaits the real lazy import before asserting highlighted output. No mock highlighter or longer timeout was introduced.

### Source-lint work

Traversal prunes directories that were already excluded from results. Include globs, result filters, zero-reference assertions, and timeout remain unchanged. An injected source violation was observed failing, followed by a restored pass.

### OAuth callback test target

The test-owned listener binds `127.0.0.1`, but its helper requested `localhost`. On the iMac, that resolved first to `::1`, where other existing processes owned the same fixed ports. Four tests received HTTP 400 from those unrelated listeners. The helper now targets `127.0.0.1`; all seven callback tests passed. No product code, callback assertion, timeout or port changed. Unrelated listeners were not stopped.

### Deployment safety

Default deployment now only archives, installs, builds, tests and stamps a fresh candidate. It neither repoints live links nor registers bridges. Existing release directories are not rebuilt in place. Explicit cutover remains separate, and validation failures leave live pointers untouched.

The comparator retains an independently measured deployed-SHA baseline, exact file/full-test-name identities, fail-closed runner/report validation, immutable baseline allowance, and checks for changed deployment identity. Full-suite-v2 caches have no excluded files and do not reuse exclusion-era caches.

## Earlier failures retained

MacBook runs encountered deadline failures during heavy shared-host load. Those results were not marked successful or used to widen baseline allowance. Verification moved to the iMac rather than removing assertions. The first iMac checkout found the OAuth address issue above; its failed output and the focused IPv4 pass were retained before the final full run.

The isolated deployment root's baseline used the independently archived `b151dad9`, not the candidate's own results. It contained 18 failed assertions in that environment; the final candidate contained zero.

## Remaining landing work

No production deployment follows automatically from this report. A later integrated runtime candidate still needs its own acceptance and native dependency build before cutover. Do not copy Intel `node_modules` into an Apple Silicon release. Preserve the previous release and use the supervised restart procedure after an authorized, verified cutover.
