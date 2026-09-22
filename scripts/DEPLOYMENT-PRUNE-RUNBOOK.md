# Bounded deployment fence and exact manual prune

Supervisor-only production actions. Worker implements/tests; LoadMap activates and performs guarded deletion.
No automatic selection, timer, retention policy, package install, runtime restart, or immutable-release patch.

## Supported writer and runtime exception

Operational deployment entrypoint:
`/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard/scripts/deploy.mjs`.
Brief names this target. `~/bin/stage3-wedge-monitor:155` also directs operator rollback through it.
Branches: `--ref` materialization/rebuild and unconditional promotion, `--ref --restart`, `--rollback` with/without `--restart`, `--register-bridge-only`.
Existing build/promotion behavior stays intact. `--restart` still only prints the supervised service-step instruction.

All branches acquire `<canonical-prod-root>/.deployment-mutation.lock` before release, pointer, or deployment-pin mutation.
Root aliases share the same fence. Unknown/stale owners and interrupted operations never auto-clear.
Ownership is rechecked around external build commands and before subsequent mutations.

Retained `deploy.mjs` files are not supported operational callers merely because they exist.
No configured caller of those copies was found in the bounded invocation checks.
Do not introduce a new unfenced caller during this transaction.

Loaded `com.pi-dashboard.server` launches current's retained CLI through `gateway-log-wrap.sh`.
Its startup registration remains unchanged under a bounded non-interference exception:

- Current/previous, process PID/start/command/cwd, relevant retained source, package inventory, manifests and path identities stay pinned.
- Bundled extension exists under the executing kept source root, so resolver fallback is not needed.
- Every discoverable bridge remains inside the kept cwd; escaping/absolute-outside/symlink paths fail closed.
- No selected candidate has a pin or live/retention reference at admission.
- Runtime registration adds only those kept targets; existing equal pins return and conflicting plugin pins do not change.
- Mutable deployment/pointer/deployment-pin writers participate in the fence.

Observed kept root: `8c02c1acfa39ded63e2967687395895469932b10`; 15 package entries, 13 package manifests, one bridge (`flows-anthropic-bridge`).
Observation is not fresh candidate clearance. LoadMap must seal/check actual inputs again under the activated fence.
Any settings snapshot change still aborts verification, even when the change might be benign.

## Tooling-only activation

Do not run these commands from the implementation worker. No production activation has been performed by this build.
Commands below require LoadMap's checks and ordinary command authorization.

```sh
WT=/Users/vdrobkov/.pi-workspaces/dashboard-prune-tooling-20260921-32ae4f85
MAIN=/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard
PROD=/Users/vdrobkov/.pi-dashboard-prod
TOOL="$MAIN/scripts/deploy.mjs"
PRUNE_SCOPE=/Users/vdrobkov/.pi/orchestration-state/nos-cells/load-map/v1/release-prune-20260920-e66e0718/SCOPE.json
BACKUP="$WT/.tooling-activation-backup-32ae4f85"
node --version
GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 /opt/homebrew/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$MAIN" rev-parse HEAD
shasum -a 256 "$TOOL" "$PROD/releases/8c02c1acfa39ded63e2967687395895469932b10/scripts/deploy.mjs"
```

Require Node v22.22.2 and base `8fec696ce6eef00f1bfe366620f5fb87809bf38a`.
Require mutable old SHA-256 `934bdd3658b1a980a106a486f453ba2853cd5a1b49b23a65fa1c441f55ddb898`.
Require retained SHA-256 `52a885a7e72750be9ecfa6669d613d22d197ad29f36a78d25eae56ccf2398d9c`.
Any mismatch stops activation; no checkout, staging, or user-work overwrite.

Acquire an explicitly owned activation fence using the tested worktree entrypoint:

```sh
node "$WT/scripts/deploy.mjs" --deployment-fence claim "$PROD"
```

Save returned token as `ACTIVATION_TOKEN`. Existing fences cause exit 73; do not remove or steal them.
Old code does not yet respect this fence: this step alone is NOT activation.

