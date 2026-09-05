import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadlessPidRegistry } from "../headless-pid-registry.js";
import { isProcessAlive, killPidWithGroup, killProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";

vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/process.js", () => ({
  isProcessAlive: vi.fn(), killPidWithGroup: vi.fn(), killProcess: vi.fn(),
}));

describe("Codex PID ownership in shared headless registry", () => {
  let dir: string;
  let pidFile: string;
  const alive = new Set<number>();
  beforeEach(() => {
    vi.clearAllMocks(); alive.clear();
    dir = mkdtempSync(join(tmpdir(), "codex-pids-"));
    pidFile = join(dir, "pids.json");
    vi.mocked(isProcessAlive).mockImplementation(pid => alive.has(pid));
    vi.mocked(killPidWithGroup).mockImplementation(pid => { alive.delete(pid); });
    vi.mocked(killProcess).mockImplementation(async pid => { alive.delete(pid); return { ok: true, forced: false }; });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const disk = () => JSON.parse(readFileSync(pidFile, "utf8")).entries;

  it("persists server-supplied runtime metadata while legacy entries retain their shape", () => {
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    const codex = new EventEmitter();
    registry.register(100, "/project", codex as never, undefined, { runtime: "codex" });
    registry.register(200, "/project", new EventEmitter() as never);
    expect(registry.linkByPid("codex-session", 100)).toBe(true);
    expect(disk()).toEqual([
      expect.objectContaining({ pid: 100, runtime: "codex" }),
      { pid: 200, cwd: "/project", spawnedAt: expect.any(String) },
    ]);
    codex.emit("exit");
    expect(registry.getPid("codex-session")).toBeUndefined();
    expect(disk()).toHaveLength(1);
  });

  it("terminates recent lost-stdio Codex orphans and preserves pi reclaim/age rules", async () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(pidFile, JSON.stringify({ entries: [
      { pid: 100, cwd: "/codex", spawnedAt: recent, runtime: "codex" },
      { pid: 200, cwd: "/legacy", spawnedAt: recent },
      { pid: 300, cwd: "/pi", spawnedAt: recent, runtime: "pi" },
      { pid: 400, cwd: "/dead-codex", spawnedAt: recent, runtime: "codex" },
      { pid: 500, cwd: "/old-pi", spawnedAt: old, runtime: "pi" },
    ] }));
    [100, 200, 300, 500].forEach(pid => alive.add(pid));
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    await registry.cleanupOrphans();
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(100, { timeoutMs: 2000 });
    expect(killPidWithGroup).toHaveBeenCalledExactlyOnceWith(500, "SIGTERM");
    expect(registry.size()).toBe(2);
    expect(registry.linkByPid("lost-codex", 100)).toBe(false);
    expect(registry.linkByPid("legacy", 200)).toBe(true);
    expect(disk()).toEqual([
      { pid: 200, cwd: "/legacy", spawnedAt: recent },
      { pid: 300, cwd: "/pi", spawnedAt: recent, runtime: "pi" },
    ]);
  });

  it("retains failed Codex ownership on disk and rejects startup while the old writer remains alive", async () => {
    const entry = { pid: 100, cwd: "/codex", spawnedAt: new Date().toISOString(), runtime: "codex" };
    writeFileSync(pidFile, JSON.stringify({ entries: [entry] }));
    alive.add(100);
    vi.mocked(killProcess).mockResolvedValue({ ok: true, forced: true });
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    await expect(registry.cleanupOrphans()).rejects.toThrow(/Codex.*100/i);
    expect(registry.size()).toBe(0);
    expect(disk()).toEqual([entry]);
  });

  it("Codex orphan cleanup never reclaims a PID merely because its age is unparseable", async () => {
    writeFileSync(pidFile, JSON.stringify({ entries: [{ pid: 100, cwd: "/codex", spawnedAt: "invalid", runtime: "codex" }] }));
    alive.add(100);
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    await registry.cleanupOrphans();
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(100, { timeoutMs: 2000 });
    expect(registry.size()).toBe(0);
    expect(disk()).toEqual([]);
  });

  it("fallback session kill targets a non-detached Codex PID directly and confirms death", async () => {
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    registry.register(100, "/codex", new EventEmitter() as never, undefined, { runtime: "codex" });
    registry.linkByPid("codex", 100); alive.add(100);
    expect(await registry.killBySessionId("codex")).toBe(true);
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(100, { timeoutMs: 2000 });
    expect(killPidWithGroup).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
  });

  it("failed fallback Codex termination does not erase its PID ownership", async () => {
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    registry.register(100, "/codex", new EventEmitter() as never, undefined, { runtime: "codex" });
    registry.linkByPid("codex", 100); alive.add(100);
    vi.mocked(killProcess).mockResolvedValue({ ok: false, forced: false });
    expect(await registry.killBySessionId("codex")).toBe(false);
    expect(registry.getPid("codex")).toBe(100);
    expect(disk()[0]).toMatchObject({ pid: 100, runtime: "codex" });
  });

  it("shutdown signals pi synchronously and awaits direct Codex termination", async () => {
    const registry = createHeadlessPidRegistry({ pidFilePath: pidFile });
    registry.register(100, "/codex", new EventEmitter() as never, undefined, { runtime: "codex" });
    registry.register(200, "/pi", new EventEmitter() as never);
    alive.add(100); alive.add(200);
    let release: (() => void) | undefined;
    vi.mocked(killProcess).mockImplementation(async pid => {
      await new Promise<void>(resolve => { release = resolve; });
      alive.delete(pid);
      return { ok: true, forced: false };
    });
    const stopping = registry.killAll();
    expect(killPidWithGroup).toHaveBeenCalledExactlyOnceWith(200, "SIGTERM");
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(100, { timeoutMs: 2000 });
    expect(registry.size()).toBe(1);
    release!();
    await stopping;
    expect(registry.size()).toBe(0);
  });
});
