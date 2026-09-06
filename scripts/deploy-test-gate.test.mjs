import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import DeployTestReporter, { ARCHIVE_SKIPS, compareReports, validateReport } from "./deploy-test-gate.mjs";

const ordinary = "packages/shared/src/__tests__/gate-fixture.test.ts";
const other = "packages/server/src/__tests__/gate-fixture.test.ts";
const archiveOnly = "packages/shared/src/__tests__/platform-git.test.ts";
const healthy = { name: "suite > stays healthy", state: "passed" };
const broken = { name: "suite > existing failure", state: "failed" };

function file(path = ordinary, tests = [{ ...healthy }]) {
  return {
    file: path,
    state: tests.some((entry) => entry.state === "failed") ? "failed" : "passed",
    errors: [],
    tests,
  };
}

function report(files = [file()]) {
  return {
    version: 1,
    reason: files.some((entry) => entry.state === "failed") ? "failed" : "passed",
    errors: [],
    files,
  };
}

function failing() {
  return report([file(ordinary, [{ ...healthy }, { ...broken }])]);
}

test("archive exclusion names only checkout-dependent platform-git, with a reason", () => {
  assert.deepEqual(ARCHIVE_SKIPS.map((entry) => entry.file), [archiveOnly]);
  assert.ok(ARCHIVE_SKIPS.every((entry) => typeof entry.reason === "string" && entry.reason.trim()));
});

test("validates passing assertions and records meaningful totals", () => {
  assert.deepEqual(validateReport(report(), 0), {
    failures: [],
    totals: { files: 1, tests: 1, passed: 1, failed: 0, skipped: 0 },
  });
});

test("records failures by exact file and full test name, counting skips separately", () => {
  const input = failing();
  input.files[0].tests.push({ name: "suite > intentionally skipped", state: "skipped" });
  assert.deepEqual(validateReport(input, 1), {
    failures: [{ file: ordinary, test: broken.name }],
    totals: { files: 1, tests: 3, passed: 1, failed: 1, skipped: 1 },
  });
});

test("git-operations remains runnable because its git repositories are temporary fixtures", () => {
  const input = report([file("packages/server/src/__tests__/git-operations.test.ts")]);
  assert.equal(validateReport(input, 0).totals.passed, 1);
});

test("explicitly skipped archive-only suite may appear, but must never execute", () => {
  const skipped = file(archiveOnly, [{ name: "requires checkout", state: "skipped" }]);
  skipped.state = "skipped";
  assert.equal(validateReport(report([file(), skipped]), 0).totals.skipped, 1);
  assert.throws(() => validateReport(report([file(), file(archiveOnly)]), 0));
  assert.throws(() => validateReport(report([file(), file(archiveOnly, [{ ...broken }])]), 1));
});

test("identical baseline failures are known, not regressions", () => {
  assert.deepEqual(compareReports(failing(), failing()), {
    newFailures: [],
    resolvedFailures: [],
    knownFailures: [{ file: ordinary, test: broken.name }],
  });
});

test("passing baseline and candidate introduce no failures", () => {
  assert.deepEqual(compareReports(report(), report()), {
    newFailures: [], resolvedFailures: [], knownFailures: [],
  });
});

test("fixed baseline failures pass and are reported as resolved", () => {
  assert.deepEqual(compareReports(failing(), report()), {
    newFailures: [],
    resolvedFailures: [{ file: ordinary, test: broken.name }],
    knownFailures: [],
  });
});

test("newly failing assertion in an already-failing file is a regression", () => {
  const candidate = failing();
  candidate.files[0].tests.push({ name: "suite > genuine regression", state: "failed" });
  assert.deepEqual(compareReports(failing(), candidate), {
    newFailures: [{ file: ordinary, test: "suite > genuine regression" }],
    resolvedFailures: [],
    knownFailures: [{ file: ordinary, test: broken.name }],
  });
});

test("same failed test name in another file cannot inherit baseline allowance", () => {
  const candidate = report([file(), file(other, [{ ...broken }])]);
  assert.deepEqual(compareReports(failing(), candidate), {
    newFailures: [{ file: other, test: broken.name }],
    resolvedFailures: [{ file: ordinary, test: broken.name }],
    knownFailures: [],
  });
});

test("replacing an existing failure with a different one is not a net-zero pass", () => {
  const candidate = report([file(ordinary, [{ ...healthy }, { name: "suite > different failure", state: "failed" }])]);
  assert.deepEqual(compareReports(failing(), candidate), {
    newFailures: [{ file: ordinary, test: "suite > different failure" }],
    resolvedFailures: [{ file: ordinary, test: broken.name }],
    knownFailures: [],
  });
});