Install helpers first, then atomically publish the mutable entrypoint last. Fail on any pre-existing destination, including dangling symlinks, except the hash-verified old entrypoint.

```sh
mkdir "$BACKUP"
cp -p "$TOOL" "$BACKUP/deploy.mjs"
for file in deployment-fence.ts manual-prune.ts prune-safety.ts; do
  test ! -e "$MAIN/scripts/$file" && test ! -L "$MAIN/scripts/$file" || exit 1
  cp -p "$WT/scripts/$file" "$MAIN/scripts/$file" || exit "$?"
  cmp "$WT/scripts/$file" "$MAIN/scripts/$file" || exit "$?"
done
test ! -e "$MAIN/scripts/deploy.mjs.prune-32ae4f85.tmp" && test ! -L "$MAIN/scripts/deploy.mjs.prune-32ae4f85.tmp" || exit 1
cp -p "$WT/scripts/deploy.mjs" "$MAIN/scripts/deploy.mjs.prune-32ae4f85.tmp"
cmp "$TOOL" "$BACKUP/deploy.mjs"
mv "$MAIN/scripts/deploy.mjs.prune-32ae4f85.tmp" "$TOOL"
cmp "$WT/scripts/deploy.mjs" "$TOOL"
```

Run the block with `set -e` (or stop manually on every nonzero exit). Do not continue after a copy/hash/compare failure.
Atomic entrypoint replacement routes future supported invocations into the shared fence without touching retained code or the service.

While activation fence remains held, inspect actual legacy deployment processes after publication:

```sh
set -o pipefail
/bin/ps -axo pid=,ppid=,lstart=,command= | awk '/[s]cripts\/deploy[.]mjs/ { print }'
```

This query is evidence to inspect, not automatic clearance. Include relative invocations and known aliases of the supported target; distinguish the observer itself.
Any pre-publication writer or uncertain descendant stops admission. Let it finish normally, then recheck; no kill, service stop, or global freeze.
Absence becomes useful only AFTER new invocations have been routed through the installed fence.
Recheck installed four-file hashes and retained-source hash. Confirm a new supported writer is refused with `FENCE_BUSY` before any effect; do not run an unguarded deploy as a probe.

Save a small activation receipt after that check:

```ts
{
  version: 1,
  scopeSha256: "5812f4aa64e9238b727e3b0b7d46a40e73af2685a85117d2c453b76c0323820e",
  publishedAt: "<actual ISO timestamp>",
  verifiedAt: "<actual later ISO timestamp>",
  legacyWritersDrained: true,
  nativeExit: 0,
  legacyWriterPids: [],
  files: [
    { path: "<MAIN>/scripts/deploy.mjs", sha256: "<installed digest>" },
    { path: "<MAIN>/scripts/deployment-fence.ts", sha256: "<installed digest>" },
    { path: "<MAIN>/scripts/manual-prune.ts", sha256: "<installed digest>" },
    { path: "<MAIN>/scripts/prune-safety.ts", sha256: "<installed digest>" }
  ]
}
```

Do not set the drain assertion before evidence supports it. Prune checks the actual installed paths/bytes against this tested bundle, not only this assertion.

```sh
node "$TOOL" --deployment-fence release "$PROD" "$ACTIVATION_TOKEN"
```

## Exact sealed manifest

`Manifest` and `Scope` types live in `prune-safety.ts`; full private example lives in `manual-prune.test.ts#fixture`.
Helpers `identity`, `snapshotFile`, `snapshotLink`, `snapshotPreserved`, `captureRuntimeInputs`, `captureProcess` read inputs only.
No helper selects candidates or supplies reference/preservation clearance.

LoadMap assembles these fields from fresh authorized facts:

