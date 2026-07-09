/**
 * Surface B #4b — free-for-all is preserved (verify, don't build).
 *
 * B adds NO send-lock, NO turn-taking gate, NO model arbitration. The existing
 * server-serialized many-to-many gateway is the concurrency model. This is a
 * "nothing was added" structural pin: the send-path handler
 * (`session-action-handler.ts`) must not have grown any turn-taking/lock
 * construct, and the presence tracker must be observational only (no gate API).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createSessionPresenceTracker } from "../session-presence-tracker.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

describe("Surface B #4b — free-for-all preserved (no send-lock / turn-taking)", () => {
  it("the send-path handler adds no turn-taking/lock construct", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../browser-handlers/session-action-handler.ts"),
      "utf8",
    );
    // No turn-taking / send-lock / arbitration vocabulary in the send path.
    expect(src).not.toMatch(/turnLock|turn_lock|sendLock|send_lock|takeTurn|turnTaking/);
    expect(src).not.toMatch(/acquireLock|releaseLock|arbitrat/i);
  });

  it("the presence tracker is OBSERVATIONAL only — it exposes no gate/allow API", () => {
    const t = createSessionPresenceTracker() as unknown as Record<string, unknown>;
    // The tracker's surface is enter/leave/removeSocket/humansOf/humanCount —
    // NO canSend / allow / gate / lock method that could arbitrate turns.
    for (const forbidden of ["canSend", "allow", "gate", "lock", "acquire", "takeTurn"]) {
      expect(typeof t[forbidden]).toBe("undefined");
    }
  });
});
