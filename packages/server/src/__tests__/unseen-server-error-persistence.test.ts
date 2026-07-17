import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeSessionMeta,
  readSessionMeta,
  type SessionMeta,
} from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";

/**
 * Persistence round-trip for `SessionMeta.unseenServerError`.
 * Sister to `unread-persistence.test.ts`. Guarantees the acceptance chain:
 * error → persist → server restart (scanner restore reads .meta.json) →
 * still flagged. See change: build-2-dashboard-v3.
 */
describe("unseenServerError persistence", () => {
  it("round-trips unseenServerError=true through .meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unseen-error-meta-"));
    const sessionFile = path.join(dir, "session-1.jsonl");
    fs.writeFileSync(sessionFile, "");

    const meta: SessionMeta = {
      source: "tui",
      cwd: "/tmp",
      status: "idle",
      unseenServerError: true,
    };
    writeSessionMeta(sessionFile, meta);

    const restored = readSessionMeta(sessionFile);
    expect(restored?.unseenServerError).toBe(true);
  });

  it("round-trips unseenServerError=false through .meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unseen-error-meta-"));
    const sessionFile = path.join(dir, "session-2.jsonl");
    fs.writeFileSync(sessionFile, "");

    writeSessionMeta(sessionFile, { source: "tui", unseenServerError: false });
    const restored = readSessionMeta(sessionFile);
    expect(restored?.unseenServerError).toBe(false);
  });

  it("absent unseenServerError field is undefined on read (back-compat)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unseen-error-meta-"));
    const sessionFile = path.join(dir, "session-3.jsonl");
    fs.writeFileSync(sessionFile, "");
    fs.writeFileSync(
      path.join(dir, "session-3.meta.json"),
      JSON.stringify({ source: "tui", cwd: "/tmp" }),
    );

    const restored = readSessionMeta(sessionFile);
    expect(restored?.unseenServerError).toBeUndefined();
  });
});
