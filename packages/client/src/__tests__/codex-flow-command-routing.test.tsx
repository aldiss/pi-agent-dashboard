import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import App from "../App.js";

const transport = vi.hoisted(() => {
  let listener: (message: ServerToBrowserMessage) => void = () => {};
  return {
    send: vi.fn(),
    onMessage(callback: typeof listener) { listener = callback; return () => {}; },
    receive(message: ServerToBrowserMessage) { listener(message); },
  };
});
vi.mock("../hooks/useWebSocket.js", () => ({ useWebSocket: () => ({ ...transport, status: "connected" }) }));
vi.mock("../hooks/useMobile.js", () => ({ useMobile: () => false }));
vi.mock("../hooks/useSessionsBootstrap.js", () => ({ useSessionsBootstrap: () => {} }));
vi.mock("../generated/plugin-registry.js", () => ({ PLUGIN_REGISTRY: [] }));
vi.mock("../components/SessionList.js", () => ({ SessionList: () => null }));
vi.mock("../components/ChatView.js", () => ({ ChatView: () => null }));
vi.mock("../components/TerminalsView.js", () => ({ TerminalsView: () => null }));
vi.mock("../components/SettingsPanel.js", () => ({ SettingsPanel: () => null }));
vi.mock("../components/DashboardPage.js", () => ({ DashboardPage: () => null }));

beforeEach(() => {
  localStorage.clear();
  transport.send.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sessions: DashboardSession[] = [
  { id: "pi-session", cwd: "/project", source: "dashboard", status: "idle", startedAt: 1 },
  { id: "codex-session", cwd: "/project", source: "dashboard", runtime: "codex", codexThreadId: "native-thread", status: "idle", startedAt: 1 },
];

async function renderApp(sessionId: string) {
  const location = memoryLocation({ path: `/session/${sessionId}` });
  const view = render(<Router hook={location.hook}><App /></Router>);
  await act(async () => { transport.receive({ type: "sessions_snapshot", sessions, orders: {} }); });
  transport.send.mockClear();
  return { ...view, navigate: location.navigate };
}

async function submit(container: HTMLElement, text: string) {
  fireEvent.change(container.querySelector("textarea")!, { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByTestId("send-button")); });
}

const commands = [
  { text: "/flows", title: "Flows" },
  { text: "/flows:new", title: "Run Flow: flows:new" },
];

describe("App pi flow command routing", () => {
  it.each(commands)("forwards Codex $text to the server guard without opening a pi dialog", async ({ text, title }) => {
    const { container } = await renderApp("codex-session");
    await submit(container, text);
    expect(transport.send).toHaveBeenCalledExactlyOnceWith({
      type: "send_prompt", sessionId: "codex-session", text, images: undefined, queueNonce: expect.any(String),
    });
    expect(screen.queryByText(title, { exact: true })).toBeNull();
  });

  it.each(commands)("keeps pi $text intercepted locally", async ({ text, title }) => {
    const { container } = await renderApp("pi-session");
    await submit(container, text);
    expect(screen.getByText(title, { exact: true })).toBeTruthy();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it.each(commands)("hides an open pi $text dialog when switching to Codex", async ({ text, title }) => {
    const { container, navigate } = await renderApp("pi-session");
    await submit(container, text);
    expect(screen.getByText(title, { exact: true })).toBeTruthy();
    await act(async () => { navigate("/session/codex-session"); });
    expect(screen.queryByText(title, { exact: true })).toBeNull();
  });

  it.each([
    { choices: ["Edit Flow..."], title: "Edit Flow" },
    { choices: ["Edit Flow...", "example"], title: "Run Flow: example" },
    { choices: ["Delete Flow..."], title: "Delete Flow" },
    { choices: ["Delete Flow...", "example"], title: 'Delete flow "example"? This will remove the flow file and any associated agents.' },
    { choices: ["example"], title: "Run Flow: example" },
  ])("hides the pi flow subdialog $title when switching to Codex", async ({ choices, title }) => {
    const { container, navigate } = await renderApp("pi-session");
    await act(async () => {
      transport.receive({ type: "commands_list", sessionId: "pi-session", commands: [
        { name: "flows:edit", description: "Edit flow", source: "extension" },
        { name: "flows:delete", description: "Delete flow", source: "extension" },
      ] });
      transport.receive({ type: "flows_list", sessionId: "pi-session", flows: [{ name: "example", description: "Example flow", taskRequired: true }] });
    });
    await submit(container, "/flows");
    for (const choice of choices) fireEvent.click(screen.getByText(choice, { exact: choice === "example" }));
    expect(screen.getByText(title, { exact: true })).toBeTruthy();
    await act(async () => { navigate("/session/codex-session"); });
    expect(screen.queryByText(title, { exact: true })).toBeNull();
  });
});
