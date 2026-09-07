import { describe, expect, it, vi } from "vitest";
import { createCommandHandler } from "../command-handler.js";

/**
 * `/new [runtime]` at the bridge seam.
 *
 * The bridge EXECUTES what the shared parser classified: it forwards a runtime
 * REQUEST for a recognized runtime, and refuses an unrecognized one loudly
 * without ever reaching the spawn seam.
 */

function createMockPi() {
  return { sendUserMessage: vi.fn(), exec: vi.fn(), events: undefined };
}

describe("/new runtime at the bridge seam", () => {
  it("ACCEPTANCE 4 — a bare /new still spawns pi", async () => {
    const spawnNew = vi.fn();
    const handler = createCommandHandler(createMockPi() as never, "s1", { spawnNew, eventSink: vi.fn() });

    await handler.handle({ type: "send_prompt", sessionId: "s1", text: "/new" });

    expect(spawnNew).toHaveBeenCalledExactlyOnceWith("pi");
  });

  it("forwards a codex request", async () => {
    const spawnNew = vi.fn();
    const eventSink = vi.fn();
    const handler = createCommandHandler(createMockPi() as never, "s1", { spawnNew, eventSink });

    await handler.handle({ type: "send_prompt", sessionId: "s1", text: "/new codex" });

    expect(spawnNew).toHaveBeenCalledExactlyOnceWith("codex");
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        data: expect.objectContaining({ command: "/new codex", status: "completed" }),
      }),
    }));
  });

  it("ACCEPTANCE 5 — an unknown runtime is refused visibly and never spawns", async () => {
    const pi = createMockPi();
    const spawnNew = vi.fn();
    const eventSink = vi.fn();
    const handler = createCommandHandler(pi as never, "s1", { spawnNew, eventSink });

    await handler.handle({ type: "send_prompt", sessionId: "s1", text: "/new bogus" });

    expect(spawnNew).not.toHaveBeenCalled();
    // Not leaked to the model as a prompt either.
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({
      type: "event_forward",
      event: expect.objectContaining({
        eventType: "command_feedback",
        data: expect.objectContaining({
          command: "/new bogus",
          status: "error",
          message: 'Unknown runtime "bogus". Use /new, /new pi, or /new codex.',
        }),
      }),
    }));
  });

  it("does not crash when /new codex arrives with no spawn callback wired", async () => {
    const pi = createMockPi();
    const handler = createCommandHandler(pi as never, "s1");

    await handler.handle({ type: "send_prompt", sessionId: "s1", text: "/new codex" });

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
