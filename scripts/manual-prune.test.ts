import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, renameSync, rmSync, existsSync, chmodSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { acquireFence, identity, snapshotFile, snapshotLink, snapshotPreserved, sha256File, LOCK_NAME, readJson } from "./deployment-fence.ts";
import { captureRuntimeInputs, captureProcess, verifySafety, RUNTIME_FILES, TOOLING_HELPERS } from "./prune-safety.ts";
import { stagePrune, openPrune } from "./manual-prune.ts";
import { runDeploy } from "./deploy.mjs";

const DEPLOY = resolve("scripts/deploy.mjs");
const fixtureParents: string[] = [];

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "bounded-prune-test-")));
  fixtureParents.push(home);
  const root = join(home, ".pi-dashboard-prod");
  const releases = join(root, "releases");
  const names = ["a".repeat(40), "b".repeat(40), "current-kept", "previous-kept", "live-kept", "pinned-kept", "unique-kept"];
  const roots = names.map(name => join(releases, name));
  for (const p of roots) {
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "sentinel"), p);
  }
  const [oldA, oldB, current, previous, live, pinned, unique] = roots;
  for (const relative of RUNTIME_FILES) {
    const p = join(current, relative);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, "// private kept runtime input\n");
  }
  mkdirSync(join(current, "packages", "extension"), { recursive: true });
  writeFileSync(join(current, "packages", "extension", "package.json"), "{}");
  const plugin = join(current, "packages", "test-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ "pi-dashboard-plugin": { id: "fixture", bridge: "./bridge.ts" } }));
  writeFileSync(join(plugin, "bridge.ts"), "export default {};\n");
  symlinkSync(current, join(root, "current"));
  symlinkSync(previous, join(root, "previous"));
  const settings = join(home, ".pi", "agent", "settings.json");
  mkdirSync(resolve(settings, ".."), { recursive: true });
  writeFileSync(settings, JSON.stringify({ packages: [join(current, "packages", "extension"), pinned], dashboardPluginBridges: { "dashboard-fixture": join(plugin, "bridge.ts") } }));
  const scope = { sha256: "private-fixture-scope", prodRoot: root, entrypoint: DEPLOY, candidates: [identity(oldA), identity(oldB)] };
  const preservation = scope.candidates.map((candidate, i) => {
    const receipt = join(home, `preservation-${i}.json`);
    writeFileSync(receipt, JSON.stringify({ root: candidate, noUnpreservedState: true, nonDependencyDisposition: "no-unique-data", preserved: [] }));
    return { root: candidate.path, receipt: snapshotFile(receipt) };
  });
  const census = join(home, "reference-census.json");
  writeFileSync(census, JSON.stringify({ complete: true, roots: [current, previous, live, pinned, unique] }));
  const processFact = { pid: 12345, started: "private-start", commandSha256: "private-command", cwd: current };
  const processProbe = () => ({ ...processFact });
  const entrypoint = snapshotFile(DEPLOY);
  const helpers = TOOLING_HELPERS.map(name => snapshotFile(resolve("scripts", name)));
  const activationPath = join(home, "activation-receipt.json");
  const now = new Date().toISOString();
  writeFileSync(activationPath, JSON.stringify({ version: 1, scopeSha256: scope.sha256, publishedAt: now, verifiedAt: now, legacyWritersDrained: true, nativeExit: 0, legacyWriterPids: [], files: [entrypoint, ...helpers].map(({ path, sha256 }) => ({ path, sha256 })) }));
  const manifest = {
    version: 1, scopeSha256: scope.sha256, validUntil: new Date(Date.now() + 120_000).toISOString(),
    prodRoot: identity(root), releases: identity(releases), selected: scope.candidates,
    kept: [current, previous, live, pinned, unique].map(identity),
    current: snapshotLink(join(root, "current")), previous: snapshotLink(join(root, "previous")),
    settings: snapshotFile(settings), references: [live, pinned, unique].map(identity),
    factFiles: [snapshotFile(census)], preservation,
    activation: { entrypoint, helpers, receipt: snapshotFile(activationPath) },
    runtimes: [{ process: processFact, sourceRoot: current, inputs: captureRuntimeInputs(current, current) }],
    assertions: { referenceCensusComplete: true, noCandidateReaders: true, noCandidatePins: true, preservationComplete: true, supportedWritersActivated: true, runtimeInputsPinned: true },
  };
  const manifestPath = join(home, "exact-manifest.json");
  function seal() { writeFileSync(manifestPath, JSON.stringify(manifest)); return sha256File(manifestPath); }
  const digest = seal();
  const options = { processProbe };
  const protectedBefore = [current, previous, live, pinned, unique].map(p => readFileSync(join(p, "sentinel"), "utf8"));
  function checkProtected() {
    assert.deepEqual([current, previous, live, pinned, unique].map(p => readFileSync(join(p, "sentinel"), "utf8")), protectedBefore);
    assert.deepEqual(snapshotLink(join(root, "current")), manifest.current);
    assert.deepEqual(snapshotLink(join(root, "previous")), manifest.previous);
    assert.deepEqual(snapshotFile(settings), manifest.settings);
  }
  return { home, root, releases, oldA, oldB, current, previous, live, pinned, unique, plugin, settings, scope, manifest, manifestPath, digest, seal, options, checkProtected };
}

