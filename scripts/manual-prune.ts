import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireFence, assertIdentity, fail, identity, readJson, resumeFence, sameIdentity, snapshotFile, writeExclusiveJson, JSON_INPUT_MAX_BYTES } from "./deployment-fence.ts";
import type { Fence, FileSnapshot, Identity } from "./deployment-fence.ts";
import { loadApprovedScope, validateSelection, verifySafety } from "./prune-safety.ts";
import type { Location, Manifest, SafetyAdapters, Scope } from "./prune-safety.ts";

type Entry = Location & { nativeExit?: number };
type State = {
  version: 1; token: string; scopeSha256: string; manifestFile: FileSnapshot; manifest: Manifest;
  staging: Identity; entries: Entry[]; phase: string; irreversibleStarted: boolean;
  protectedChecks: string; errors: { code: string; message: string; nativeExit?: number }[];
};
type Adapters = SafetyAdapters & { afterStage?: (index: number) => void };

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
}

function failure(err: unknown) {
  const e = err as { code?: string; message?: string; status?: number; nativeExit?: number };
  return { code: e.code ?? "NATIVE_ERROR", message: e.message ?? String(err), ...(e.status !== undefined || e.nativeExit !== undefined ? { nativeExit: e.status ?? e.nativeExit } : {}) };
}

/** Exclusive destination reservation; never rename over an observed third-party path. */
function reservedRename(source: string, destination: string, expected: Identity): void {
  assertIdentity(source, expected);
  mkdirSync(destination, { mode: 0o700 }); // EEXIST includes replaced directories, files and dangling symlinks.
  const reservation = identity(destination);
  try {
    assertIdentity(source, expected);
    assertIdentity(destination, reservation);
    if (readdirSync(destination).length) fail("DESTINATION_CHANGED", destination);
    renameSync(source, destination);
    assertIdentity(destination, expected);
  } catch (err) {
    // Only remove our still-empty reservation, never a replacement path or contents.
    if (exists(destination) && sameIdentity(identity(destination), reservation) && readdirSync(destination).length === 0) rmdirSync(destination);
    throw err;
  }
}

