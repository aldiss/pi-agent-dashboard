import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertIdentity, fail, identity, readJson, sameIdentity, snapshotFile, snapshotLink, snapshotPreserved, JSON_INPUT_MAX_BYTES, PRESERVATION_RECEIPT_MAX_BYTES } from "./deployment-fence.ts";
import type { FileSnapshot, Identity, LinkSnapshot, PreservedSnapshot } from "./deployment-fence.ts";

export const APPROVED_SCOPE_SHA256 = "5812f4aa64e9238b727e3b0b7d46a40e73af2685a85117d2c453b76c0323820e";
export const SUPPORTED_ENTRYPOINT = "/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard/scripts/deploy.mjs";
export const TOOLING_HELPERS = ["deployment-fence.ts", "manual-prune.ts", "prune-safety.ts"];
const LOCAL_TOOLING_HASHES = Object.fromEntries(["deploy.mjs", ...TOOLING_HELPERS].map(name => [name, snapshotFile(fileURLToPath(new URL(name, import.meta.url)), JSON_INPUT_MAX_BYTES).sha256]));
export const RUNTIME_FILES = [
  "packages/server/bin/pi-dashboard.mjs", "packages/server/src/cli.ts", "packages/server/src/server.ts",
  "packages/shared/src/bridge-register.ts", "packages/shared/src/plugin-bridge-register.ts", "packages/shared/src/settings-io.ts",
  "packages/dashboard-plugin-runtime/src/server/loader.ts", "packages/dashboard-plugin-runtime/src/manifest-validator.ts",
];
export type Scope = { sha256: string; prodRoot: string; entrypoint: string; candidates: Identity[] };
export type ProcessFact = { pid: number; started: string; commandSha256: string; cwd: string };
export type Manifest = {
  version: number; scopeSha256: string; validUntil: string; prodRoot: Identity; releases: Identity;
  selected: Identity[]; kept: Identity[]; current: LinkSnapshot; previous: LinkSnapshot;
  settings: FileSnapshot; references: Identity[]; factFiles: FileSnapshot[];
  activation: { entrypoint: FileSnapshot; helpers: FileSnapshot[]; receipt: FileSnapshot };
  preservation: { root: string; receipt: FileSnapshot }[];
  runtimes: { process: ProcessFact; sourceRoot: string; inputs: ReturnType<typeof captureRuntimeInputs> }[];
  assertions: Record<string, boolean>;
};
export type Location = { original: Identity; stagedPath: string; status: string };
export type SafetyAdapters = { processProbe?: (pid: number) => ProcessFact };
export type RelativeNodeMetadata = Omit<PreservedSnapshot, "path"> & { path?: string };
export type CompactPreservationReceipt = {
  encoding: "root-relative-v1"; root: Identity; copyRoot: Identity;
  noUnpreservedState: true; nonDependencyDisposition: "preserved";
  preserved: { relativePath: string; source: RelativeNodeMetadata; copy: RelativeNodeMetadata }[];
};

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
}

function equal(actual: unknown, expected: unknown, code: string): void {
  if (!isDeepStrictEqual(actual, expected)) fail(code, "held safety input changed");
}

function completeIdentity(value: Identity, kind?: string): void {
  if (!value || typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path || ![value.dev, value.ino, value.uid, value.mode, value.mtimeNs, value.size].every(v => typeof v === "string" && /^\d+$/.test(v)) || !["directory", "file", "symlink"].includes(value.kind) || (kind && value.kind !== kind)) fail("IDENTITY_UNCERTAIN", "complete path/device/inode/owner/type identity required");
}

function heldRuntimePath(root: string, path: string): Identity {
  if (!inside(root, path)) fail("RUNTIME_ESCAPE", path);
  let cursor = root;
  for (const part of ["", ...relative(root, path).split("/").filter(Boolean)]) {
    cursor = join(cursor, part);
    const stat = identity(cursor);
    if (stat.kind === "symlink" || stat.kind === "other") fail("RUNTIME_SYMLINK_OR_TYPE", cursor);
  }
  if (realpathSync(path) !== path) fail("RUNTIME_ALIAS", path);
  return identity(path);
}

