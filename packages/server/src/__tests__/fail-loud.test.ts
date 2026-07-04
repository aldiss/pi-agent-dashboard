/**
 * Fail-loud crash policy (Stage-2 (b)/(c)/S5) — own-hand verification.
 *
 * Proves the Fault-B inversion: the net CRASHES (with teardown first) instead of
 * silently suppressing, honours the exit-code contract (1=crash / 0=intentional),
 * and the crash-budget breaker converts a respawn loop into a clean halt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  failLoudCrash,
  checkCrashBudget,
  pruneCrashLog,
  installFailLoudNet,
  __resetFailLoudForTests,
} from "../fail-loud.js";

let dir: string;
let crashLog: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fail-loud-"));
  crashLog = path.join(dir, "crash-log.jsonl");
  __resetFailLoudForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noopExit = (() => undefined as never);

describe("failLoudCrash — DEGRADE-THEN-CRASH", () => {
  it("runs teardown BEFORE exit, and exits with the given code", async () => {
    const order: string[] = [];
    let code: number | undefined;
    await failLoudCrash(1, "boom", {
      crashLogPath: crashLog,
      teardown: () => {
        order.push("teardown");
      },
      exit: (c: number) => {
        order.push(`exit:${c}`);
        code = c;
        return undefined as never;
      },
    });
    expect(order).toEqual(["teardown", "exit:1"]); // teardown FIRST, then exit
    expect(code).toBe(1);
  });

  it("records a crash to the log for exit(1)", async () => {
    await failLoudCrash(1, "boom-a", { crashLogPath: crashLog, exit: noopExit });
    const lines = fs.readFileSync(crashLog, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).reason).toContain("boom-a");
  });

  it("EXIT-CONTRACT: an intentional exit(0) is NOT recorded as a crash", async () => {
    await failLoudCrash(0, "idle-or-breaker", { crashLogPath: crashLog, exit: noopExit });
    expect(fs.existsSync(crashLog)).toBe(false);
  });

  it("a hanging teardown does not block the crash (time-boxed)", async () => {
    let exited = false;
    await failLoudCrash(1, "slow", {
      crashLogPath: crashLog,
      timeoutMs: 20,
      teardown: () => new Promise<void>(() => {}), // never resolves
      exit: () => {
        exited = true;
        return undefined as never;
      },
    });
    expect(exited).toBe(true);
  });
});

describe("crash-budget breaker (S5)", () => {
  it("TRIPS when >= maxCrashes happened inside the window (the loop-halt)", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) fs.appendFileSync(crashLog, JSON.stringify({ ts: now - i * 1000 }) + "\n");
    const r = checkCrashBudget({ crashLogPath: crashLog, windowMs: 120_000, maxCrashes: 5, now });
    expect(r.tripped).toBe(true);
    expect(r.count).toBe(5);
  });

  it("does NOT trip for a slow drip outside the window (negative control)", () => {
    const now = 1_000_000;
    // 6 crashes, each 60s apart → only ~3 fall inside a 120s window
    for (let i = 0; i < 6; i++) fs.appendFileSync(crashLog, JSON.stringify({ ts: now - i * 60_000 }) + "\n");
    const r = checkCrashBudget({ crashLogPath: crashLog, windowMs: 120_000, maxCrashes: 5, now });
    expect(r.tripped).toBe(false);
  });

  it("no crash log → not tripped", () => {
    const r = checkCrashBudget({ crashLogPath: crashLog, windowMs: 120_000, maxCrashes: 5, now: 1000 });
    expect(r.tripped).toBe(false);
    expect(r.count).toBe(0);
  });

  it("pruneCrashLog drops entries older than keepMs", () => {
    const now = 1_000_000;
    fs.appendFileSync(crashLog, JSON.stringify({ ts: now - 5_000 }) + "\n"); // recent
    fs.appendFileSync(crashLog, JSON.stringify({ ts: now - 999_999 }) + "\n"); // old
    pruneCrashLog({ crashLogPath: crashLog, keepMs: 600_000, now });
    const lines = fs.readFileSync(crashLog, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe("installFailLoudNet — no more silent suppress", () => {
  it("CRASHES (exit 1) on an uncaughtException instead of suppressing it", async () => {
    const savedUncaught = process.listeners("uncaughtException");
    const savedRejection = process.listeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    try {
      let code: number | undefined;
      const logs: string[] = [];
      installFailLoudNet({
        crashLogPath: crashLog,
        exit: (c: number) => {
          code = c;
          return undefined as never;
        },
        log: (m) => logs.push(m),
      });
      process.emit("uncaughtException", new Error("kaboom"));
      await new Promise((r) => setTimeout(r, 40));
      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("uncaughtException");
      // and it is LOUD, not "(suppressed)"
      expect(logs.join("\n")).not.toContain("suppressed");
    } finally {
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      for (const l of savedUncaught) process.on("uncaughtException", l as never);
      for (const l of savedRejection) process.on("unhandledRejection", l as never);
    }
  });
});