export class PruneTransaction {
  state: State;
  token: string;
  private fence: Fence;
  private scope: Scope;
  private adapters: Adapters;
  private journal: FileSnapshot | undefined;
  private operation: Identity | undefined;
  constructor(fence: Fence, scope: Scope, state: State, adapters: Adapters) {
    this.fence = fence; this.scope = scope; this.state = state; this.adapters = adapters; this.token = fence.token;
    const path = join(fence.path, "transaction.json");
    if (exists(path)) this.journal = snapshotFile(path);
  }
  private operate<T>(action: () => T): T {
    this.fence.assertHeld();
    const path = join(this.fence.path, "operation");
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") fail("TRANSACTION_BUSY", "an operation owns this transaction; no stale-operation stealing", 73);
      throw err;
    }
    this.operation = identity(path);
    try {
      if (this.journal && JSON.stringify(snapshotFile(this.journal.path)) !== JSON.stringify(this.journal)) fail("TRANSACTION_CHANGED", "reopen current state; do not act from a stale snapshot");
      return action();
    } finally { this.endOperation(); }
  }
  private endOperation(): void {
    if (this.operation) {
      assertIdentity(this.operation.path, this.operation);
      rmdirSync(this.operation.path);
      this.operation = undefined;
    }
  }
  private save(): void {
    this.fence.assertHeld();
    const temp = join(this.fence.path, `transaction-${randomBytes(8).toString("hex")}.tmp`);
    writeExclusiveJson(temp, this.state);
    renameSync(temp, join(this.fence.path, "transaction.json"));
    this.journal = snapshotFile(join(this.fence.path, "transaction.json"));
  }
  private check(): void {
    this.fence.assertHeld();
    assertIdentity(this.state.staging.path, this.state.staging);
    if (JSON.stringify(snapshotFile(this.state.manifestFile.path, Number(this.state.manifestFile.size))) !== JSON.stringify(this.state.manifestFile)) fail("MANIFEST_CHANGED", this.state.manifestFile.path);
    for (const entry of this.state.entries) {
      if (["staged", "armed", "purged"].includes(entry.status) && exists(entry.original.path)) fail("ORIGINAL_REPLACED", entry.original.path);
    }
    verifySafety(this.state.manifest, this.scope, this.state.entries, this.adapters);
    this.state.protectedChecks = "passed";
  }
  private preflight(): void {
    try { this.check(); }
    catch (err) {
      this.state.protectedChecks = "failed";
      this.state.errors.push(failure(err));
      if (!this.state.irreversibleStarted) {
        try { this.restore(); }
        catch (restoreError) {
          throw Object.assign(new Error(`${failure(err).message}; ${failure(restoreError).message}`), { code: "RESTORE_CONFLICT", result: this.result() });
        }
      } else {
        this.state.phase = "partial";
        this.save();
      }
      throw Object.assign(err as Error, { result: this.result() });
    }
  }
  stage(): void {
    this.operate(() => this.stageOwned());
  }
  private stageOwned(): void {
    try {
      for (const [index, entry] of this.state.entries.entries()) {
        this.check();
        if (exists(entry.stagedPath)) fail("STAGING_COLLISION", entry.stagedPath);
        this.save(); // Plan exists before each move; recovery also checks filesystem, not just status.
        reservedRename(entry.original.path, entry.stagedPath, entry.original);
        entry.status = "staged";
        this.save();
        this.adapters.afterStage?.(index);
      }
      this.check();
      this.state.phase = "staged";
      this.save();
    } catch (err) {
      this.state.errors.push(failure(err));
      try { this.restore(); }
      catch (restoreError) {
        throw Object.assign(new Error(`${failure(err).message}; ${failure(restoreError).message}`), { code: "RESTORE_CONFLICT", result: this.result() });
      }
      throw Object.assign(err as Error, { result: this.result() });
    }
  }
  arm(index: number): void {
    this.operate(() => this.armOwned(index));
  }
  private armOwned(index: number): void {
    if (this.state.phase !== "staged" || !Number.isSafeInteger(index) || this.state.entries[index]?.status !== "staged") fail("PURGE_ORDER", "one exact staged root at a time");
    this.preflight();
    // From this point onward an external guarded rm may have partially run. Never promise rollback.
    this.state.irreversibleStarted = true;
    this.state.entries[index].status = "armed";
    this.state.phase = "armed";
    this.save();
  }
  record(index: number, nativeExit: number): void {
    this.operate(() => this.recordOwned(index, nativeExit));
  }
  private recordOwned(index: number, nativeExit: number): void {
    if (this.state.phase !== "armed" || this.state.entries[index]?.status !== "armed" || !Number.isSafeInteger(nativeExit) || nativeExit < 0 || nativeExit > 255) fail("PURGE_ORDER", "missing armed action or invalid native exit");
    this.fence.assertHeld();
    const entry = this.state.entries[index];
    entry.nativeExit = nativeExit;
    const absent = !exists(entry.stagedPath);
    if (absent) entry.status = "purged";
    if (nativeExit !== 0 || !absent) {
      this.state.phase = "partial";
      this.state.protectedChecks = "not-verified-after-native-failure";
      const err = Object.assign(new Error(`PURGE_NATIVE_FAILURE: index=${index} nativeExit=${nativeExit} stagedRootAbsent=${absent}`), { code: "PURGE_NATIVE_FAILURE", nativeExit, exitCode: nativeExit || 1 });
      this.state.errors.push(failure(err));
      this.save();
      throw Object.assign(err, { result: this.result() });
    }
    this.state.phase = "staged";
    this.save();
    this.preflight();
    this.save();
  }
  private restore(): void {
    if (this.state.irreversibleStarted) fail("IRREVERSIBLE", "external purge may have run; retain surviving staged roots and fence");
    this.fence.assertHeld();
    assertIdentity(this.state.staging.path, this.state.staging);
    const conflicts: string[] = [];
    for (const entry of [...this.state.entries].reverse()) {
      try {
        this.fence.assertHeld();
        if (exists(entry.stagedPath)) {
          if (exists(entry.original.path)) fail("RESTORE_CONFLICT", entry.original.path);
          reservedRename(entry.stagedPath, entry.original.path, entry.original);
        } else {
          assertIdentity(entry.original.path, entry.original);
        }
        entry.status = "restored";
        this.save();
      } catch (err) { conflicts.push(failure(err).message); }
    }
    if (conflicts.length) {
      this.state.phase = "restore-conflict";
      this.state.errors.push({ code: "RESTORE_CONFLICT", message: conflicts.join("; ") });
      this.save();
      fail("RESTORE_CONFLICT", conflicts.join("; "));
    }
    this.state.phase = "restored";
    try { this.check(); }
    catch (err) { this.state.protectedChecks = "failed"; this.state.errors.push(failure(err)); }
    this.save();
    this.close();
  }
  cancel() {
    return this.operate(() => {
      if (!["staging", "staged", "restore-conflict", "armed", "partial"].includes(this.state.phase)) fail("RESTORE_ORDER", this.state.phase);
      try { this.restore(); }
      catch (err) { throw Object.assign(err as Error, { result: this.result() }); }
      return this.result();
    });
  }
  finish() {
    return this.operate(() => {
      if (!this.state.entries.every(e => e.status === "purged") || this.state.phase !== "staged") fail("PURGE_INCOMPLETE", "retain fence and surviving roots");
      this.preflight();
      this.state.phase = "complete";
      this.save();
      this.close();
      return this.result();
    });
  }
  private close(): void {
    this.fence.assertHeld();
    assertIdentity(this.state.staging.path, this.state.staging);
    // Only empty, owned transaction metadata is removed here. No release payload deletion API.
    rmdirSync(this.state.staging.path);
    unlinkSync(join(this.fence.path, "transaction.json"));
    this.endOperation();
    this.fence.release();
  }
  result() {
    const observe = (path: string) => {
      try { return exists(path) ? identity(path) : null; }
      catch (err) { return { error: failure(err) }; }
    };
    return {
      phase: this.state.phase, prodRoot: this.fence.root, token: this.token,
      before: this.state.entries.map(e => e.original),
      actions: this.state.entries.map(e => ({ original: e.original.path, staged: e.stagedPath, state: e.status, ...(e.nativeExit === undefined ? {} : { nativeExit: e.nativeExit }) })),
      after: this.state.entries.map(e => ({ original: observe(e.original.path), staged: observe(e.stagedPath) })),
      protectedChecks: this.state.protectedChecks, irreversibleStarted: this.state.irreversibleStarted, errors: this.state.errors,
    };
  }
  commands(entrypoint: string, scopePath?: string): string[] {
    if (this.state.phase !== "staged") fail("PURGE_ORDER", "commands require staged transaction");
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const prefix = [process.execPath, resolve(entrypoint), "--manual-prune"].map(quote).join(" ");
    const common = [this.fence.root, this.token].map(quote).join(" ");
    const scopeArg = scopePath ? quote(resolve(scopePath)) : '"$PRUNE_SCOPE"';
    return this.state.entries.map((e, i) => `${prefix} arm ${scopeArg} ${common} ${i} && {\n  rm -rf -- ${quote(e.stagedPath)}\n  prune_rc=$?\n  ${prefix} record ${scopeArg} ${common} ${i} "$prune_rc"\n  record_rc=$?\n  if [ "$prune_rc" -ne 0 ]; then exit "$prune_rc"; fi\n  exit "$record_rc"\n}`);
  }
}