/** Conservative superset of retained discoverPlugins: even an invalid declared bridge must stay kept. */
export function captureRuntimeInputs(sourceRoot: string, cwd: string) {
  const source = heldRuntimePath(sourceRoot, sourceRoot);
  const working = heldRuntimePath(cwd, cwd);
  const sources = RUNTIME_FILES.map(p => { const path = join(sourceRoot, p); heldRuntimePath(sourceRoot, path); return snapshotFile(path); });
  const extension = heldRuntimePath(sourceRoot, join(sourceRoot, "packages", "extension"));
  const extensionPackage = snapshotFile(join(extension.path, "package.json"));
  const packagesDir = heldRuntimePath(cwd, join(cwd, "packages"));
  const packages = readdirSync(packagesDir.path).sort().map(name => {
    const dir = heldRuntimePath(cwd, join(packagesDir.path, name));
    if (dir.kind !== "directory") fail("RUNTIME_PACKAGE_TYPE", dir.path);
    const packagePath = join(dir.path, "package.json");
    if (!exists(packagePath)) return { name, dir, package: null };
    heldRuntimePath(cwd, packagePath);
    const pkg = snapshotFile(packagePath);
    const raw = readJson(packagePath);
    const adjacentPath = join(dir.path, "dashboard-plugin.json");
    let adjacent: FileSnapshot | null = null;
    let manifest = raw["pi-dashboard-plugin"];
    if (exists(adjacentPath)) {
      heldRuntimePath(cwd, adjacentPath);
      adjacent = snapshotFile(adjacentPath);
      manifest = readJson(adjacentPath);
    }
    let bridge: { id: string; target: Identity } | null = null;
    if (manifest != null && typeof manifest !== "object") fail("RUNTIME_MANIFEST_UNCERTAIN", dir.path);
    if (manifest?.bridge !== undefined) {
      if (typeof manifest.bridge !== "string" || !manifest.bridge || typeof manifest.id !== "string") fail("RUNTIME_BRIDGE_UNCERTAIN", dir.path);
      bridge = { id: manifest.id, target: heldRuntimePath(cwd, resolve(dir.path, manifest.bridge)) };
    }
    equal(snapshotFile(packagePath), pkg, "RUNTIME_INPUT_CHANGED");
    if (adjacent) equal(snapshotFile(adjacentPath), adjacent, "RUNTIME_INPUT_CHANGED");
    return { name, dir, package: pkg, adjacent, bridge };
  });
  return { source, working, sources, extension, extensionPackage, packagesDir, packages };
}

/** Exact known PIDs only; no process census or original session/credential reads. */
export function captureProcess(pid: number): ProcessFact {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("RUNTIME_PID_UNCERTAIN", String(pid));
  const options = { encoding: "utf8" as const, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, timeout: 5000 };
  try {
    const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], options).trim();
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], options).trim();
    const uid = execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid="], options).trim();
    const cwdLines = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], options).split("\n").filter(line => line.startsWith("n"));
    if (!started || !command || uid !== String(process.getuid?.()) || cwdLines.length !== 1) fail("RUNTIME_PROCESS_UNCERTAIN", String(pid));
    return { pid, started, commandSha256: createHash("sha256").update(command).digest("hex"), cwd: realpathSync(cwdLines[0].slice(1)) };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    fail("RUNTIME_PROCESS_UNREADABLE", `pid=${pid} nativeExit=${e.status ?? "none"} code=${e.code ?? "unknown"}`);
  }
}

export function loadApprovedScope(path: string): Scope {
  const snap = snapshotFile(path, JSON_INPUT_MAX_BYTES);
  if (snap.sha256 !== APPROVED_SCOPE_SHA256) fail("SCOPE_NOT_APPROVED", path);
  const data = readJson(path);
  equal(snapshotFile(path), snap, "SCOPE_CHANGED");
  return { sha256: snap.sha256, prodRoot: data.prodRoot, entrypoint: SUPPORTED_ENTRYPOINT, candidates: data.initialCandidateRoots.map((p: any) => ({ ...p, ino: p.inode, uid: String(p.uid) })) };
}