test("canonical fence contends across aliases; stale and replaced ownership never stolen", () => {
  const f = fixture();
  const alias = join(f.home, "alias");
  symlinkSync(f.root, alias);
  const held = acquireFence(f.root, "writer");
  assert.throws(() => acquireFence(alias, "prune"), /FENCE_BUSY/);
  const ownerPath = join(f.root, LOCK_NAME, "owner.json");
  const owner = readFileSync(ownerPath, "utf8");
  writeFileSync(ownerPath, owner.replace(held.token, "unknown-owner"));
  assert.throws(() => held.release(), /FENCE_OWNER_CHANGED/);
  assert.throws(() => acquireFence(f.root, "writer"), /FENCE_BUSY/);
  writeFileSync(ownerPath, owner);
  held.release();
  mkdirSync(join(f.root, LOCK_NAME));
  assert.throws(() => acquireFence(f.root, "writer"), /FENCE_BUSY/);
  assert.deepEqual(readdirSync(join(f.root, LOCK_NAME)), []);
});

test("eligible exact fixture stages and supervisor-style purge leaves every keep unchanged", () => {
  const f = fixture();
  const tx = stagePrune(f.manifestPath, f.digest, f.scope, f.options);
  assert.equal(existsSync(f.oldA), false);
  assert.equal(existsSync(f.oldB), false);
  f.checkProtected();
  assert.throws(() => acquireFence(f.root, "writer"), /FENCE_BUSY/);
  assert.equal(tx.commands(DEPLOY).length, 2);
  for (let i = 0; i < tx.state.entries.length; i++) {
    const reopened = openPrune(f.root, tx.token, f.scope, f.options);
    reopened.arm(i);
    // Only freshly owned tiny fixture roots; production tool never performs purge.
    rmSync(reopened.state.entries[i].stagedPath, { recursive: true });
    reopened.record(i, 0);
  }
  const result = openPrune(f.root, tx.token, f.scope, f.options).finish();
  assert.equal(result.phase, "complete");
  assert.equal(result.protectedChecks, "passed");
  assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  assert.equal(existsSync(tx.state.staging.path), false);
  f.checkProtected();
});

test("all actual deployment branches are blocked before private effects while prune owns fence", () => {
  const f = fixture();
  const tx = stagePrune(f.manifestPath, f.digest, f.scope, f.options);
  const branches = [["--ref", "HEAD"], ["--ref", "HEAD", "--restart"], ["--rollback"], ["--rollback", "--restart"], ["--register-bridge-only"]];
  for (const flags of branches) {
    const result = spawnSync(process.execPath, [DEPLOY, ...flags, "--prod-root", f.root], {
      env: { HOME: f.home, PATH: resolve(process.execPath, "..") }, encoding: "utf8",
    });
    assert.equal(result.status, 73, JSON.stringify(result));
    assert.match(result.stderr, /FENCE_BUSY/);
    f.checkProtected();
  }
  tx.cancel();
  assert.equal(existsSync(f.oldA), true);
});

