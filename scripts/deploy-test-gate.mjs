#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SCRIPT), "..");
const BASELINE_DIRECTORY = "full-suite-v2";
const log = (message) => console.log(`[deploy:test-gate] ${message}`);
const key = ({ file, test }) => JSON.stringify([file, test]);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const errorText = (error) => error?.message ?? String(error);

// Vitest's stock JSON reporter omits unhandled errors. Capture them and suite
// hook/collection errors explicitly, using the Vitest 4 reporter API.
export default class DeployTestReporter {
  onTestRunEnd(modules, errors, reason) {
    this.report = {
      version: 1,
      reason,
      errors: errors.map(errorText),
      files: modules.map((module) => ({
        file: relative(process.env.PI_DEPLOY_TEST_ROOT, module.moduleId).split("\\").join("/"),
        state: module.state(),
        errors: [module, ...module.children.allSuites()].flatMap((suite) => suite.errors().map(errorText)),
        tests: [...module.children.allTests()].map((test) => ({ name: test.fullName, state: test.result().state })),
      })),
    };
    this.save();
  }
  onProcessTimeout() {
    if (this.report) {
      this.report.errors.push("Vitest process timed out during shutdown");
      this.save();
    }
  }
  save() {
    writeFileSync(process.env.PI_DEPLOY_TEST_REPORT, JSON.stringify(this.report, null, 2) + "\n");
  }
}

export function validateReport(report, exitCode) {
  check(report?.version === 1 && ["passed", "failed"].includes(report.reason), "missing, invalid, or interrupted test report");
  check(Array.isArray(report.errors) && report.errors.length === 0, `test runner errors: ${JSON.stringify(report.errors)}`);
  check(Array.isArray(report.files) && report.files.length > 0, "test report contains no files");
  const failures = [];
  const totals = { files: report.files.length, tests: 0, passed: 0, failed: 0, skipped: 0 };
  const files = new Set();
  for (const file of report.files) {
    check(typeof file.file === "string" && file.file.length > 0 && !isAbsolute(file.file)
      && !file.file.includes("\\") && !file.file.includes(":")
      && file.file.split("/").every((part) => part && part !== "." && part !== ".."), "invalid repository-relative test path");
    check(!files.has(file.file), `duplicate test file: ${file.file}`);
    files.add(file.file);
    check(["passed", "failed", "skipped"].includes(file.state), `unfinished or invalid test file: ${file.file}`);
    check(Array.isArray(file.errors) && file.errors.length === 0, `suite errors in ${file.file}: ${JSON.stringify(file.errors)}`);
    check(Array.isArray(file.tests), `missing assertions in ${file.file}`);
    let failed = 0;
    for (const test of file.tests) {
      check(typeof test.name === "string" && test.name.trim().length > 0, `missing test name in ${file.file}`);
      check(["passed", "failed", "skipped"].includes(test.state), `unfinished or invalid test: ${file.file} > ${test.name}`);
      totals.tests++;
      totals[test.state]++;
      if (test.state === "failed") {
        failed++;
        failures.push({ file: file.file, test: test.name });
      }
    }
    check((file.state === "failed") === (failed > 0), `suite failure does not match assertions in ${file.file}`);
    check(file.state !== "skipped" || file.tests.every((test) => test.state === "skipped"), `skipped file contains executed assertions: ${file.file}`);
  }
  check(totals.passed > 0, "test run has no passing assertions; refusing an empty or wholly skipped gate");
  const expectedExit = totals.failed > 0 ? 1 : 0;
  check(exitCode === expectedExit, `test runner exit ${exitCode} does not match assertion results (expected ${expectedExit})`);
  check(report.reason === (expectedExit ? "failed" : "passed"), "test run outcome does not match assertions");
  failures.sort((a, b) => key(a).localeCompare(key(b)));
  return { failures, totals };
}

export function compareReports(baseline, candidate) {
  const before = validateReport(baseline, baseline?.reason === "failed" ? 1 : 0).failures;
  const after = validateReport(candidate, candidate?.reason === "failed" ? 1 : 0).failures;
  const baselineKeys = new Set(before.map(key));
  const candidateKeys = new Set(after.map(key));
  return {
    newFailures: after.filter((failure) => !baselineKeys.has(key(failure))),
    resolvedFailures: before.filter((failure) => !candidateKeys.has(key(failure))),
    knownFailures: after.filter((failure) => baselineKeys.has(key(failure))),
  };
}