export function validateSelection(m: Manifest, scope: Scope): void {
  if (m.version !== 1 || m.scopeSha256 !== scope.sha256 || m.prodRoot?.path !== scope.prodRoot || !Array.isArray(m.selected) || !m.selected.length || m.selected.length > scope.candidates.length) fail("MANIFEST_SCOPE", "not the sealed approved scope");
  completeIdentity(m.prodRoot, "directory");
  completeIdentity(m.releases, "directory");
  for (const p of m.selected) completeIdentity(p, "directory");
  if (new Set(m.selected.map(p => p.path)).size !== m.selected.length) fail("MANIFEST_DUPLICATE", "candidate repeated");
  for (const p of m.selected) {
    const approved = scope.candidates.find(a => a.path === p.path);
    if (!approved || p.path !== resolve(p.path) || resolve(p.path, "..") !== join(scope.prodRoot, "releases") || p.kind !== "directory" || ![p.dev, p.ino, p.uid, p.mtimeNs].every(v => typeof v === "string" && /^\d+$/.test(v)) || !sameIdentity(p, approved) || p.mtimeNs !== approved.mtimeNs) fail("MANIFEST_SUBSTITUTION", p.path ?? "missing path");
  }
}

function disjoint(m: Manifest, path: string): void {
  if (m.selected.some(p => inside(p.path, path) || inside(path, p.path))) fail("PROTECTED_CANDIDATE", path);
}

function checkFile(snap: FileSnapshot, m: Manifest, limit = JSON_INPUT_MAX_BYTES): void {
  disjoint(m, snap.path);
  equal(snapshotFile(snap.path, Math.min(limit, Number(snap.size))), snap, "FACT_CHANGED");
}

function verifyActivation(m: Manifest, scope: Scope): void {
  const activation = m.activation;
  if (!activation || activation.entrypoint?.path !== scope.entrypoint || !Array.isArray(activation.helpers) || activation.helpers.length !== TOOLING_HELPERS.length) fail("ACTIVATION_UNCERTAIN", "actual supported entrypoint and every helper must be pinned");
  const files = [activation.entrypoint, ...activation.helpers];
  const names = ["deploy.mjs", ...TOOLING_HELPERS];
  for (const [i, name] of names.entries()) {
    const expectedPath = join(dirname(scope.entrypoint), name);
    if (files[i].path !== expectedPath || files[i].sha256 !== LOCAL_TOOLING_HASHES[name]) fail("ACTIVATION_NOT_INSTALLED", expectedPath);
    checkFile(files[i], m);
  }
  checkFile(activation.receipt, m);
  const receipt = readJson(activation.receipt.path);
  const published = Date.parse(receipt.publishedAt);
  const verified = Date.parse(receipt.verifiedAt);
  if (receipt.version !== 1 || receipt.scopeSha256 !== scope.sha256 || receipt.legacyWritersDrained !== true || receipt.nativeExit !== 0 || !Array.isArray(receipt.legacyWriterPids) || receipt.legacyWriterPids.length || !Number.isFinite(published) || !Number.isFinite(verified) || verified < published || verified > Date.now()) fail("ACTIVATION_DRAIN_UNCERTAIN", "post-publication legacy-writer check required");
  equal(receipt.files, files.map(({ path, sha256 }) => ({ path, sha256 })), "ACTIVATION_RECEIPT_CHANGED");
}

function samePreservedData(a: PreservedSnapshot, b: PreservedSnapshot): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.kind === "file") return typeof a.sha256 === "string" && /^[0-9a-f]{64}$/.test(a.sha256) && a.sha256 === b.sha256;
  if (a.kind === "symlink") return typeof a.linkText === "string" && a.linkText === b.linkText;
  return a.kind === "directory";
}

function verifyPins(m: Manifest): void {
  checkFile(m.settings, m);
  const settings = readJson(m.settings.path);
  const refs: string[] = [];
  for (const key of ["packages", "extensions", "skills", "prompts", "themes"]) {
    const values = settings[key] ?? [];
    if (!Array.isArray(values)) fail("PINS_UNCERTAIN", key);
    for (const entry of values) {
      if (entry && typeof entry === "object" && Object.keys(entry).some(k => k !== "source")) fail("PINS_UNCERTAIN", "package filters/overrides require an explicit resolved-reference assessment");
      const value = typeof entry === "string" ? entry : key === "packages" && entry && typeof entry === "object" ? entry.source : undefined;
      if (typeof value !== "string") fail("PINS_UNCERTAIN", key);
      refs.push(value);
    }
  }
  const plugins = settings.dashboardPluginBridges ?? {};
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) fail("PINS_UNCERTAIN", "dashboardPluginBridges");
  for (const value of Object.values(plugins)) {
    if (typeof value !== "string") fail("PINS_UNCERTAIN", "plugin path");
    refs.push(value);
  }
  for (let value of refs) {
    if (/^(npm:|https?:\/\/|git:https?:\/\/|git:ssh:\/\/|git@)/.test(value)) continue;
    if (value.startsWith("file:")) value = fileURLToPath(value);
    if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    if (!isAbsolute(value) || /[*?\[\]]/.test(value)) fail("PINS_UNRESOLVABLE", "relative/unknown/glob reference");
    disjoint(m, realpathSync(value));
  }
  checkFile(m.settings, m);
}