test("pruning blocked inside actual writer entrypoint; existing SHA rebuild stays under fence", () => {
  const f = fixture();
  const oldHome = process.env.HOME;
  process.env.HOME = f.home;
  let npmCalls = 0;
  try {
    runDeploy(["--ref", "fixture", "--prod-root", f.root, "--skip-tests", "--skip-client-build", "--no-bridge-register"], (command: string, args: string[], options: { cwd: string }) => {
      assert.throws(() => stagePrune(f.manifestPath, f.digest, f.scope, f.options), /FENCE_BUSY/);
      if (command === "git" && args[0] === "rev-parse") return "a".repeat(40) + "\n";
      assert.equal(command, "npm");
      assert.deepEqual(args, ["ci"]);
      assert.equal(options.cwd, f.oldA);
      npmCalls++;
      writeFileSync(join(f.oldA, "private-npm-effect"), "fixture only");
      return "";
    });
    assert.equal(npmCalls, 1);
    assert.equal(realpathSync(join(f.root, "current")), f.oldA);
    assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test("fresh release materialization also holds the same fence through archive, npm and promotion", () => {
  for (const restart of [false, true]) {
    const f = fixture();
    const sha = "c".repeat(40);
    const release = join(f.releases, sha);
    const calls: string[] = [];
    runDeploy(["--ref", "fixture", "--prod-root", f.root, "--skip-tests", "--skip-client-build", "--no-bridge-register", ...(restart ? ["--restart"] : [])], (command: string, args: string[], options: { cwd: string }) => {
      assert.throws(() => stagePrune(f.manifestPath, f.digest, f.scope, f.options), /FENCE_BUSY/);
      calls.push(command + " " + args[0]);
      if (command === "git" && args[0] === "rev-parse") { assert.equal(existsSync(release), false); return sha + "\n"; }
      if (command === "git" && args[0] === "archive") { writeFileSync(args[3], "tiny fake archive"); return ""; }
      if (command === "tar") { writeFileSync(join(release, "source"), "fixture only"); return ""; }
      assert.equal(command, "npm"); assert.equal(options.cwd, release); return "";
    });
    assert.deepEqual(calls, ["git rev-parse", "git archive", "tar -xf", "npm ci"]);
    assert.equal(realpathSync(join(f.root, "current")), release);
    assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  }
});

test("lost writer fence after private npm must prevent stamp and promotion", () => {
  const f = fixture();
  assert.throws(() => runDeploy(["--ref", "fixture", "--prod-root", f.root, "--skip-tests", "--skip-client-build", "--no-bridge-register"], (command: string) => {
    if (command === "git") return "a".repeat(40) + "\n";
    const ownerPath = join(f.root, LOCK_NAME, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")); owner.token = "replaced-owner";
    writeFileSync(ownerPath, JSON.stringify(owner));
    return "";
  }), /FENCE_OWNER_CHANGED/);
  assert.deepEqual(snapshotLink(join(f.root, "current")), f.manifest.current);
  assert.equal(existsSync(join(f.oldA, "RELEASE.json")), false);
});

test("failed private native build propagates its exit and releases only owned fence", () => {
  const f = fixture();
  assert.throws(() => runDeploy(["--ref", "fixture", "--prod-root", f.root, "--skip-tests", "--skip-client-build"], (command: string) => {
    if (command === "git") return "a".repeat(40) + "\n";
    throw Object.assign(new Error("private npm failure"), { status: 37 });
  }), err => (err as { status: number }).status === 37);
  assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  assert.deepEqual(snapshotLink(join(f.root, "current")), f.manifest.current);
});

test("native runtime identity probe observes a private kept-root child without reading environment", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: f.current, env: { HOME: f.home, PATH: resolve(process.execPath, "..") }, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const fact = captureProcess(child.pid!);
    assert.equal(fact.cwd, f.current);
    assert.match(fact.commandSha256, /^[0-9a-f]{64}$/);
    assert.ok(fact.started.length > 10);
  } finally { child.kill("SIGTERM"); await exited; }
});

test("production manual-prune CLI rejects a substitute scope before any fixture staging", () => {
  const f = fixture();
  const path = join(f.home, "unapproved-scope.json");
  writeFileSync(path, JSON.stringify(f.scope));
  const result = spawnSync(process.execPath, [DEPLOY, "--manual-prune", "stage", path, f.manifestPath, f.digest], { env: { HOME: f.home, PATH: resolve(process.execPath, "..") }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SCOPE_NOT_APPROVED/);
  assert.equal(existsSync(f.oldA), true);
  assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
});

test("activation assertion alone cannot bless an actually unfenced supported entrypoint", () => {
  const f = fixture();
  const unguarded = join(f.home, "unfenced-deploy.mjs");
  writeFileSync(unguarded, "// fixture old writer: no shared fence\n");
  const scope = { ...f.scope, entrypoint: unguarded };
  const manifest = f.manifest as typeof f.manifest & { activation: unknown };
  manifest.activation = { entrypoint: snapshotFile(unguarded), helpers: [], receipt: f.manifest.factFiles[0] };
  assert.throws(() => stagePrune(f.manifestPath, f.seal(), scope, f.options), /ACTIVATION/);
  assert.equal(existsSync(f.oldA), true);
});

test("changed inode, symlink candidate, missing facts and unknown safety assertions fail closed", () => {
  for (const change of ["inode", "symlink", "missing-fact", "unknown"]) {
    const f = fixture();
    if (change === "inode" || change === "symlink") {
      renameSync(f.oldA, f.oldA + "-original");
      if (change === "inode") mkdirSync(f.oldA); else symlinkSync(f.oldA + "-original", f.oldA);
    }
    if (change === "missing-fact") rmSync(f.manifest.factFiles[0].path);
    if (change === "unknown") { f.manifest.assertions.referenceCensusComplete = false; f.seal(); }
    assert.throws(() => stagePrune(f.manifestPath, sha256File(f.manifestPath), f.scope, f.options));
    assert.equal(existsSync(f.oldB), true);
    assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  }
});

test("kept, pinned, live, unique and unpreserved selections are rejected", () => {
  for (const change of ["kept", "pin", "live", "unpreserved", "substitution", "expiry"]) {
    const f = fixture();
    if (change === "kept") f.manifest.kept.push(identity(f.oldA));
    if (change === "live") f.manifest.references.push(identity(f.oldA));
    if (change === "pin") { writeFileSync(f.settings, JSON.stringify({ packages: [f.oldA] })); f.manifest.settings = snapshotFile(f.settings); }
    if (change === "unpreserved") {
      const p = f.manifest.preservation[0].receipt.path;
      const data = JSON.parse(readFileSync(p, "utf8")); data.noUnpreservedState = false;
      writeFileSync(p, JSON.stringify(data)); f.manifest.preservation[0].receipt = snapshotFile(p);
    }
    if (change === "substitution") f.manifest.selected[0] = identity(f.unique);
    if (change === "expiry") f.manifest.validUntil = "2000-01-01T00:00:00Z";
    assert.throws(() => stagePrune(f.manifestPath, f.seal(), f.scope, f.options));
    assert.equal(existsSync(f.oldA), true);
    assert.equal(existsSync(f.oldB), true);
  }
});

test("runtime non-interference rejects candidate, escape and symlink bridge inputs", () => {
  for (const bridge of ["candidate", "escape", "symlink"]) {
    const f = fixture();
    const manifest = join(f.plugin, "package.json");
    const target = bridge === "candidate" ? join(f.oldA, "sentinel") : bridge === "escape" ? "../../../../outside.ts" : "./redirect.ts";
    if (bridge === "symlink") symlinkSync(join(f.oldA, "sentinel"), join(f.plugin, "redirect.ts"));
    writeFileSync(manifest, JSON.stringify({ "pi-dashboard-plugin": { id: "fixture", bridge: target } }));
    assert.throws(() => captureRuntimeInputs(f.current, f.current), /RUNTIME_/);
    assert.equal(existsSync(f.oldA), true);
  }
});

test("incomplete preservation identities and unresolved nested package pins cannot authorize a root", () => {
  for (const change of ["identity", "nested-pin"]) {
    const f = fixture();
    if (change === "identity") {
      const path = f.manifest.preservation[0].receipt.path;
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      delete receipt.root.ino;
      writeFileSync(path, JSON.stringify(receipt));
      f.manifest.preservation[0].receipt = snapshotFile(path);
    } else {
      writeFileSync(f.settings, JSON.stringify({ packages: [{ source: "npm:fixture", extensions: [f.oldA] }] }));
      f.manifest.settings = snapshotFile(f.settings);
    }
    assert.throws(() => stagePrune(f.manifestPath, f.seal(), f.scope, f.options));
    assert.equal(existsSync(f.oldA), true);
  }
});

test("stale same-token command cannot overwrite an already armed transaction", () => {
  const f = fixture();
  const first = stagePrune(f.manifestPath, f.digest, f.scope, f.options);
  const stale = openPrune(f.root, first.token, f.scope, f.options);
  first.arm(0);
  assert.throws(() => stale.arm(1), /TRANSACTION_CHANGED/);
  const observed = openPrune(f.root, first.token, f.scope, f.options);
  assert.equal(observed.state.entries[0].status, "armed");
  assert.equal(observed.state.entries[1].status, "staged");
});

test("exact preservation copy survives retirement without any dependency-backup requirement", () => {
  const f = fixture();
  const source = snapshotFile(join(f.oldA, "sentinel"));
  const copyPath = join(f.home, "preserved-source");
  writeFileSync(copyPath, readFileSync(source.path));
  const copy = snapshotFile(copyPath);
  const path = f.manifest.preservation[0].receipt.path;
  writeFileSync(path, JSON.stringify({ root: f.manifest.selected[0], noUnpreservedState: true, nonDependencyDisposition: "preserved", preserved: [{ relativePath: "sentinel", source, copy }] }));
  f.manifest.preservation[0].receipt = snapshotFile(path);
  const tx = stagePrune(f.manifestPath, f.seal(), f.scope, f.options);
  for (const [i, entry] of tx.state.entries.entries()) {
    tx.arm(i); rmSync(entry.stagedPath, { recursive: true }); tx.record(i, 0);
  }
  tx.finish();
  assert.deepEqual(snapshotFile(copyPath), copy);
});

test("bounded 4600-entry preservation receipt parses completely; ordinary and oversized limits stay closed", () => {
  const f = fixture();
  const path = join(f.home, "large-preservation.json");
  const preserved = Array.from({ length: 4600 }, (_, index) => ({ index, relativePath: `src/file-${index}.ts`, source: { path: "/private/fixture/source/" + "x".repeat(190), sha256: "1".repeat(64) }, copy: { path: "/private/fixture/copy/" + "y".repeat(190), sha256: "1".repeat(64) } }));
  writeFileSync(path, JSON.stringify({ preserved }));
  assert.ok(Number(identity(path).size) > 2_687_888);
  assert.ok(Number(identity(path).size) < 4 * 1024 * 1024);
  assert.throws(() => readJson(path), /INPUT_TOO_LARGE/, "ordinary config limit remains 1 MiB");
  const parsed = readJson(path, 4 * 1024 * 1024);
  assert.equal(parsed.preserved.length, 4600);
  assert.equal(parsed.preserved[4599].index, 4599);
  writeFileSync(path, JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024) }));
  assert.throws(() => readJson(path, 4 * 1024 * 1024), /INPUT_TOO_LARGE/);
});

