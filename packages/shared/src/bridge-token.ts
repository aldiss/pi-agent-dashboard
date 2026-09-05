import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isPrivateFileMode } from "./platform/fs-permissions.js";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function tokenPath(): string {
  return path.join(os.homedir(), ".pi", "dashboard", "bridge-token");
}

/** Read a private, well-formed token without creating or repairing files. */
export function readBridgeToken(file: string = tokenPath()): string | null {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65) return null;
    if (!isPrivateFileMode(stat.mode)) return null;
    const token = fs.readFileSync(fd, "utf8").trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Publish a complete token atomically; concurrent creators reuse the winner. */
export function ensureBridgeToken(file: string = tokenPath()): string {
  const existing = readBridgeToken(file);
  if (existing) return existing;
  try {
    fs.lstatSync(file);
    const published = readBridgeToken(file);
    if (published) return published;
    throw new Error("Bridge token file is invalid or unreadable");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, token + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const published = readBridgeToken(file);
    if (!published) throw new Error("Bridge token file is invalid or unreadable");
    return published;
  } finally {
    fs.unlinkSync(temporary);
  }
}

export function verifyBridgeToken(presented: string | null, expected: string | null): boolean {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (!TOKEN_PATTERN.test(presented) || !TOKEN_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
}
