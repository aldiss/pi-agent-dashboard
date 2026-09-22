import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LOCK_NAME = ".deployment-mutation.lock";
export const JSON_INPUT_MAX_BYTES = 1024 * 1024;
export const PRESERVATION_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
export type Identity = { path: string; dev: string; ino: string; uid: string; kind: string; mode: string; mtimeNs: string; size: string };
export type FileSnapshot = Identity & { sha256: string };
export type LinkSnapshot = Identity & { link: string; target: string };
export type PreservedSnapshot = Identity & { sha256?: string; linkText?: string };

export function fail(code: string, message: string, exitCode = 1): never {
  throw Object.assign(new Error(`${code}: ${message}`), { code, exitCode });
}

export function identity(path: string): Identity {
  const s = lstatSync(path, { bigint: true });
  return {
    path: resolve(path), dev: String(s.dev), ino: String(s.ino), uid: String(s.uid),
    kind: s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other",
    mode: String(s.mode & 0o7777n), mtimeNs: String(s.mtimeNs), size: String(s.size),
  };
}

export function sameIdentity(actual: Identity, expected: Partial<Identity>): boolean {
  return (["dev", "ino", "uid", "kind", "mode"] as const).every(k => expected[k] === undefined || String(actual[k]) === String(expected[k]));
}

export function assertIdentity(path: string, expected: Partial<Identity>, contents = false): Identity {
  const actual = identity(path);
  if (!sameIdentity(actual, expected) || (contents && ["mtimeNs", "size"].some(k => expected[k as keyof Identity] !== undefined && actual[k as keyof Identity] !== expected[k as keyof Identity]))) {
    fail("IDENTITY_CHANGED", path);
  }
  return actual;
}

export function sha256File(path: string, maximumBytes = Number.MAX_SAFE_INTEGER): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let count: number;
    let total = 0;
    while ((count = readSync(fd, buf, 0, buf.length, null)) !== 0) {
      total += count;
      if (total > maximumBytes) fail("INPUT_TOO_LARGE", path);
      hash.update(buf.subarray(0, count));
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function snapshotFile(path: string, maximumBytes = Number.MAX_SAFE_INTEGER): FileSnapshot {
  const before = identity(path);
  if (before.kind !== "file" || realpathSync(path) !== resolve(path)) fail("UNSAFE_FILE", path);
  if (Number(before.size) > maximumBytes) fail("INPUT_TOO_LARGE", path);
  const sha256 = sha256File(path, Number(before.size));
  assertIdentity(path, before, true);
  return { ...before, sha256 };
}

export function snapshotLink(path: string): LinkSnapshot {
  const before = identity(path);
  if (before.kind !== "symlink") fail("POINTER_NOT_SYMLINK", path);
  const result = { ...before, link: readlinkSync(path), target: realpathSync(path) };
  assertIdentity(path, before, true);
  return result;
}

/** Preservation data nodes, not reference resolution: dangling symlink text remains valid data. */
export function snapshotPreserved(path: string): PreservedSnapshot {
  if (realpathSync(dirname(path)) !== resolve(dirname(path))) fail("PRESERVATION_PARENT_ALIAS", path);
  const before = identity(path);
  if (before.kind === "file") return snapshotFile(path);
  if (before.kind === "directory") return before;
  if (before.kind !== "symlink") fail("PRESERVATION_NODE_TYPE", path);
  const raw = readlinkSync(path, { encoding: "buffer" });
  const linkText = raw.toString("utf8");
  if (!Buffer.from(linkText, "utf8").equals(raw)) fail("PRESERVATION_LINK_ENCODING", path);
  assertIdentity(path, before, true);
  return { ...before, linkText };
}

export function readJson(path: string, maximumBytes = JSON_INPUT_MAX_BYTES): any {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > PRESERVATION_RECEIPT_MAX_BYTES) fail("INPUT_LIMIT", "explicit JSON bound exceeds 4 MiB");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail("UNSAFE_FILE", path);
    if (stat.size > maximumBytes) fail("INPUT_TOO_LARGE", path);
    while (true) {
      const buf = Buffer.alloc(Math.min(64 * 1024, maximumBytes - total + 1));
      const count = readSync(fd, buf, 0, buf.length, null);
      if (!count) break;
      total += count;
      if (total > maximumBytes) fail("INPUT_TOO_LARGE", path);
      chunks.push(buf.subarray(0, count));
    }
  } finally { closeSync(fd); }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
  catch (err) {
    if (err instanceof SyntaxError) fail("UNREADABLE_JSON", path);
    throw err;
  }
}

export function writeExclusiveJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function ownedDirectory(path: string): Identity {
  const id = identity(path);
  if (id.kind !== "directory" || id.uid !== String(process.getuid?.()) || (Number(id.mode) & 0o022) !== 0) fail("UNSAFE_DIRECTORY", path);
  return id;
}

type Owner = { version: 1; purpose: "writer" | "prune" | "activation"; token: string; pid: number; root: Identity; lock: Identity };

export class Fence {
  root: string;
  token: string;
  path: string;
  owner: Owner;
  private ownerFile: FileSnapshot;
  constructor(owner: Owner) {
    this.owner = owner;
    this.root = owner.root.path;
    this.token = owner.token;
    this.path = join(this.root, LOCK_NAME);
    this.ownerFile = snapshotFile(join(this.path, "owner.json"));
  }
  assertHeld(): void {
    try {
      assertIdentity(this.root, this.owner.root);
      assertIdentity(this.path, this.owner.lock);
      const current = snapshotFile(this.ownerFile.path);
      if (!sameIdentity(current, this.ownerFile) || current.sha256 !== this.ownerFile.sha256) throw Error("owner changed");
    } catch { fail("FENCE_OWNER_CHANGED", this.path); }
  }
  release(): void {
    this.assertHeld();
    if (JSON.stringify(readdirSync(this.path).sort()) !== JSON.stringify(["owner.json"])) fail("FENCE_NOT_EMPTY", this.path);
    unlinkSync(this.ownerFile.path);
    rmdirSync(this.path);
  }
}

export function acquireFence(inputRoot: string, purpose: Owner["purpose"], createRoot = false): Fence {
  if (createRoot) mkdirSync(inputRoot, { recursive: true });
  const root = ownedDirectory(realpathSync(inputRoot));
  const path = join(root.path, LOCK_NAME);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") fail("FENCE_BUSY", path, 73);
    throw err;
  }
  const owner: Owner = { version: 1, purpose, token: randomBytes(24).toString("hex"), pid: process.pid, root, lock: ownedDirectory(path) };
  // A failed/partial owner write leaves an unknown fence. Never steal it.
  writeExclusiveJson(join(path, "owner.json"), owner);
  return new Fence(owner);
}

export function resumeFence(inputRoot: string, token: string, purpose: "prune" | "activation"): Fence {
  const root = ownedDirectory(realpathSync(inputRoot));
  const lock = ownedDirectory(join(root.path, LOCK_NAME));
  const owner = readJson(join(lock.path, "owner.json")) as Owner;
  if (owner.version !== 1 || owner.purpose !== purpose || owner.token !== token || !/^[0-9a-f]{48}$/.test(token) || owner.root?.path !== root.path || !sameIdentity(root, owner.root) || !sameIdentity(lock, owner.lock)) {
    fail("FENCE_OWNER_CHANGED", lock.path);
  }
  return new Fence(owner);
}

export function withDeploymentFence<T>(root: string, action: (fence: Fence) => T): T {
  const fence = acquireFence(root, "writer", true);
  try { return action(fence); }
  finally { fence.release(); }
}