test("complete preservation represents dangling link text, empty directories and file modes without following links", () => {
  const f = fixture();
  const copyRoot = join(f.home, "preserved-tree");
  mkdirSync(copyRoot);
  const previous = join(f.oldA, "previous.tmp");
  symlinkSync("../deliberately-absent/target", previous);
  symlinkSync("../deliberately-absent/target", join(copyRoot, "previous.tmp"));
  mkdirSync(join(f.oldA, "empty"), { mode: 0o750 });
  mkdirSync(join(copyRoot, "empty"), { mode: 0o750 });
  writeFileSync(join(f.oldA, "executable"), "private source\n", { mode: 0o755 });
  writeFileSync(join(copyRoot, "executable"), "private source\n", { mode: 0o755 });
  // Fresh exact fixture authority reflects the added source data; no production scope is changed.
  f.scope.candidates[0] = identity(f.oldA);
  f.manifest.selected[0] = f.scope.candidates[0];
  const capture = (path: string) => {
    const id = identity(path);
    return id.kind === "symlink" ? { ...id, linkText: readlinkSync(path) } : id.kind === "file" ? snapshotFile(path) : id;
  };
  const preserved = ["previous.tmp", "empty", "executable"].map(relativePath => ({ relativePath, source: capture(join(f.oldA, relativePath)), copy: capture(join(copyRoot, relativePath)) }));
  const receiptPath = f.manifest.preservation[0].receipt.path;
  writeFileSync(receiptPath, JSON.stringify({ root: f.manifest.selected[0], noUnpreservedState: true, nonDependencyDisposition: "preserved", preserved }));
  f.manifest.preservation[0].receipt = snapshotFile(receiptPath);
  const tx = stagePrune(f.manifestPath, f.seal(), f.scope, f.options);
  for (const [i, entry] of tx.state.entries.entries()) {
    tx.arm(i); rmSync(entry.stagedPath, { recursive: true }); tx.record(i, 0);
  }
  tx.finish();
  assert.equal(readlinkSync(join(copyRoot, "previous.tmp")), "../deliberately-absent/target");
  assert.equal(identity(join(copyRoot, "empty")).mode, String(0o750));
  assert.equal(identity(join(copyRoot, "executable")).mode, String(0o755));
});