function relativeNodePath(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel || isAbsolute(rel)) fail("PRESERVATION_ESCAPE", root);
  const path = resolve(root, rel);
  if (!inside(root, path) || (rel !== "." && relative(root, path) !== rel)) fail("PRESERVATION_ESCAPE_OR_ALIAS", path);
  return path;
}

function withNodePath(metadata: RelativeNodeMetadata, path: string): PreservedSnapshot {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("IDENTITY_UNCERTAIN", path);
  if (metadata.path !== undefined && metadata.path !== path) fail("PRESERVATION_EXPLICIT_PATH", path);
  const { path: _path, ...fields } = metadata;
  const node = { path, ...fields };
  completeIdentity(node);
  return node;
}

function verifyPreservation(m: Manifest, locations: Location[]): number {
  let preservedNodes = 0;
  if (!Array.isArray(m.preservation) || m.preservation.length !== m.selected.length) fail("PRESERVATION_UNCERTAIN", "one exact receipt per selected root required");
  for (const selected of m.selected) {
    const entries = m.preservation.filter(p => p.root === selected.path);
    if (entries.length !== 1) fail("PRESERVATION_UNCERTAIN", selected.path);
    const entry = entries[0];
    // Fixed ten-root scope × 4 MiB = at most 40 MiB of receipts; no increase to 64 MiB evidence envelope.
    checkFile(entry.receipt, m, PRESERVATION_RECEIPT_MAX_BYTES);
    const receipt = readJson(entry.receipt.path, PRESERVATION_RECEIPT_MAX_BYTES);
    completeIdentity(receipt.root, "directory");
    if (receipt.root?.path !== selected.path || !sameIdentity(selected, receipt.root) || receipt.noUnpreservedState !== true || !["no-unique-data", "preserved"].includes(receipt.nonDependencyDisposition) || !Array.isArray(receipt.preserved) || (receipt.nonDependencyDisposition === "preserved" && !receipt.preserved.length)) fail("UNPRESERVED_STATE", selected.path);
    const location = locations.find(p => p.original.path === selected.path);
    const compact = receipt.encoding === "root-relative-v1";
    if (receipt.encoding !== undefined && !compact) fail("PRESERVATION_ENCODING", "unknown receipt encoding");
    if (compact) {
      if (receipt.nonDependencyDisposition !== "preserved") fail("PRESERVATION_ENCODING", "root-relative receipt requires complete preserved-node proof");
      completeIdentity(receipt.copyRoot, "directory");
      disjoint(m, receipt.copyRoot.path);
      equal(snapshotPreserved(receipt.copyRoot.path), receipt.copyRoot, "PRESERVATION_COPY_ROOT_CHANGED");
      if (!samePreservedData(receipt.root, receipt.copyRoot)) fail("PRESERVATION_ROOT_MODE", receipt.copyRoot.path);
    }
    const seen = new Set<string>();
    for (const record of receipt.preserved) {
      const sourcePath = relativeNodePath(selected.path, record.relativePath);
      const item = compact ? {
        relativePath: record.relativePath,
        source: withNodePath(record.source, sourcePath),
        copy: withNodePath(record.copy, relativeNodePath(receipt.copyRoot.path, record.relativePath)),
      } : record;
      if (seen.has(sourcePath) || item.source?.path !== sourcePath) fail("PRESERVATION_DUPLICATE_OR_ALIAS", sourcePath);
      seen.add(sourcePath);
      completeIdentity(item.source);
      completeIdentity(item.copy);
      disjoint(m, item.copy.path);
      equal(snapshotPreserved(item.copy.path), item.copy, "PRESERVATION_COPY_CHANGED");
      if (!samePreservedData(item.source, item.copy)) fail("PRESERVATION_MISMATCH", sourcePath);
      if (location?.status !== "purged") {
        const base = location?.status === "staged" || location?.status === "armed" ? location.stagedPath : selected.path;
        const actual = snapshotPreserved(resolve(base, item.relativePath));
        if (!sameIdentity(actual, item.source) || actual.mtimeNs !== item.source.mtimeNs || actual.size !== item.source.size || !samePreservedData(actual, item.source)) fail("PRESERVATION_SOURCE_CHANGED", sourcePath);
      }
      preservedNodes++;
    }
    checkFile(entry.receipt, m, PRESERVATION_RECEIPT_MAX_BYTES);
  }
  return preservedNodes;
}