test("missing, empty, or malformed reports fail closed", () => {
  const mutations = [
    () => undefined,
    () => null,
    () => ({}),
    () => [],
    (input) => ({ ...input, version: 2 }),
    (input) => ({ ...input, reason: "unknown" }),
    (input) => ({ ...input, errors: undefined }),
    (input) => ({ ...input, files: [] }),
    (input) => ({ ...input, files: {} }),
    (input) => { input.files[0].tests = []; return input; },
    (input) => { input.files[0].tests = {}; return input; },
    (input) => { input.files[0].errors = undefined; return input; },
    (input) => { input.files[0].state = "unknown"; return input; },
    (input) => { input.files[0].tests[0].state = "unknown"; return input; },
    (input) => { input.files[0].tests[0].name = ""; return input; },
    (input) => { input.files[0].tests[0].name = 123; return input; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    assert.throws(() => validateReport(mutate(report()), 0), `malformed case ${index}`);
  }
});

test("failure identities require normalized repository-relative file paths", () => {
  for (const path of ["", "/tmp/test.ts", "../test.ts", "packages/../test.ts", "./test.ts", "C:\\tmp\\test.ts", null]) {
    assert.throws(() => validateReport(report([file(path)]), 0), `path ${path}`);
  }
});

test("duplicate file records are invalid instead of silently deduplicated", () => {
  assert.throws(() => validateReport(report([file(), file()]), 0));
});

test("zero passing tests cannot certify a candidate", () => {
  assert.throws(() => validateReport(report([file(ordinary, [{ ...broken }])]), 1));
  const skipped = file(ordinary, [{ name: "suite > skipped", state: "skipped" }]);
  skipped.state = "skipped";
  assert.throws(() => validateReport(report([skipped]), 0));
});

test("runner exit code must agree with assertion results and be zero or one", () => {
  for (const exitCode of [2, -1, null, undefined, "0", "SIGTERM"]) {
    assert.throws(() => validateReport(report(), exitCode), `exit ${exitCode}`);
  }
  assert.throws(() => validateReport(failing(), 0));
  assert.throws(() => validateReport(report(), 1));
});

test("report reason must agree with assertion results", () => {
  assert.throws(() => validateReport({ ...failing(), reason: "passed" }, 1));
  assert.throws(() => validateReport({ ...report(), reason: "failed" }, 0));
});

test("interrupted or pending runs fail closed", () => {
  assert.throws(() => validateReport({ ...report(), reason: "interrupted" }, 0));
  const input = report();
  input.files[0].tests.push({ name: "suite > never completed", state: "pending" });
  assert.throws(() => validateReport(input, 0));
});

test("runner and suite errors cannot be grandfathered by a matching baseline", () => {
  for (const mutate of [
    (input) => { input.errors.push({ message: "worker crashed" }); },
    (input) => { input.files[0].errors.push({ message: "beforeAll crashed" }); },
  ]) {
    const input = failing();
    mutate(input);
    assert.throws(() => validateReport(input, 1));
    assert.throws(() => compareReports(input, input));
    assert.throws(() => compareReports(failing(), input));
    assert.throws(() => compareReports(input, failing()));
  }
});

test("failed suite without failed assertion is a gate error", () => {
  const input = report();
  input.reason = "failed";
  input.files[0].state = "failed";
  assert.throws(() => validateReport(input, 1));
  assert.throws(() => compareReports(input, input));
});

test("skipped file cannot contain passing assertions that certify the gate", () => {
  const input = report();
  input.files[0].state = "skipped";
  assert.throws(() => validateReport(input, 0));
});

function reporterFixture(t, { moduleErrors = [], suiteErrors = [], runnerErrors = [], state = "passed" } = {}) {
  const originalRoot = process.env.PI_DEPLOY_TEST_ROOT;
  process.env.PI_DEPLOY_TEST_ROOT = process.cwd();
  t.after(() => {
    if (originalRoot === undefined) delete process.env.PI_DEPLOY_TEST_ROOT;
    else process.env.PI_DEPLOY_TEST_ROOT = originalRoot;
  });
  class MemoryReporter extends DeployTestReporter {
    save() { this.saved = structuredClone(this.report); }
  }
  const reporter = new MemoryReporter();
  const module = {
    moduleId: join(process.cwd(), ordinary),
    state: () => state,
    errors: () => moduleErrors,
    children: {
      allSuites: () => [{ errors: () => suiteErrors }],
      allTests: () => [{ fullName: healthy.name, result: () => ({ state: healthy.state }) }],
    },
  };
  reporter.onTestRunEnd([module], runnerErrors, state);
  return reporter;
}

test("reporter preserves repository-relative file and full assertion name", (t) => {
  const reporter = reporterFixture(t);
  assert.deepEqual(reporter.saved, report());
  assert.equal(validateReport(reporter.saved, 0).totals.passed, 1);
});

test("reporter captures module, nested suite, and unhandled runner errors", (t) => {
  const reporter = reporterFixture(t, {
    moduleErrors: [new Error("collection failed")],
    suiteErrors: [new Error("nested afterAll failed")],
    runnerErrors: [new Error("unhandled worker rejection")],
    state: "failed",
  });
  assert.deepEqual(reporter.saved.errors, ["unhandled worker rejection"]);
  assert.deepEqual(reporter.saved.files[0].errors, ["collection failed", "nested afterAll failed"]);
  assert.throws(() => validateReport(reporter.saved, 1));
  assert.throws(() => compareReports(reporter.saved, reporter.saved));
});

test("shutdown timeout invalidates even an already-saved passing report", (t) => {
  const reporter = reporterFixture(t);
  assert.equal(validateReport(reporter.saved, 0).totals.passed, 1);
  reporter.onProcessTimeout();
  assert.ok(reporter.saved.errors.some((error) => /timed out/i.test(error)));
  assert.throws(() => validateReport(reporter.saved, 0));
});
