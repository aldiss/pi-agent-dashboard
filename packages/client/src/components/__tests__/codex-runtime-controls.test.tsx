import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { FolderActionBar } from "../FolderActionBar.js";
import { CommandInput } from "../CommandInput.js";
import { StatusBar } from "../StatusBar.js";
import { SessionCard } from "../SessionCard.js";
import { SessionHeader } from "../SessionHeader.js";
import { MobileActionMenu } from "../MobileActionMenu.js";
import { createInitialState } from "../../lib/event-reducer.js";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../../hooks/useMobile.js", () => ({ useMobile: () => mobile.value }));
vi.mock("../../lib/api-context.js", () => ({ getApiBase: () => "" }));
vi.mock("../../utils/platform.js", async (original) => ({
  ...await original<typeof import("../../utils/platform.js")>(),
  shouldUseMobileComposer: () => mobile.value,
  isCapacitorNative: () => false,
}));

beforeEach(() => { mobile.value = false; });
afterEach(() => cleanup());

function session(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return { id: "codex-session", cwd: "/project", source: "dashboard", status: "ended", startedAt: 1, runtime: "codex", codexThreadId: "thread-1", ...overrides };
}

function folder(onSpawnSession = vi.fn()) {
  return render(<FolderActionBar cwd="/project" terminalCount={0} nativeEditors={[]} onSpawnSession={onSpawnSession} onOpenTerminals={vi.fn()} onOpenEditor={vi.fn()} onOpenNativeEditor={vi.fn()} onOpenPiResources={vi.fn()} />);
}

describe("runtime launch choice", () => {
  it("defaults to pi and preserves the existing no-argument launch callback", () => {
    const spawn = vi.fn();
    folder(spawn);
    expect((screen.getByRole("combobox", { name: "Session runtime" }) as HTMLSelectElement).value).toBe("pi");
    fireEvent.click(screen.getByTestId("spawn-session-btn"));
    expect(spawn).toHaveBeenCalledExactlyOnceWith();
  });

  it("launches the chosen Codex runtime with an explicit server opt-in hint", () => {
    const spawn = vi.fn();
    folder(spawn);
    const selector = screen.getByRole("combobox", { name: "Session runtime" });
    expect(selector.getAttribute("title")).toContain("runtimes.codex.enabled");
    fireEvent.change(selector, { target: { value: "codex" } });
    fireEvent.click(screen.getByTestId("spawn-session-btn"));
    expect(spawn).toHaveBeenCalledExactlyOnceWith("codex");
  });
});