test("preservation rejects changed link text and mismatched directory/file modes", () => {
  for (const kind of ["symlink", "directory", "file"]) {
    const f = fixture();
    const sourcePath = join(f.oldA, "item");
    const copyPath = join(f.home, "preserved-item");
    if (kind === "symlink") { symlinkSync("missing-a", sourcePath); symlinkSync("missing-b", copyPath); }
    if (kind === "directory") { mkdirSync(sourcePath, { mode: 0o750 }); mkdirSync(copyPath, { mode: 0o700 }); }
    if (kind === "file") { writeFileSync(sourcePath, "same bytes"); writeFileSync(copyPath, "same bytes"); chmodSync(sourcePath, 0o755); chmodSync(copyPath, 0o644); }
    f.scope.candidates[0] = identity(f.oldA); f.manifest.selected[0] = f.scope.candidates[0];
    const capture = (p: string) => kind === "file" ? snapshotFile(p) : kind === "symlink" ? { ...identity(p), linkText: readlinkSync(p) } : identity(p);
    const receiptPath = f.manifest.preservation[0].receipt.path;
    writeFileSync(receiptPath, JSON.stringify({ root: f.manifest.selected[0], noUnpreservedState: true, nonDependencyDisposition: "preserved", preserved: [{ relativePath: "item", source: capture(sourcePath), copy: capture(copyPath) }] }));
    f.manifest.preservation[0].receipt = snapshotFile(receiptPath);
    assert.throws(() => stagePrune(f.manifestPath, f.seal(), f.scope, f.options));
    assert.equal(existsSync(f.oldA), true);
  }
});