export function verifySafety(m: Manifest, scope: Scope, locations: Location[] = [], adapters: SafetyAdapters = {}): { preservedNodes: number } {
  validateSelection(m, scope);
  if (!Number.isFinite(Date.parse(m.validUntil)) || Date.parse(m.validUntil) <= Date.now()) fail("FACTS_EXPIRED", "supervisor validity window ended");
  for (const key of ["referenceCensusComplete", "noCandidateReaders", "noCandidatePins", "preservationComplete", "supportedWritersActivated", "runtimeInputsPinned"]) {
    if (m.assertions?.[key] !== true) fail("SAFETY_UNCERTAIN", key);
  }
  verifyActivation(m, scope);
  if (realpathSync(m.prodRoot.path) !== m.prodRoot.path || m.releases.path !== join(m.prodRoot.path, "releases")) fail("ROOT_ALIAS", m.prodRoot.path);
  for (const p of [m.prodRoot, m.releases, ...m.kept]) {
    completeIdentity(p, "directory");
    const actual = assertIdentity(p.path, p);
    if (actual.kind !== "directory" || actual.uid !== String(process.getuid?.()) || (Number(actual.mode) & 0o022) !== 0 || realpathSync(p.path) !== p.path) fail("ROOT_UNSAFE", p.path);
  }
  for (const p of m.kept) disjoint(m, p.path);
  for (const pointer of [m.current, m.previous]) {
    equal(snapshotLink(pointer.path), pointer, "POINTER_CHANGED");
    if (!m.kept.some(k => k.path === pointer.target)) fail("POINTER_NOT_KEPT", pointer.path);
  }
  if (m.current.path !== join(m.prodRoot.path, "current") || m.previous.path !== join(m.prodRoot.path, "previous")) fail("POINTER_ALIAS", "wrong pointer path");
  for (const p of m.references) {
    completeIdentity(p);
    assertIdentity(p.path, p, p.kind === "file");
    disjoint(m, realpathSync(p.path));
  }
  if (!m.factFiles.length || !m.runtimes.length) fail("SAFETY_UNCERTAIN", "reference census and known runtime inputs required");
  for (const p of m.factFiles) checkFile(p, m);
  verifyPins(m);
  for (const runtime of m.runtimes) {
    equal((adapters.processProbe ?? captureProcess)(runtime.process.pid), runtime.process, "RUNTIME_IDENTITY_CHANGED");
    if (![runtime.sourceRoot, runtime.process.cwd].every(p => m.kept.some(k => k.path === p))) fail("RUNTIME_NOT_KEPT", runtime.sourceRoot);
    equal(captureRuntimeInputs(runtime.sourceRoot, runtime.process.cwd), runtime.inputs, "RUNTIME_INPUT_CHANGED");
  }
  const preservedNodes = verifyPreservation(m, locations);
  for (const selected of m.selected) {
    const location = locations.find(p => p.original.path === selected.path);
    if (location?.status === "purged") continue;
    const path = location?.status === "staged" || location?.status === "armed" ? location.stagedPath : selected.path;
    const actual = assertIdentity(path, selected, true);
    if (actual.kind !== "directory" || actual.dev !== m.releases.dev || actual.uid !== String(process.getuid?.()) || realpathSync(path) !== path) fail("CANDIDATE_UNSAFE", path);
  }
  return { preservedNodes };
}
