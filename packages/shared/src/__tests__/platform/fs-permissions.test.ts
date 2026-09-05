import { describe, expect, it } from "vitest";
import { isPrivateFileMode } from "../../platform/fs-permissions.js";

describe.each(["darwin", "linux"] as const)("private file modes on %s", (platform) => {
  it.each([0o000, 0o400, 0o600, 0o700, 0o100600])("accepts owner-only mode %i", (mode) => {
    expect(isPrivateFileMode(mode, platform)).toBe(true);
  });

  it.each([0o010, 0o020, 0o040, 0o001, 0o002, 0o004, 0o644])("rejects group or other permission bit in %i", (mode) => {
    expect(isPrivateFileMode(mode, platform)).toBe(false);
  });
});

describe("Windows file modes", () => {
  it.each([0o600, 0o644, 0o777])("does not interpret mode %i as an ACL privacy decision", (mode) => {
    expect(isPrivateFileMode(mode, "win32")).toBe(true);
  });
});