test("6500-node compact receipt roundtrips and verifies all files/directories/links below unchanged 4 MiB cap", () => {
  const f = fixture();
  const copyRoot = join(f.home, "preserved-nondependency-tree");
  mkdirSync(copyRoot, { mode: Number(identity(f.oldA).mode) });
  writeFileSync(join(copyRoot, "sentinel"), readFileSync(join(f.oldA, "sentinel")));
  const relatives = [".", "sentinel"];
  for (let i = 0; i < 399; i++) {
    const name = `source-directory-${String(i).padStart(4, "0")}`;
    mkdirSync(join(f.oldA, name), { mode: 0o750 }); mkdirSync(join(copyRoot, name), { mode: 0o750 });
    relatives.push(name);
  }
  for (let i = 0; i < 4999; i++) {
    const name = `source-directory-${String(i % 399).padStart(4, "0")}/source-file-${String(i).padStart(5, "0")}.ts`;
    const data = `tiny ${i}\n`;
    writeFileSync(join(f.oldA, name), data, { mode: 0o640 }); writeFileSync(join(copyRoot, name), data, { mode: 0o640 });
    relatives.push(name);
  }
  for (let i = 0; i < 1100; i++) {
    const name = `source-directory-${String(i % 399).padStart(4, "0")}/historical-link-${String(i).padStart(5, "0")}`;
    symlinkSync(`../missing-original-${i}`, join(f.oldA, name)); symlinkSync(`../missing-original-${i}`, join(copyRoot, name));
    relatives.push(name);
  }
  // Deliberately retired dependency fixture is excluded, not archived or recreated.
  mkdirSync(join(f.oldA, "node_modules")); writeFileSync(join(f.oldA, "node_modules", "retired"), "not preserved");
  assert.equal(relatives.length, 6500);
  const expanded = relatives.map(relativePath => ({ relativePath, source: snapshotPreserved(resolve(f.oldA, relativePath)), copy: snapshotPreserved(resolve(copyRoot, relativePath)) }));
  const omitPath = ({ path: _path, ...metadata }: ReturnType<typeof snapshotPreserved>) => metadata;
  const preserved = expanded.map(item => ({ relativePath: item.relativePath, source: Object.fromEntries(Object.entries(omitPath(item.source)).reverse()), copy: Object.fromEntries(Object.entries(omitPath(item.copy)).reverse()) }));
  for (const [i, item] of preserved.entries()) {
    assert.deepEqual({ ...item.source, path: resolve(f.oldA, item.relativePath) }, expanded[i].source);
    assert.deepEqual({ ...item.copy, path: resolve(copyRoot, item.relativePath) }, expanded[i].copy);
  }
  f.scope.candidates[0] = identity(f.oldA); f.manifest.selected[0] = f.scope.candidates[0];
  const receipt = { encoding: "root-relative-v1", root: f.manifest.selected[0], copyRoot: identity(copyRoot), noUnpreservedState: true, nonDependencyDisposition: "preserved", preserved };
  const compactText = JSON.stringify(receipt);
  const expandedBytes = Buffer.byteLength(JSON.stringify({ ...receipt, preserved: expanded }));
  assert.ok(expandedBytes > 4 * 1024 * 1024, String(expandedBytes));
  assert.ok(Buffer.byteLength(compactText) < 4 * 1024 * 1024, String(Buffer.byteLength(compactText)));
  const receiptPath = f.manifest.preservation[0].receipt.path;
  const saveReceipt = (data: unknown) => { writeFileSync(receiptPath, JSON.stringify(data)); f.manifest.preservation[0].receipt = snapshotFile(receiptPath); };
  saveReceipt(receipt);
  assert.equal(readJson(receiptPath, 4 * 1024 * 1024).preserved.length, 6500);
  const verification = verifySafety(f.manifest, f.scope, [], f.options);
  assert.equal(verification.preservedNodes, 6500);
  assert.equal(existsSync(join(copyRoot, "node_modules")), false);
  console.log(`compact receipt: nodes=6500 expandedBytes=${expandedBytes} compactBytes=${Buffer.byteLength(compactText)} verified=6500`);
  for (const change of ["escape", "alias", "identity", "explicit-source", "explicit-copy", "directory-mode", "file-hash", "link-text", "last-identity", "copy-root"]) {
    const broken = JSON.parse(compactText);
    if (change === "escape") broken.preserved[0].relativePath = "../outside";
    if (change === "alias") broken.preserved[1].relativePath = "./sentinel";
    if (change === "identity") delete broken.preserved[0].source.ino;
    if (change === "explicit-source") broken.preserved[0].source.path = f.oldB;
    if (change === "explicit-copy") broken.preserved[0].copy.path = f.oldA;
    if (change === "directory-mode") broken.preserved[0].source.mode = String(0o700);
    if (change === "file-hash") broken.preserved[1].source.sha256 = "0".repeat(64);
    if (change === "link-text") { const index = broken.preserved.findIndex((p: { source: { kind: string } }) => p.source.kind === "symlink"); broken.preserved[index].source.linkText = "different-link-text"; }
    if (change === "last-identity") delete broken.preserved[6499].copy.uid;
    if (change === "copy-root") delete broken.copyRoot.ino;
    saveReceipt(broken);
    assert.throws(() => verifySafety(f.manifest, f.scope, [], f.options), undefined, change);
  }
  saveReceipt(receipt);
});

