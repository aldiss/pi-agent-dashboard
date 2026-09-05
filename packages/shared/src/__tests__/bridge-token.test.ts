import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureBridgeToken, readBridgeToken, verifyBridgeToken } from "../bridge-token.js";

describe("bridge token", () => {
  let dir: string;
  let tokenFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-token-"));
    tokenFile = path.join(dir, "dashboard", "bridge-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a missing token without creating a file or directory", () => {
    expect(readBridgeToken(tokenFile)).toBeNull();
    expect(fs.existsSync(path.dirname(tokenFile))).toBe(false);
  });

  it("creates a private token and reuses it across calls", () => {
    const token = ensureBridgeToken(tokenFile);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(readBridgeToken(tokenFile)).toBe(token);
    expect(ensureBridgeToken(tokenFile)).toBe(token);
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(path.dirname(tokenFile))).toEqual(["bridge-token"]);
  });

  it("resolves the default home at call time", () => {
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    const token = ensureBridgeToken();
    expect(readBridgeToken()).toBe(token);
    expect(fs.existsSync(path.join(dir, ".pi", "dashboard", "bridge-token"))).toBe(true);
  });

  it.each(["", "short", "a".repeat(63), "g".repeat(64), "a".repeat(65)])(
    "does not replace malformed token content: %j",
    (content) => {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, content, { mode: 0o600 });
      expect(readBridgeToken(tokenFile)).toBeNull();
      expect(() => ensureBridgeToken(tokenFile)).toThrow(/invalid|unreadable/i);
      expect(fs.readFileSync(tokenFile, "utf8")).toBe(content);
    },
  );

  it("rejects symlinks instead of trusting another file", () => {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const target = path.join(dir, "other-token");
    fs.writeFileSync(target, "a".repeat(64), { mode: 0o600 });
    fs.symlinkSync(target, tokenFile);
    expect(readBridgeToken(tokenFile)).toBeNull();
    expect(() => ensureBridgeToken(tokenFile)).toThrow(/invalid|unreadable/i);
    expect(fs.readlinkSync(tokenFile)).toBe(target);
  });

  it.skipIf(process.platform === "win32")("rejects a token readable by other users", () => {
    ensureBridgeToken(tokenFile);
    fs.chmodSync(tokenFile, 0o644);
    expect(readBridgeToken(tokenFile)).toBeNull();
    expect(() => ensureBridgeToken(tokenFile)).toThrow(/invalid|unreadable/i);
  });

  it("preserves the winner when another process publishes during creation", () => {
    const winner = "b".repeat(64);
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementationOnce((source, target) => {
      fs.writeFileSync(target, winner + "\n", { mode: 0o600, flag: "wx" });
      link(source, target);
    });
    expect(ensureBridgeToken(tokenFile)).toBe(winner);
    expect(readBridgeToken(tokenFile)).toBe(winner);
    expect(fs.readdirSync(path.dirname(tokenFile))).toEqual(["bridge-token"]);
  });

  it("reuses a winner published immediately after the first missing-file read", () => {
    const winner = "c".repeat(64);
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
      fs.writeFileSync(tokenFile, winner, { flag: "wx", mode: 0o600 });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(ensureBridgeToken(tokenFile)).toBe(winner);
  });

  it("removes unpublished temporary token files when flushing fails", () => {
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    expect(() => ensureBridgeToken(tokenFile)).toThrow(/disk full/);
    expect(fs.existsSync(tokenFile)).toBe(false);
    expect(fs.readdirSync(path.dirname(tokenFile))).toEqual([]);
  });

  it("accepts only an exact valid token match", () => {
    const token = "a".repeat(64);
    expect(verifyBridgeToken(token, token)).toBe(true);
    for (const presented of [null, "", "a", "a".repeat(63), "b".repeat(64), "a".repeat(65)]) {
      expect(verifyBridgeToken(presented, token)).toBe(false);
    }
    expect(verifyBridgeToken(null, null)).toBe(false);
    expect(verifyBridgeToken("short", "short")).toBe(false);
    expect(verifyBridgeToken(token, null)).toBe(false);
  });
});
