# Deploy test gate

`scripts/deploy.mjs` gates candidate tests before release stamp, `current` swap, or bridge registration.
Baseline-relative comparison permits existing assertion failures; rejects every newly failing identity.
Failure identity = repository-relative file path + Vitest full test name.
Failure counts alone never determine regression status.

## Baseline provenance

Baseline SHA comes from `<prod-root>/current/RELEASE.json#commit`, never candidate ref.
Default `<prod-root>` = `~/.pi-dashboard-prod`.
First capture materialises deployed SHA through `git archive` in separate temporary directory.
Capture runs `npm ci` and root `npm test` inside temporary archive, never serving release.
Capture stores report, SHA, timestamp, and exclusion policy in `<prod-root>/test-baselines/<sha>.json`.
Existing baseline remains immutable; later runs cannot widen failure allowance.
Missing deployed stamp, invalid baseline, or changed `current` SHA aborts gate.
Accepted committed candidate saves next baseline only after comparison passes.
Next deploy selects baseline through then-current release SHA.
Worktree proof runs never save candidate baseline.

## Test coverage

Gate invokes full root `npm test` with existing HOME isolation.
Candidate root test command runs Node gate contract tests before Vitest.
Custom Vitest 4 reporter captures assertion results, suite errors, runner errors, and completion reason.
Runner failure, missing/invalid report, interrupted run, unfinished result, suite error, or mismatched exit status aborts gate.
Skipped-file records with executed assertions abort gate.
Shutdown timeout invalidates report.
Empty runs and runs without passing assertions abort gate.
`--allowOnly=false` rejects focused `.only` tests.

Explicit archive exclusion:

| Suite | Reason |
|---|---|
| `packages/shared/src/__tests__/platform-git.test.ts` | Checkout-dependent integration assertions require `.git`; `git archive` omits `.git`. |

Every test run logs `SKIP` with excluded suite path and reason.
`packages/server/src/__tests__/git-operations.test.ts` remains enabled; tests create temporary Git repositories.
Reports remain in logged `pi-deploy-tests-*` temporary directories.
Comparison logs `KNOWN`, `RESOLVED`, and `NEW FAILURE` with file + full test name.
Any `NEW FAILURE` produces `REFUSED` and nonzero exit.

## Commands and proof

```bash
node scripts/deploy-test-gate.mjs --baseline-only
node scripts/deploy-test-gate.mjs --candidate .
node scripts/deploy.mjs --ref main --restart
```

Before deploy, commit gate changes and confirm clean worktree.
Inject genuine failing assertion into non-Git suite in worktree only.
Run `--candidate .`; require nonzero exit and `NEW FAILURE` naming injected test.
Remove injected assertion; confirm `git status --short` empty.
Rerun restored candidate; retain both logs and exit statuses.
Deploy without `--skip-tests` only after must-fail proof succeeds.

## Cutover limits

Gate refusal leaves `current` and `previous` unchanged; stop without rollback.
Successful deploy swaps `current` and retains outgoing release as `previous`.
`--restart` only prints manual instructions; explicit supervised restart still required after swap.
Verify live `/api/health` SHA, serving state, bridge reconnection count, and observed session creation through real pi `/new`.
Rollback applies only after completed cutover degrades production.
Existing `--rollback --restart` repoints `current`; neither rotates `previous` nor restarts supervisor.
Rollback recovery must retain distinct `current` and `previous` release targets.