test("pre-purge pointer or kept-source change restores roots automatically", () => {
  for (const change of ["pointer", "manifest"]) {
    const f = fixture();
    const tx = stagePrune(f.manifestPath, f.digest, f.scope, f.options);
    if (change === "pointer") {
      rmSync(join(f.root, "current")); symlinkSync(f.previous, join(f.root, "current"));
    } else writeFileSync(join(f.plugin, "package.json"), "{}");
    assert.throws(() => tx.arm(0));
    assert.equal(existsSync(f.oldA), true);
    assert.equal(existsSync(f.oldB), true);
    assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  }
});

test("stage failure restores; rollback never overwrites replacement original", () => {
  const f = fixture();
  assert.throws(() => stagePrune(f.manifestPath, f.digest, f.scope, { ...f.options, afterStage: () => { throw Error("injected stage failure"); } }), /injected stage failure/);
  assert.equal(existsSync(f.oldA), true);
  assert.equal(existsSync(f.oldB), true);
  const g = fixture();
  const tx = stagePrune(g.manifestPath, g.digest, g.scope, g.options);
  mkdirSync(g.oldA); writeFileSync(join(g.oldA, "replacement"), "do not overwrite");
  assert.throws(() => tx.cancel(), /RESTORE_CONFLICT/);
  assert.equal(readFileSync(join(g.oldA, "replacement"), "utf8"), "do not overwrite");
  assert.equal(existsSync(tx.state.entries[0].stagedPath), true);
  assert.equal(existsSync(g.oldB), true);
  assert.equal(existsSync(join(g.root, LOCK_NAME)), true);
});