| Field | Required value |
| --- | --- |
| `version`, `scopeSha256`, `validUntil` | `1`, fixed scope digest above, explicit supervisor validity deadline. |
| `prodRoot`, `releases` | Full canonical directory identities from `identity`. Same device required for staging. |
| `selected` | Explicit exact batch from the fixed ten-root scope; no discovered addition/substitution. Each saved device/inode/owner/type/mtime must match. |
| `kept` | Current, previous, running, pinned, unique-state and other protected release-root identities. |
| `current`, `previous` | `snapshotLink` with link identity, literal target and resolved kept root. |
| `settings` | Exact `snapshotFile` of pin-bearing settings. Payload never goes into result output. |
| `references`, `factFiles` | Known live/retention identities and immutable evidence snapshots supporting complete census. No original-session/auth payload copies. |
| `activation` | `entrypoint`, ordered three `helpers`, and `receipt`, all `snapshotFile` results from actual installed tooling and post-publication drain receipt. |
| `preservation` | One `{root: selectedPath, receipt: snapshotFile(receiptPath)}` per selected root. |
| `runtimes` | `{process: captureProcess(pid), sourceRoot: keptRoot, inputs: captureRuntimeInputs(keptRoot, keptCwd)}` for every relevant known runtime. |
| `assertions` | True only after proof: `referenceCensusComplete`, `noCandidateReaders`, `noCandidatePins`, `preservationComplete`, `supportedWritersActivated`, `runtimeInputsPinned`. |

Seal manifest bytes with SHA-256. Do not edit or regenerate manifest/evidence while a transaction exists.
Scope, manifest, journal and ordinary config JSON stay bounded to 1 MiB.
Unknown relative/glob/local package-reference shapes and unresolved pins fail closed; no config rewriting workaround is authorized.

## Exact compact preservation receipt

Preferred complete-tree representation, exported as `CompactPreservationReceipt`:

```ts
type Identity = {
  path: string; // canonical absolute path; headers only in compact form
  dev: string; ino: string; uid: string;
  kind: "directory" | "file" | "symlink";
  mode: string; // decimal string of stat.mode & 0o7777, e.g. "493" for 0755
  mtimeNs: string; size: string; // decimal strings
};
type NodeMetadata = Omit<Identity, "path"> & {
  sha256?: string;  // REQUIRED for regular files: 64 lowercase hex characters
  linkText?: string; // REQUIRED for symlinks: exact UTF-8 readlink text, never followed
};
type Receipt = {
  encoding: "root-relative-v1";
  root: Identity;     // exact selected source-root identity
  copyRoot: Identity; // canonical real directory, outside every selected root
  noUnpreservedState: true;
  nonDependencyDisposition: "preserved";
  preserved: Array<{
    relativePath: string; // canonical root-relative path; "." allowed for root
    source: NodeMetadata;
    copy: NodeMetadata;
  }>;
};
```

Every node keeps separate complete source/copy device, inode, owner, kind, mode, mtime and size metadata.
Files additionally retain both hashes. Symlinks retain both literal link texts, including dangling/absolute targets as data.
Directories retain modes and identities; directory/link rows must not be omitted to fit the bound.
Root header and validated copy-root header cover root metadata; a `relativePath: "."` row is also supported.

Construct rows from existing complete, authorized metadata; this transformation performs no new discovery or copy:

```ts
const omitPath = ({ path, ...metadata }) => metadata;
const receipt = {
  encoding: "root-relative-v1",
  root: sourceRootIdentity,
  copyRoot: copyRootIdentity,
  noUnpreservedState: true, // only after complete non-dependency preservation proof
  nonDependencyDisposition: "preserved",
  preserved: expandedRecords.map(row => ({
    relativePath: row.relativePath,
    source: omitPath(row.source),
    copy: omitPath(row.copy)
  }))
};
const bytes = JSON.stringify(receipt); // minified; no dropped records
```

Before omitting paths, require each original source path to equal `resolve(root.path, relativePath)` and each copy path to equal `resolve(copyRoot.path, relativePath)`.
Verifier reconstructs both canonical paths internally, then runs existing identity/content/mode/link checks.
Optional explicit per-row `path` is accepted only if exactly equal to that derived canonical path; inconsistent paths fail.
Absolute/escaping paths, `./`/`..` aliases, duplicates, malformed identities, symlink ancestors and changed copy roots fail closed.
Metadata key order does not matter. Receipt file bytes themselves remain SHA-256 sealed.

