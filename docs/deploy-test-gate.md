# Deploy test gate

`scripts/deploy.mjs` gates candidate tests before release stamp, `current` swap, or bridge registration.
Baseline comparator lands in `956511f5`; remains wired to `scripts/deploy.mjs`.
Baseline-relative comparison permits existing assertion failures; rejects every newly failing identity.
Failure identity = repository-relative file path + Vitest full test name.
Failure counts alone never determine regression status.

## Baseline provenance

Baseline SHA comes from `<prod-root>/current/RELEASE.json#commit`, never candidate ref.
Default `<prod-root>` = `~/.pi-dashboard-prod`.
First capture materialises deployed SHA through `git archive` in separate temporary directory.
Capture runs `npm ci` and root `npm test` inside temporary archive, never serving release.
No-exclusions policy recaptures deployed baseline independently in `<prod-root>/test-baselines/full-suite-v2/<sha>.json`.
Capture stores report, SHA, timestamp, `version: 2`, and `excludedFiles: []`.
Old-policy caches in `<prod-root>/test-baselines/<sha>.json` remain untouched.
Existing same-policy baseline remains immutable; later runs cannot widen failure allowance.
Missing deployed stamp, invalid baseline, or changed `current` SHA aborts gate.
Accepted committed candidate saves next baseline only after comparison passes.
Next deploy selects baseline through then-current release SHA.
Worktree proof runs never save candidate baseline.

## Test coverage

Gate invokes full root `npm test` with existing HOME isolation.
Candidate root `npm test` runs `scripts/deploy-test-gate.test.mjs` and `scripts/deploy-build-only.test.mjs` before Vitest.
Custom Vitest 4 reporter captures assertion results, suite errors, runner errors, and completion reason.
Runner failure, missing/invalid report, interrupted run, unfinished result, suite error, or mismatched exit status aborts gate.
Skipped-file records with executed assertions abort gate.
Shutdown timeout invalidates report.
Empty runs and runs without passing assertions abort gate.
`--allowOnly=false` rejects focused `.only` tests.

Gate excludes no whole test files.
`packages/shared/src/__tests__/platform-git.test.ts` conditionally skips 7 repo-dependent assertions iff root `.git` absent.
Pure recipe and non-repository fallback tests still execute in archives.
Normal checkout runs all 24 tests.
`packages/server/src/__tests__/git-operations.test.ts` remains enabled; tests create temporary Git repositories.
Reports remain in logged `pi-deploy-tests-*` temporary directories.
Comparison logs `KNOWN`, `RESOLVED`, and `NEW FAILURE` with file + full test name.
Any `NEW FAILURE` produces `REFUSED` and nonzero exit.

## Regression contracts

`scripts/deploy-build-only.test.mjs` uses throwaway HOME, repository, and fake npm.
Fixtures assert default `current`/`previous` and bridge-settings preservation.
Serving-ref fixture asserts fresh archive use; serving release remains untouched.
Genuine new assertion failure fixture asserts gate refusal before `RELEASE.json` stamp.
Policy regression asserts legacy excluded baseline never seeds v2 and remains byte-unchanged.
`ChatView.test.tsx` updates 5 tool-rendering tests to click real `Show all activity` control.
Tests assert default hidden precondition, preserve existing assertions, and clean up DOM after each test.
`ChatView.streaming-text-flush.test.tsx` reveals bash/edit activity through same control.
Order assertions locate actual text elements, not ancestors.
Product `ChatView.tsx` remains unchanged by corrections.
`driver-liveness.ts:pidAlive` delegates to shared `isProcessAlive` instead of direct `process.kill`.
Shared helper preserves `EPERM` = alive; `platform-process.test.ts` adds regression assertion.
`no-direct-process-kill.test.ts` remains unchanged.
`no-jj-regression.test.ts` uses `--exclude-dir` to prune `node_modules`, `__tests__`, `specs`, `.jj`, and `jj-plugin` directories before scanning, rather than only filtering results afterward.
Include globs, output filters, zero-reference assertions, and timeout remain unchanged.
`MarkdownContent.test.tsx` highlighting test awaits real lazy imports via `vi.dynamicImportSettled` inside `act`.
Test retains actual highlighted markup assertion and original timeouts; adds no mocks.
`GATE-REPORT.md` records measured acceptance commands, results, failure control, and production-state checks.

## Commands and proof

```bash
node scripts/deploy-test-gate.mjs --baseline-only
node scripts/deploy-test-gate.mjs --candidate .
node scripts/deploy.mjs --ref main
```

Before deploy, commit gate changes and confirm clean worktree.
Inject genuine failing assertion into non-Git suite in worktree only.
Run `--candidate .`; require nonzero exit and `NEW FAILURE` naming injected test.
Remove injected assertion; confirm `git status --short` empty.
Rerun restored candidate; retain both logs and exit statuses.
Deploy without `--skip-tests` only after must-fail proof succeeds.

## Cutover limits

Gate refusal leaves `current` and `previous` unchanged; stop without rollback.
Default deploy archives, installs dependencies, builds, tests, and stamps only.
Default deploy never swaps `current`/`previous` or registers bridge settings.
Existing release directories never rebuild in place; repeated SHA uses fresh `releases/<sha>-<suffix>`.
Only explicit `--restart` swaps `current`, retains outgoing release as `previous`, and registers bridges.
Supervisor restart remains manual after explicit swap.
No live cutover performed for this task.
Verify live `/api/health` SHA, serving state, bridge reconnection count, and observed session creation through real pi `/new`.
Rollback applies only after completed cutover degrades production.
Existing `--rollback --restart` repoints `current`; neither rotates `previous` nor restarts supervisor.
Rollback recovery must retain distinct `current` and `previous` release targets.