describe("Codex composer", () => {
  it("hides pi slash suggestions while pi retains its builtins", () => {
    const { container, rerender } = render(<CommandInput runtime="codex" commands={[]} onSend={vi.fn()} />);
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "/" } });
    expect(screen.queryByText("/new")).toBeNull();
    expect(screen.queryByText("/compact")).toBeNull();
    rerender(<CommandInput commands={[]} onSend={vi.fn()} />);
    expect(screen.getByText("/new")).toBeTruthy();
  });

  it("allows a queued follow-up without hiding Stop", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const { container } = render(<CommandInput runtime="codex" commands={[]} sessionStatus="streaming" draft="next turn" onSend={onSend} onAbort={onAbort} />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(false);
    expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter" }); });
    expect(onSend).toHaveBeenCalledWith("next turn", undefined);
    fireEvent.click(screen.getByTestId("stop-button"));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("keeps pi send-while-streaming queue entry available", async () => {
    const onSend = vi.fn();
    const { container } = render(<CommandInput commands={[]} sessionStatus="streaming" draft="follow-up" onSend={onSend} />);
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByTestId("send-button")); });
    expect(onSend).toHaveBeenCalledWith("follow-up", undefined);
  });

  it("preserves image payloads for an idle Codex turn", async () => {
    const onSend = vi.fn();
    const images = [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }];
    render(<CommandInput runtime="codex" commands={[]} sessionStatus="idle" draft="describe" images={images} onImagesChange={vi.fn()} onSend={onSend} />);
    await act(async () => { fireEvent.click(screen.getByTestId("send-button")); });
    expect(onSend).toHaveBeenCalledWith("describe", images);
  });

  it("keeps Stop and queue submission usable in the mobile composer during a Codex turn", () => {
    mobile.value = true;
    const abort = vi.fn();
    render(<CommandInput runtime="codex" commands={[]} sessionStatus="streaming" draft="next" onSend={vi.fn()} onAbort={abort} />);
    expect((screen.getByTestId("mobile-composer-send") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("mobile-composer-stop"));
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("Codex session controls", () => {
  it("shows a readonly model instead of pi model, thinking and role controls", () => {
    render(<StatusBar runtime="codex" model="codex-model" status="streaming" onSelectModel={vi.fn()} onSelectThinkingLevel={vi.fn()} onRoleSet={vi.fn()} />);
    expect(screen.getByText("codex-model")).toBeTruthy();
    expect(screen.queryByTestId("model-selector-button")).toBeNull();
    expect(screen.queryByTestId("thinking-level-button")).toBeNull();
    expect(screen.getByTestId("working-status")).toBeTruthy();
  });

  it("shows a Codex card badge and Resume without requiring a pi sessionFile; Fork stays hidden", () => {
    const resume = vi.fn();
    render(<SessionCard session={session()} onSelect={vi.fn()} now={2} isHidden={false} onHide={vi.fn()} onUnhide={vi.fn()} onResume={resume} />);
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Resume session"));
    expect(resume).toHaveBeenCalledExactlyOnceWith("codex-session", "continue");
    expect(screen.queryByTitle("Fork session")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("resumes from the desktop header by native thread id without exposing Fork", () => {
    const resume = vi.fn();
    render(<SessionHeader session={session()} state={createInitialState()} onResume={resume} />);
    fireEvent.click(screen.getByTestId("header-resume-button"));
    expect(resume).toHaveBeenCalledExactlyOnceWith("continue");
    expect(screen.queryByTestId("header-fork-button")).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("keeps mobile Codex model metadata readonly", () => {
    mobile.value = true;
    render(<SessionHeader session={session({ model: "codex-model" })} state={createInitialState()} mobileActions={{ onOpenModelSheet: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Switch model and reasoning" })).toBeNull();
    expect(screen.getByText("codex-model")).toBeTruthy();
  });

  it.each([false, true])("hides an open header flow dialog when switching to Codex (launch=%s)", (launch) => {
    const state = createInitialState();
    const flows = [{ name: "example", description: "Example flow", taskRequired: true }];
    const onSendPrompt = vi.fn();
    const { rerender } = render(<SessionHeader session={session({ id: "pi-session", runtime: "pi", status: "idle" })} state={state} flows={flows} onSendPrompt={onSendPrompt} />);
    fireEvent.click(screen.getByTitle("Run a flow"));
    if (launch) fireEvent.click(screen.getByText("example", { exact: true }));
    const title = launch ? "Run Flow: example" : "Run Flow";
    expect(screen.getByText(title, { exact: true })).toBeTruthy();
    rerender(<SessionHeader session={session({ status: "idle" })} state={state} flows={flows} onSendPrompt={onSendPrompt} />);
    expect(screen.queryByText(title, { exact: true })).toBeNull();
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it("offers mobile Resume but no Fork or pi prompt-template commands", () => {
    const resume = vi.fn();
    render(<MobileActionMenu session={session()} onResume={resume} onSendPrompt={vi.fn()} />);
    fireEvent.click(screen.getByTestId("mobile-kebab-btn"));
    fireEvent.click(screen.getByText("Resume"));
    expect(resume).toHaveBeenCalledExactlyOnceWith("continue");
    fireEvent.click(screen.getByTestId("mobile-kebab-btn"));
    expect(screen.queryByText("Fork")).toBeNull();
  });

  it("does not expose pi OpenSpec prompt templates for an active Codex session", () => {
    render(<MobileActionMenu session={session({ status: "idle" })} onSendPrompt={vi.fn()} />);
    fireEvent.click(screen.getByTestId("mobile-kebab-btn"));
    expect(screen.queryByText("Explore")).toBeNull();
    expect(screen.queryByText("+ New Change")).toBeNull();
  });
});
