import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePermittedRoots, isContained, resolveSpawnCwd } from "../spawn-cwd.js";

describe("spawn cwd evidence", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "spawn-cwd-"))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("resolves directories, rejects files/missing/relative/non-string paths", () => {
    const file = join(dir, "file");
    writeFileSync(file, "test");
    expect(resolveSpawnCwd(dir)).toEqual({ ok: true, realPath: dir });
    expect(resolveSpawnCwd(file)).toMatchObject({ ok: false, problem: "not-a-directory" });
    expect(resolveSpawnCwd(join(dir, "missing"))).toMatchObject({ ok: false });
    expect(resolveSpawnCwd(".")).toMatchObject({ ok: false });
    expect(resolveSpawnCwd(null as any)).toMatchObject({ ok: false });
  });
  it("rejects symlink escapes and path-prefix siblings after realpath resolution", () => {
    const root = join(dir, "root");
    const outside = join(dir, "root-other");
    mkdirSync(root); mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"), "dir");
    const resolved = resolveSpawnCwd(join(root, "escape"));
    expect(resolved).toEqual({ ok: true, realPath: outside });
    expect(isContained(outside, [root])).toBe(false);
    expect(isContained(root, [root])).toBe(true);
    expect(isContained(join(root, "child"), [root])).toBe(true);
    expect(isContained(root, [])).toBe(false);
  });
  it("canonicalizes, deduplicates, and excludes unusable configured roots", () => {
    const link = join(dir, "link");
    const root = join(dir, "root");
    mkdirSync(root); symlinkSync(root, link, "dir");
    expect(computePermittedRoots({ pinnedDirectories: [link], knownSessionCwds: [root, join(dir, "missing")] })).toEqual([root]);
  });
});