test("irreversible partial native failure stays honest, keeps fence and surviving staged roots", () => {
  const f = fixture();
  const tx = stagePrune(f.manifestPath, f.digest, f.scope, f.options);
  tx.arm(0); rmSync(tx.state.entries[0].stagedPath, { recursive: true }); tx.record(0, 0);
  tx.arm(1); rmSync(join(tx.state.entries[1].stagedPath, "sentinel"));
  assert.throws(() => tx.record(1, 13), /PURGE_NATIVE_FAILURE/);
  assert.equal(tx.state.phase, "partial");
  assert.equal(tx.state.entries[1].nativeExit, 13);
  assert.throws(() => tx.cancel(), /IRREVERSIBLE/);
  assert.equal(existsSync(join(f.root, LOCK_NAME)), true);
  assert.equal(existsSync(f.oldB), false);
  f.checkProtected();
});

test("negative control: corrupt tiny kept input fails, restored clean control passes with no residue", () => {
  const f = fixture();
  const target = join(f.plugin, "package.json");
  const original = readFileSync(target);
  const scopePath = join(f.home, "fixture-scope.json");
  writeFileSync(scopePath, JSON.stringify(f.scope));
  const verifierCode = `import { readJson } from ${JSON.stringify(pathToFileURL(resolve("scripts/deployment-fence.ts")).href)};
    import { verifySafety } from ${JSON.stringify(pathToFileURL(resolve("scripts/prune-safety.ts")).href)};
    const manifest = readJson(process.argv[1]); const scope = readJson(process.argv[2]);
    try { verifySafety(manifest, scope, [], { processProbe: pid => manifest.runtimes.find(r => r.process.pid === pid).process }); console.log("clean fixture verifier"); }
    catch (error) { console.error(error.code); process.exitCode = 1; }`;
  const verifyChild = () => spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", verifierCode, f.manifestPath, scopePath], { env: { HOME: f.home, PATH: resolve(process.execPath, "..") }, encoding: "utf8" });
  writeFileSync(target, "{corrupt");
  const corrupt = verifyChild();
  assert.equal(corrupt.status, 1, corrupt.stderr);
  assert.match(corrupt.stderr, /UNREADABLE_JSON/);
  assert.throws(() => stagePrune(f.manifestPath, f.digest, f.scope, f.options));
  assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  writeFileSync(target, original);
  f.manifest.runtimes[0].inputs = captureRuntimeInputs(f.current, f.current);
  const digest = f.seal();
  const clean = verifyChild();
  assert.equal(clean.status, 0, clean.stderr);
  console.log("negative-control native exits: corrupt=1 restored=0");
  const tx = stagePrune(f.manifestPath, digest, f.scope, f.options);
  tx.cancel();
  assert.equal(existsSync(join(f.root, LOCK_NAME)), false);
  assert.deepEqual(readdirSync(f.root).sort(), ["current", "previous", "releases"]);
  f.checkProtected();
});

test.after(() => {
  for (const p of fixtureParents) rmSync(p, { recursive: true });
  assert.ok(fixtureParents.every(p => !existsSync(p)), "no private fixture residue");
});