Receipt cap stays **4 MiB (4,194,304 bytes)**. No caller may raise it. Ten receipts consume at most 40 MiB, within existing 64 MiB evidence envelope with 16 MiB closing reserve; account for other evidence too.
6,500-node real private fixture: 400 directories including root, 5,000 files, 1,100 links; 5,288,386 bytes expanded, 2,911,098 compact; all 6,500 verified.
Fixture includes excluded `node_modules` data; no dependency copy/recreation required.

Expanded per-node `source`/`copy` snapshots remain supported for smaller receipts.
`nonDependencyDisposition: "no-unique-data"` with an empty `preserved` array requires an actual complete prior assessment; never use it to evade receipt size or incomplete preservation.
Proof covers bytes, node kind, modes, link text, and held identities. It does not claim ACL/xattr/hard-link-graph fidelity. Unrepresentable link text or special nodes fail closed, never silently disappear.
Protected original sessions, credentials, recovery originals and live/private state stay protected; copying them does not authorize their deletion.

## Stage, guarded purge, finish

Only LoadMap runs production mutations. `stage` is a real mutation, not a dry-run.

```sh
node "$TOOL" --manual-prune stage "$PRUNE_SCOPE" "$MANIFEST" "$MANIFEST_SHA256"
```

Stage acquires the same fence, verifies sealed facts, then moves only selected identities into exact transaction paths.
Save returned transaction token as `PRUNE_TOKEN` and retain the complete JSON result.
On pre-purge validation/move failure, staged roots restore automatically where original paths remain vacant.
Observed replacements are not overwritten; conflicts retain surviving staged roots and fence.

Result emits exact `purgeCommands`, one per root. Inspect each complete command, then submit it unchanged through Pi's normal destructive-command guard, one invocation at a time.
Do not hide/eval the deletion through another interpreter or API. Guard refusal stops deletion; no alternate spelling/API retry.
Each command verifies/arms its exact root, executes visible `rm -rf -- <exact-staged-root>`, records native exit, and returns native rm failure or record failure.
This implementation contains no release-payload deletion API.

```sh
node "$TOOL" --manual-prune finish "$PRUNE_SCOPE" "$PROD" "$PRUNE_TOKEN"
```

Finish requires every armed deletion recorded successful, originals/staged roots absent, and protected facts still valid. It removes only empty staging/fence metadata.
Results report exact before/actions/after identities, native failures and protected checks. Directory stat sizes are not allocated-byte or physical-reclaim estimates.

## Recovery and tooling rollback

Before any `arm`, cancellation performs checked, reversible restoration:

```sh
node "$TOOL" --manual-prune cancel "$PRUNE_SCOPE" "$PROD" "$PRUNE_TOKEN"
```

After any `arm`, external deletion may have partially run. No automatic restore is claimed, even if a shell result was lost.
Native failure or changed facts after irreversible work leaves honest partial state and a held fence. Inspect only:

```sh
node "$TOOL" --manual-prune status "$PRUNE_SCOPE" "$PROD" "$PRUNE_TOKEN"
```

Do not remove stale/unknown fences or operation markers. Unexpected same-UID/manual mutations require stopping; cooperative exclusion is not filesystem privilege isolation.
Restoration uses an exclusive absent-destination reservation and identity recheck; it does not replace an observed newly created path.

Do not roll tooling back while any prune is staged, armed, partial, or unresolved. Once all roots resolve and no prune remains, acquire an activation fence, verify backup's original hash, and atomically restore the backed-up `deploy.mjs` through a fresh same-directory temporary.
Verify restored old hash, then release only that activation token using the worktree tool. Leave helper files/evidence in place; no unrelated cleanup.
Restoring old entrypoint disables this pruning contract: old code ignores the fence. Invalidate activation receipt and do not run another prune until tooling is activated again.
No Git writes, service restart, retained-code edits, pointer changes or settings changes belong to tooling activation/rollback.
