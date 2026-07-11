/**
 * N-1 — push_notify_user is default-closed for the huddle epoch.
 *
 * Proves the tool refuses to push while a huddle is active (defense-in-depth:
 * the agent is idle during a huddle, but ANY unexpected active path — e.g. a
 * mis-gated M-B replay — must not push unscoped agent text out-of-band during
 * the private span). The refusal is LOUD (a visible tool result), not silent.
 */
import { describe, it, expect, vi } from "vitest";
import { registerPushNotifyUserTool } from "../push-notify-user-tool.js";

/** Capture the tool the bridge would register. */
function registerAndCapture(isHuddleActive?: () => boolean) {
  let registered: any;
  const pi = { registerTool: (t: any) => { registered = t; } } as any;
  registerPushNotifyUserTool(pi, isHuddleActive);
  return registered;
}

// The module guards against double-registration with a module-level flag; each
// test re-imports fresh via vitest module isolation (resetModules in config) —
// but to be safe we only assert on the FIRST registration's behavior per module.
describe("N-1 push tool — default-closed during a huddle", () => {
  it("refuses to push (loud) when isHuddleActive() is true", async () => {
    const tool = registerAndCapture(() => true);
    expect(tool).toBeDefined();
    const result = await tool.execute("call-1", { title: "done", body: "work complete" }, undefined, undefined, undefined);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("disabled during an active huddle");
    // Crucially: it did NOT attempt the network send (no "sent"/"not reachable").
    expect(text).not.toContain("sent");
  });
});
