import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPiSession, setResolver, resetResolver } from "../process-manager.js";
import { execSync, spawnSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { spawnDetached } from "@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js";

vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/exec.js")>();
  return { ...actual, execSync: vi.fn(() => ""), spawnSync: vi.fn(() => ({ status: 0 })) };
});
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js")>();
  return { ...actual, spawnDetached: vi.fn(async () => ({ ok: true, pid: 12345 })) };
});

describe("process manager cwd backstop", () => {
  let dir: string;
  let root: string;
  let outside: string;
  const which = vi.fn(() => "/mock/tool");
  const resolvePi = vi.fn(() => ["/mock/pi"]);
  const buildSpawnEnv = vi.fn((env: NodeJS.ProcessEnv) => ({ ...env }));

  beforeEach(() => {
    vi.clearAllMocks();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "spawn-cwd-policy-")));
    root = join(dir, "root");
    outside = join(dir, "outside");
    mkdirSync(root); mkdirSync(outside);
    setResolver({ which, resolvePi, buildSpawnEnv } as never);
  });
  afterEach(() => {
    resetResolver();
    rmSync(dir, { recursive: true, force: true });
  });

  function expectNoProcessWork() {
    expect(which).not.toHaveBeenCalled();
    expect(resolvePi).not.toHaveBeenCalled();
    expect(buildSpawnEnv).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  }

  it("missing, string, malformed and empty-root policies fail before hooks or mechanism probes", async () => {
    const preSpawnHook = vi.fn(() => root);
    for (const policy of [undefined, null, "preValidated", true, {}, { preValidated: "true" }, { preValidated: false }, { preValidated: true }, { permittedRoots: [] }]) {
      const result = await spawnPiSession(root, { preSpawnHook }, policy as never);
      expect(result).toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
      expect(preSpawnHook).not.toHaveBeenCalled();
      expectNoProcessWork();
    }
  });

  it("an initially outside directory cannot run a hook which would move it inside", async () => {
    const preSpawnHook = vi.fn(() => root);
    expect(await spawnPiSession(outside, { preSpawnHook }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expect(preSpawnHook).not.toHaveBeenCalled();
    expectNoProcessWork();
  });

  it("an initial symlink escape fails before hooks", async () => {
    const alias = join(root, "escape");
    symlinkSync(outside, alias, "dir");
    const preSpawnHook = vi.fn(() => root);
    expect(await spawnPiSession(alias, { preSpawnHook }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expect(preSpawnHook).not.toHaveBeenCalled();
    expectNoProcessWork();
  });

  it("an allowed hook can select another contained canonical directory", async () => {
    const target = join(root, "child");
    const alias = join(dir, "alias");
    mkdirSync(target); symlinkSync(root, alias, "dir");
    const preSpawnHook = vi.fn(() => target);
    const result = await spawnPiSession(alias, { strategy: "headless", preSpawnHook }, { permittedRoots: [root] });
    expect(result).toMatchObject({ success: true, cwd: target });
    expect(preSpawnHook).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
    expect(spawnDetached).toHaveBeenCalledWith(expect.objectContaining({ cwd: target }));
  });

  it("a hook-returned outside directory fails before mechanism probes or spawn", async () => {
    const preSpawnHook = vi.fn(() => outside);
    expect(await spawnPiSession(root, { preSpawnHook }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expect(preSpawnHook).toHaveBeenCalledOnce();
    expectNoProcessWork();
  });

  it("a hook-returned symlink escape fails after canonical re-resolution", async () => {
    const alias = join(root, "escape");
    symlinkSync(outside, alias, "dir");
    expect(await spawnPiSession(root, { preSpawnHook: () => alias }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expectNoProcessWork();
  });

  it("a hook cannot swap the authorized directory for an outside symlink", async () => {
    const target = join(root, "target");
    mkdirSync(target);
    const preSpawnHook = () => {
      rmSync(target, { recursive: true });
      symlinkSync(outside, target, "dir");
      return target;
    };
    expect(await spawnPiSession(target, { preSpawnHook }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expectNoProcessWork();
  });

  it("a legacy preValidated flag cannot bypass explicit roots", async () => {
    const alias = join(dir, "alias");
    symlinkSync(outside, alias, "dir");
    const result = await spawnPiSession(alias, { strategy: "headless" }, { permittedRoots: [root], preValidated: true } as never);
    expect(result).toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expectNoProcessWork();
  });

  it("explicit roots never skip file/relative-path directory validation", async () => {
    const file = join(dir, "file");
    writeFileSync(file, "not a directory");
    for (const cwd of [file, "."]) {
      const preSpawnHook = vi.fn(() => root);
      expect(await spawnPiSession(cwd, { preSpawnHook }, { permittedRoots: [root] }))
        .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
      expect(preSpawnHook).not.toHaveBeenCalled();
      expectNoProcessWork();
    }
  });

  it("explicit roots recheck hook-returned paths as directories", async () => {
    const file = join(dir, "file");
    writeFileSync(file, "not a directory");
    expect(await spawnPiSession(root, { preSpawnHook: () => file }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "CWD_NOT_PERMITTED" });
    expectNoProcessWork();
  });

  it("missing directories retain DIR_MISSING without letting a hook repair unauthorized inputs", async () => {
    const missing = join(root, "missing");
    const preSpawnHook = vi.fn(() => root);
    expect(await spawnPiSession(missing, { preSpawnHook }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "DIR_MISSING" });
    expect(preSpawnHook).not.toHaveBeenCalled();
    expect(await spawnPiSession(root, { preSpawnHook: () => missing }, { permittedRoots: [root] }))
      .toMatchObject({ success: false, code: "DIR_MISSING" });
    expectNoProcessWork();
  });
});