function runTests(cwd) {
  const root = realpathSync(cwd);
  const evidence = mkdtempSync(join(tmpdir(), "pi-deploy-tests-"));
  const reportPath = join(evidence, "results.json");
  const args = ["test", "--", "--reporter=default", `--reporter=${SCRIPT}`, "--allowOnly=false"];
  log("full suite; environment-dependent skips belong to individual tests, never file exclusions");
  log(`HOME-jailed npm test in ${root}; report: ${reportPath}`);
  const result = spawnSync("npm", args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PI_DEPLOY_TEST_ROOT: root, PI_DEPLOY_TEST_REPORT: reportPath },
  });
  check(!result.error && !result.signal, `test runner failed: ${result.error?.message ?? result.signal}`);
  check(existsSync(reportPath), `test runner produced no report (exit ${result.status}); ${reportPath}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const { totals } = validateReport(report, result.status);
  log(`${totals.files} files; ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped assertions`);
  return report;
}

function deployedCommit(prodRoot) {
  const stamp = JSON.parse(readFileSync(join(prodRoot, "current", "RELEASE.json"), "utf8"));
  check(/^[0-9a-f]{40}$/.test(stamp.commit), "current release has no valid committed SHA for baseline");
  return stamp.commit;
}

function readBaseline(path, commit) {
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  check(baseline.version === 2 && baseline.commit === commit, `baseline provenance mismatch: ${path}`);
  check(JSON.stringify(baseline.excludedFiles) === "[]", `baseline archive policy mismatch: ${path}`);
  validateReport(baseline.report, baseline.report?.reason === "failed" ? 1 : 0);
  return baseline;
}

function saveBaseline(prodRoot, commit, report) {
  const directory = join(prodRoot, "test-baselines", BASELINE_DIRECTORY);
  const path = join(directory, `${commit}.json`);
  mkdirSync(directory, { recursive: true });
  if (existsSync(path)) return readBaseline(path, commit); // Never widen an existing baseline.
  const baseline = { version: 2, commit, capturedAt: new Date().toISOString(), excludedFiles: [], report };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", { flag: "wx" });
  log(`recorded baseline ${commit}: ${path}`);
  return baseline;
}

export function ensureBaseline({ repo = REPO, prodRoot }) {
  const commit = deployedCommit(prodRoot);
  const path = join(prodRoot, "test-baselines", BASELINE_DIRECTORY, `${commit}.json`);
  if (existsSync(path)) {
    log(`baseline = deployed ref ${commit}: ${path}`);
    return readBaseline(path, commit);
  }
  // Measure the DEPLOYED commit in an independent archive. Never install deps or
  // run tests inside the serving release, and never seed from the candidate.
  const stage = mkdtempSync(join(tmpdir(), "pi-deploy-baseline-"));
  const archive = join(stage, "source.tar");
  const root = join(stage, "release");
  mkdirSync(root);
  try {
    log(`measuring deployed baseline ${commit} in isolated archive ${root}`);
    execFileSync("git", ["archive", "--format=tar", "-o", archive, commit], { cwd: repo, stdio: "inherit" });
    execFileSync("tar", ["-xf", archive, "-C", root], { stdio: "inherit" });
    execFileSync("npm", ["ci"], { cwd: root, stdio: "inherit" });
    const report = runTests(root);
    check(deployedCommit(prodRoot) === commit, "current release changed while measuring baseline; refusing cutover");
    return saveBaseline(prodRoot, commit, report);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function runDeployTestGate({ repo = REPO, prodRoot, candidateDir, commit }) {
  const baseline = ensureBaseline({ repo, prodRoot });
  const report = runTests(candidateDir);
  const comparison = compareReports(baseline.report, report);
  for (const failure of comparison.knownFailures) log(`KNOWN ${failure.file} > ${failure.test}`);
  for (const failure of comparison.resolvedFailures) log(`RESOLVED ${failure.file} > ${failure.test}`);
  for (const failure of comparison.newFailures) console.error(`[deploy:test-gate] NEW FAILURE ${failure.file} > ${failure.test}`);
  check(comparison.newFailures.length === 0, `REFUSED: ${comparison.newFailures.length} new failing test(s); current/previous unchanged`);
  check(deployedCommit(prodRoot) === baseline.commit, "current release changed during test gate; refusing cutover");
  // Only successful committed candidates become the NEXT release's baseline.
  // Worktree proof runs omit commit, so they cannot modify any baseline.
  if (commit) saveBaseline(prodRoot, commit, report);
  log(`PASS: no new failures relative to ${baseline.commit}; ${comparison.knownFailures.length} known, ${comparison.resolvedFailures.length} resolved`);
  return { baselineCommit: baseline.commit, ...comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    const { values } = parseArgs({ options: {
      "prod-root": { type: "string", default: join(homedir(), ".pi-dashboard-prod") },
      candidate: { type: "string", default: REPO },
      "baseline-only": { type: "boolean", default: false },
    } });
    const options = { prodRoot: resolve(values["prod-root"]), candidateDir: resolve(values.candidate) };
    if (values["baseline-only"]) ensureBaseline(options);
    else runDeployTestGate(options);
  } catch (error) {
    console.error(`[deploy:test-gate] FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