export function stagePrune(manifestPath: string, expectedSha256: string, scope: Scope, adapters: Adapters = {}): PruneTransaction {
  const file = snapshotFile(resolve(manifestPath), JSON_INPUT_MAX_BYTES);
  if (file.sha256 !== expectedSha256) fail("MANIFEST_DIGEST", manifestPath);
  const manifest = readJson(file.path) as Manifest;
  validateSelection(manifest, scope);
  const fence = acquireFence(manifest.prodRoot.path, "prune");
  let tx: PruneTransaction | undefined;
  try {
    verifySafety(manifest, scope, [], adapters);
    if (manifest.prodRoot.dev !== manifest.releases.dev) fail("STAGING_DEVICE", "releases and production root must share one device for reversible staging");
    if (JSON.stringify(snapshotFile(file.path)) !== JSON.stringify(file)) fail("MANIFEST_CHANGED", file.path);
    const stagingPath = join(fence.root, `.manual-prune-${fence.token}`);
    mkdirSync(stagingPath, { mode: 0o700 });
    const staging = identity(stagingPath);
    if (staging.dev !== manifest.releases.dev) fail("STAGING_DEVICE", stagingPath);
    const state: State = {
      version: 1, token: fence.token, scopeSha256: scope.sha256, manifestFile: file, manifest, staging,
      entries: manifest.selected.map(original => ({ original, stagedPath: join(stagingPath, basename(original.path)), status: "pending" })),
      phase: "staging", irreversibleStarted: false, protectedChecks: "passed", errors: [],
    };
    tx = new PruneTransaction(fence, scope, state, adapters);
    tx.stage();
    return tx;
  } catch (err) {
    if (!tx) fence.release();
    throw err;
  }
}

