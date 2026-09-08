import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "pi-deploy-contract-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const prodRoot = join(home, ".pi-dashboard-prod");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(bin);
  for (const name of ["deploy.mjs", "deploy-test-gate.mjs"]) {
    copyFileSync(join(scripts, name), join(repo, "scripts", name));
  }
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.env.HOME, 'npm-cwds'), process.cwd() + '\\n');
if (process.argv[2] === 'ci') {
  fs.mkdirSync('packages/client/dist', { recursive: true });
} else if (process.argv[2] === 'test') {
  const broken = fs.existsSync('FAIL_GATE');
  const state = broken ? 'failed' : 'passed';
  const tests = [{ name: 'healthy assertion', state: 'passed' }];
  if (broken) tests.push({ name: 'injected regression', state: 'failed' });
  fs.writeFileSync(process.env.PI_DEPLOY_TEST_REPORT, JSON.stringify({
    version: 1, reason: state, errors: [],
    files: [{ file: 'packages/shared/src/__tests__/fixture.test.ts', state, errors: [], tests }],
  }));
  process.exitCode = broken ? 1 : 0;
} else { process.exitCode = 2; }
`, { mode: 0o755 });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const baseline = commit();
  const serving = join(prodRoot, "releases", baseline);
  mkdirSync(join(serving, "packages", "extension"), { recursive: true });
  writeFileSync(join(serving, "RELEASE.json"), JSON.stringify({ commit: baseline }));
  symlinkSync(serving, join(prodRoot, "current"));
  symlinkSync(serving, join(prodRoot, "previous"));
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const settings = '{"packages":["npm:keep-me"]}\n';
  writeFileSync(settingsPath, settings);
  return {
    repo, home, prodRoot, serving, baseline, commit,
    run: () => spawnSync(process.execPath, [join(repo, "scripts", "deploy.mjs"), "--ref", "HEAD"], {
      cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    }),
    assertUntouched: () => {
      assert.equal(readlinkSync(join(prodRoot, "current")), serving);
      assert.equal(readlinkSync(join(prodRoot, "previous")), serving);
      assert.equal(readFileSync(settingsPath, "utf8"), settings);
      assert.equal(readFileSync(join(serving, "RELEASE.json"), "utf8"), JSON.stringify({ commit: baseline }));
      const installDirs = readFileSync(join(home, "npm-cwds"), "utf8").trim().split("\n");
      assert.ok(!installDirs.includes(realpathSync(serving)));
      assert.ok(!installDirs.includes(serving));
    },
  };
}

test("default deploy gates and stamps a committed candidate without touching live state", (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.repo, "candidate.txt"), "committed candidate\n");
  const candidate = setup.commit();
  const result = setup.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: no new failures/);
  assert.equal(JSON.parse(readFileSync(join(setup.prodRoot, "releases", candidate, "RELEASE.json"))).commit, candidate);
  const baselinePath = join(setup.prodRoot, "test-baselines", "full-suite-v2", `${setup.baseline}.json`);
  const baseline = JSON.parse(readFileSync(baselinePath));
  assert.equal(baseline.version, 2);
  assert.deepEqual(baseline.excludedFiles, []);
  assert.equal(baseline.report.reason, "passed");
  setup.assertUntouched();
});

test("rebuilding the serving ref uses a fresh archive, never its live directory", (context) => {
  const setup = fixture(context);
  const result = setup.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS: no new failures/);
  setup.assertUntouched();
});

test("new assertion failure refuses deploy before stamp or live-state changes", (context) => {
  const setup = fixture(context);
  writeFileSync(join(setup.repo, "FAIL_GATE"), "deliberate regression\n");
  const candidate = setup.commit();
  const result = setup.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEW FAILURE .*injected regression/);
  assert.ok(!existsSync(join(setup.prodRoot, "releases", candidate, "RELEASE.json")));
  setup.assertUntouched();
});

test("full-suite policy remeasures deployed ref instead of reusing an exclusion-era baseline", (context) => {
  const setup = fixture(context);
  const legacyDirectory = join(setup.prodRoot, "test-baselines");
  mkdirSync(legacyDirectory);
  const legacyPath = join(legacyDirectory, `${setup.baseline}.json`);
  const legacy = JSON.stringify({
    version: 1, commit: setup.baseline,
    excludedFiles: ["packages/shared/src/__tests__/platform-git.test.ts"],
    report: { version: 1, reason: "failed", errors: [], files: [{
      file: "packages/shared/src/__tests__/fixture.test.ts", state: "failed", errors: [],
      tests: [{ name: "healthy assertion", state: "passed" }, { name: "injected regression", state: "failed" }],
    }] },
  });
  writeFileSync(legacyPath, legacy);
  writeFileSync(join(setup.repo, "FAIL_GATE"), "not grandfathered by obsolete policy\n");
  setup.commit();
  const result = setup.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEW FAILURE .*injected regression/);
  assert.equal(readFileSync(legacyPath, "utf8"), legacy);
  setup.assertUntouched();
});
