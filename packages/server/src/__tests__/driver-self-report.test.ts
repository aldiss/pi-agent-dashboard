/**
 * Driver self-report ingest tests (dl-2620).
 *
 * Proves the READ side own-hand against a temp driver-state dir
 * (DRIVER_STATE_DIR override): sidecar parse + snake→camel map + clamp +
 * staleness guard (session_id mismatch), and the poller's change-diffed
 * apply+broadcast (immediate tick, CC/ended skip, clear-on-removal, stop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  driverStateDir,
  resolveDriverSelfReport,
  startDriverSelfReportPolling,
} from "../driver-self-report.js";

describe("resolveDriverSelfReport (dl-2620 READ side)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drvstate-"));
    process.env.DRIVER_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.DRIVER_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, obj: unknown) =>
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(obj));

  it("driverStateDir honors DRIVER_STATE_DIR override", () => {
    expect(driverStateDir()).toBe(dir);
  });

  it("maps progress (snake→camel) + next_engagement", () => {
    write("Vault", {
      name: "Vault",
      progress: { pct: 50, label: "build", milestones_done: 2, milestones_total: 4 },
      next_engagement: { effort: "back-and-forth", note: "ratify" },
    });
    expect(resolveDriverSelfReport("Vault")).toEqual({
      progress: { pct: 50, label: "build", milestonesDone: 2, milestonesTotal: 4 },
      nextEngagement: { effort: "back-and-forth", note: "ratify" },
    });
  });

  it("progress-only sidecar (no next_engagement) resolves progress alone", () => {
    write("Vault", { progress: { pct: 80 } });
    expect(resolveDriverSelfReport("Vault")).toEqual({ progress: { pct: 80 } });
  });

  it("clamps pct into 0-100 and rounds", () => {
    write("Hi", { progress: { pct: 140 } });
    write("Lo", { progress: { pct: -5 } });
    write("Frac", { progress: { pct: 33.6 } });
    expect(resolveDriverSelfReport("Hi")!.progress!.pct).toBe(100);
    expect(resolveDriverSelfReport("Lo")!.progress!.pct).toBe(0);
    expect(resolveDriverSelfReport("Frac")!.progress!.pct).toBe(34);
  });

  it("drops an invalid effort but keeps valid progress", () => {
    write("Vault", { progress: { pct: 10 }, next_engagement: { effort: "huge" } });
    expect(resolveDriverSelfReport("Vault")).toEqual({ progress: { pct: 10 } });
  });

  it("drops milestones when the fraction is incoherent", () => {
    write("Vault", { progress: { pct: 50, milestones_done: 5, milestones_total: 4 } });
    expect(resolveDriverSelfReport("Vault")).toEqual({ progress: { pct: 50 } });
  });

  it("staleness guard: session_id mismatch → null (prior-tenure sidecar ignored)", () => {
    write("Vault", { session_id: "uuid-old", progress: { pct: 50 } });
    expect(resolveDriverSelfReport("Vault", "uuid-new")).toBeNull();
    // matching id → resolves
    expect(resolveDriverSelfReport("Vault", "uuid-old")).toEqual({ progress: { pct: 50 } });
    // no id given → no guard, resolves
    expect(resolveDriverSelfReport("Vault")).toEqual({ progress: { pct: 50 } });
  });

  it("fail-safe: missing file / malformed JSON / unsafe name / empty → null", () => {
    expect(resolveDriverSelfReport("Nope")).toBeNull();
    writeFileSync(join(dir, "Bad.json"), "{ not json");
    expect(resolveDriverSelfReport("Bad")).toBeNull();
    expect(resolveDriverSelfReport("bad/name")).toBeNull();
    expect(resolveDriverSelfReport(undefined)).toBeNull();
    write("Empty", { name: "Empty" }); // no progress, no next_engagement
    expect(resolveDriverSelfReport("Empty")).toBeNull();
  });

  it("drops an empty label / empty note", () => {
    write("Vault", { progress: { pct: 5, label: "" }, next_engagement: { effort: "short", note: "" } });
    expect(resolveDriverSelfReport("Vault")).toEqual({
      progress: { pct: 5 },
      nextEngagement: { effort: "short" },
    });
  });
});

describe("startDriverSelfReportPolling (dl-2620 refresh)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drvstate-poll-"));
    process.env.DRIVER_STATE_DIR = dir;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DRIVER_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, obj: unknown) =>
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(obj));
  const sess = (over: Partial<DashboardSession>): DashboardSession =>
    ({ id: "id", cwd: "/x", source: "tmux", status: "idle", startedAt: 0, ...over }) as DashboardSession;

  it("immediate tick applies + broadcasts progress for a live driver", () => {
    write("Vault", { session_id: "s1", progress: { pct: 40 }, next_engagement: { effort: "short" } });
    const sessions = [sess({ id: "s1", name: "Vault" })];
    const applyUpdate = vi.fn();
    const broadcast = vi.fn();
    const stop = startDriverSelfReportPolling({
      listSessions: () => sessions,
      resolveName: (s) => s.name,
      applyUpdate,
      broadcast,
    });
    const expected = { progress: { pct: 40 }, nextEngagement: { effort: "short" } };
    expect(applyUpdate).toHaveBeenCalledWith("s1", expected);
    expect(broadcast).toHaveBeenCalledWith("s1", expected);
    stop();
  });

  it("skips claude-code + ended sessions", () => {
    write("Vault", { progress: { pct: 40 } });
    const sessions = [
      sess({ id: "cc", name: "Vault", source: "claude-code" }),
      sess({ id: "done", name: "Vault", status: "ended" }),
    ];
    const broadcast = vi.fn();
    const stop = startDriverSelfReportPolling({
      listSessions: () => sessions,
      resolveName: (s) => s.name,
      applyUpdate: vi.fn(),
      broadcast,
    });
    expect(broadcast).not.toHaveBeenCalled();
    stop();
  });

  it("does not re-broadcast when unchanged, but re-broadcasts on change", () => {
    write("Vault", { progress: { pct: 40 } });
    const sessions = [sess({ id: "s1", name: "Vault" })];
    const broadcast = vi.fn();
    const stop = startDriverSelfReportPolling({
      listSessions: () => sessions,
      resolveName: (s) => s.name,
      applyUpdate: vi.fn(),
      broadcast,
      intervalMs: 1000,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); // unchanged tick
    expect(broadcast).toHaveBeenCalledTimes(1);
    write("Vault", { progress: { pct: 90 } }); // change
    vi.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith("s1", { progress: { pct: 90 }, nextEngagement: null });
    stop();
  });

  it("broadcasts null when the sidecar is removed (cleared)", () => {
    write("Vault", { progress: { pct: 40 } });
    const sessions = [sess({ id: "s1", name: "Vault" })];
    const broadcast = vi.fn();
    const stop = startDriverSelfReportPolling({
      listSessions: () => sessions,
      resolveName: (s) => s.name,
      applyUpdate: vi.fn(),
      broadcast,
      intervalMs: 1000,
    });
    rmSync(join(dir, "Vault.json"));
    vi.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenLastCalledWith("s1", { progress: null, nextEngagement: null });
    stop();
  });

  it("stop() halts further ticks", () => {
    write("Vault", { progress: { pct: 40 } });
    const broadcast = vi.fn();
    const stop = startDriverSelfReportPolling({
      listSessions: () => [sess({ id: "s1", name: "Vault" })],
      resolveName: (s) => s.name,
      applyUpdate: vi.fn(),
      broadcast,
      intervalMs: 1000,
    });
    stop();
    write("Vault", { progress: { pct: 99 } });
    vi.advanceTimersByTime(5000);
    expect(broadcast).toHaveBeenCalledTimes(1); // only the immediate tick
  });
});