export function openPrune(root: string, token: string, scope: Scope, adapters: Adapters = {}): PruneTransaction {
  const fence = resumeFence(root, token, "prune");
  const state = readJson(join(fence.path, "transaction.json")) as State;
  if (state.version !== 1 || state.token !== token || state.scopeSha256 !== scope.sha256 || state.staging?.path !== join(fence.root, `.manual-prune-${token}`) || state.manifest?.prodRoot.path !== fence.root) fail("TRANSACTION_UNCERTAIN", fence.path);
  validateSelection(state.manifest, scope);
  if (state.entries.length !== state.manifest.selected.length || state.entries.some((e, i) => JSON.stringify(e.original) !== JSON.stringify(state.manifest.selected[i]) || e.stagedPath !== join(state.staging.path, basename(e.original.path)))) fail("TRANSACTION_SUBSTITUTION", fence.path);
  return new PruneTransaction(fence, scope, state, adapters);
}

/** Only the CLI uses fixed approved scope. Test adapters are imports, never environment/CLI bypasses. */
export function runPruneCli(args: string[]): unknown {
  const [action, scopePath, ...rest] = args;
  const lengths: Record<string, number> = { stage: 2, arm: 3, record: 4, finish: 2, cancel: 2, status: 2 };
  if (!(action in lengths) || !scopePath || rest.length !== lengths[action]) fail("PRUNE_USAGE", "stage SCOPE MANIFEST SHA | arm SCOPE ROOT TOKEN INDEX | record SCOPE ROOT TOKEN INDEX NATIVE_EXIT | finish/cancel/status SCOPE ROOT TOKEN", 64);
  const scope = loadApprovedScope(scopePath);
  if (action === "stage") {
    const tx = stagePrune(rest[0], rest[1], scope);
    return { ...tx.result(), purgeCommands: tx.commands(process.argv[1], scopePath), scopePath: resolve(scopePath) };
  }
  const tx = openPrune(rest[0], rest[1], scope);
  if (action === "arm") tx.arm(Number(rest[2]));
  if (action === "record") tx.record(Number(rest[2]), Number(rest[3]));
  if (action === "finish") return tx.finish();
  if (action === "cancel") return tx.cancel();
  return tx.result();
}
