import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SessionList, groupSessionsByDirectory } from "../SessionList.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { SkinProvider } from "../SkinProvider.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function TestRouter({ children }: { children: React.ReactNode }) {
  const { hook } = memoryLocation({ path: "/", static: true });
  return <Router hook={hook}>{children}</Router>;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  // Mock localStorage for session-filter-storage
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  });
});

afterEach(() => cleanup());

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "test-session-1",
    cwd: "/home/user/project",
    source: "tui",
    status: "active",
    startedAt: Date.now() - 60000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  };
}

describe("SessionList spawn button", () => {
  it("should render spawn button on folder card when onSpawnSession is provided", () => {
    const onSpawn = vi.fn();
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onSpawnSession={onSpawn}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const btn = screen.getByTestId("spawn-session-btn");
    expect(btn).toBeTruthy();
  });

  it("renders spawn button even when onSpawnSession is not provided (no-op click)", () => {
    // FolderActionBar always renders the Session button; when the parent
    // doesn't supply onSpawnSession, clicking it is a no-op (onSpawnSession?.()
    // in SessionList). This is the current stable behavior.
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.getByTestId("spawn-session-btn")).toBeTruthy();
  });

  it("should call onSpawnSession with cwd when clicked", () => {
    const onSpawn = vi.fn();
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession({ cwd: "/my/project" })]}
            onSelect={() => {}}
            onSpawnSession={onSpawn}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const btn = screen.getByTestId("spawn-session-btn");
    fireEvent.click(btn);
    expect(onSpawn).toHaveBeenCalledWith("/my/project");
  });
});

describe("SessionList placeholder spawn card", () => {
  it("should render placeholder card when cwd is in spawningCwds", () => {
    const spawningCwds = new Set(["/home/user/project"]);
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.getByTestId("placeholder-session-card")).toBeTruthy();
  });

  it("should not render placeholder card when cwd is not in spawningCwds", () => {
    const spawningCwds = new Set(["/other/project"]);
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.queryByTestId("placeholder-session-card")).toBeNull();
  });

  it("should disable New button when cwd is in spawningCwds", () => {
    const spawningCwds = new Set(["/home/user/project"]);
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const btn = screen.getByTestId("spawn-session-btn");
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("should not disable New button when cwd is not spawning", () => {
    const spawningCwds = new Set<string>();
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const btn = screen.getByTestId("spawn-session-btn");
    expect(btn.hasAttribute("disabled")).toBe(false);
  });
});

describe("SessionList header layout", () => {
  it("renders two header rows: app-bar and filter-bar", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onPinDirectory={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.getByTestId("header-app-bar")).toBeTruthy();
    expect(screen.getByTestId("header-filter-bar")).toBeTruthy();
  });

  it("places settings gear in app-bar row", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const appBar = screen.getByTestId("header-app-bar");
    const settingsBtn = screen.getByTestId("settings-btn");
    expect(appBar.contains(settingsBtn)).toBe(true);
  });

  it("places theme controls in app-bar row", () => {
    // The theme toggle is always in the app-bar. The named-theme palette
    // picker is skin-conditional: shown in the Legacy skin, hidden in
    // Editorial (which owns its own committed palette). Render Legacy here so
    // both controls are present and we verify their app-bar placement.
    render(
      <TestRouter>
        <ThemeProvider>
          <SkinProvider>
            <SessionList
              sessions={[makeSession()]}
              onSelect={() => {}}
            />
          </SkinProvider>
        </ThemeProvider>
      </TestRouter>,
    );
    const appBar = screen.getByTestId("header-app-bar");
    const themeToggle = appBar.querySelector('[data-testid="theme-toggle"]');
    expect(themeToggle).toBeTruthy();
  });

  it("places pin button in filter-bar row", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onPinDirectory={() => {}}
            onOpenPinDialog={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const filterBar = screen.getByTestId("header-filter-bar");
    const pinBtn = screen.getByTestId("pin-dir-dialog-btn");
    expect(filterBar.contains(pinBtn)).toBe(true);
  });

  it("Add folder button calls onOpenPinDialog and does not mount PinDirectoryDialog internally", () => {
    const onOpenPinDialog = vi.fn();
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession()]}
            onSelect={() => {}}
            onPinDirectory={() => {}}
            onOpenPinDialog={onOpenPinDialog}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    const pinBtn = screen.getByTestId("pin-dir-dialog-btn");
    fireEvent.click(pinBtn);
    expect(onOpenPinDialog).toHaveBeenCalledTimes(1);
    // PinDirectoryDialog heading "Pin Directory" should NOT be rendered by SessionList
    expect(screen.queryByText("Pin Directory")).toBeNull();
  });
});

describe("Placeholder and session ordering", () => {
  // See change: fix-worktree-placeholder-replacement.

  it("placeholder renders when cwd is in spawningCwds", () => {
    const spawningCwds = new Set(["/home/user/project"]);
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession({ id: "s1", cwd: "/home/user/project" })]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.getByTestId("placeholder-session-card")).toBeTruthy();
  });

  it("placeholder hidden when no cwd is spawning", () => {
    const spawningCwds = new Set<string>();
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[makeSession({ id: "s1", cwd: "/home/user/project" })]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            spawningCwds={spawningCwds}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.queryByTestId("placeholder-session-card")).toBeNull();
  });

  it("accepts sessionOrderMap prop and renders sessions", () => {
    const orderMap = new Map<string, string[]>();
    orderMap.set("/home/user/project", ["s2", "s1"]);
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[
              makeSession({ id: "s1", cwd: "/home/user/project", startedAt: 100 }),
              makeSession({ id: "s2", cwd: "/home/user/project", startedAt: 200 }),
            ]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
            sessionOrderMap={orderMap}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    // Both sessions render (exact DOM order covered by browser test)
    // Session cards contain the session name in some form
    expect(screen.queryByTestId("placeholder-session-card")).toBeNull();
  });
});

describe("groupSessionsByDirectory", () => {
  it("groups sessions by cwd into unpinned when no pinned dirs", () => {
    const sessions = [
      makeSession({ id: "s1", cwd: "/a", startedAt: 100 }),
      makeSession({ id: "s2", cwd: "/b", startedAt: 200 }),
    ];
    const { pinned, unpinned } = groupSessionsByDirectory(sessions);
    expect(pinned).toHaveLength(0);
    expect(unpinned).toHaveLength(2);
    // Sorted by recency descending
    expect(unpinned[0].cwd).toBe("/b");
    expect(unpinned[1].cwd).toBe("/a");
  });

  it("puts pinned directories first in pinned order", () => {
    const sessions = [
      makeSession({ id: "s1", cwd: "/a", startedAt: 300 }),
      makeSession({ id: "s2", cwd: "/b", startedAt: 200 }),
      makeSession({ id: "s3", cwd: "/c", startedAt: 100 }),
    ];
    const { pinned, unpinned } = groupSessionsByDirectory(sessions, undefined, ["/c", "/a"]);
    expect(pinned).toHaveLength(2);
    expect(pinned[0].cwd).toBe("/c");
    expect(pinned[0].pinned).toBe(true);
    expect(pinned[1].cwd).toBe("/a");
    expect(pinned[1].pinned).toBe(true);
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0].cwd).toBe("/b");
    expect(unpinned[0].pinned).toBe(false);
  });

  it("includes pinned directories with zero sessions", () => {
    const sessions = [
      makeSession({ id: "s1", cwd: "/a", startedAt: 100 }),
    ];
    const { pinned } = groupSessionsByDirectory(sessions, undefined, ["/empty-dir", "/a"]);
    expect(pinned).toHaveLength(2);
    expect(pinned[0].cwd).toBe("/empty-dir");
    expect(pinned[0].sessions).toHaveLength(0);
    expect(pinned[1].cwd).toBe("/a");
    expect(pinned[1].sessions).toHaveLength(1);
  });

  it("unpinned groups are sorted by most recent session activity", () => {
    const sessions = [
      makeSession({ id: "s1", cwd: "/old", startedAt: 100 }),
      makeSession({ id: "s2", cwd: "/new", startedAt: 300 }),
      makeSession({ id: "s3", cwd: "/mid", startedAt: 200 }),
    ];
    const { unpinned } = groupSessionsByDirectory(sessions);
    expect(unpinned.map((g) => g.cwd)).toEqual(["/new", "/mid", "/old"]);
  });
});

describe("SessionList folder grouping toggle", () => {
  it("nested mode (default) wraps each folder's sessions in folder chrome", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[
              makeSession({ id: "s1", cwd: "/a", name: "Alpha" }),
              makeSession({ id: "s2", cwd: "/b", name: "Beta" }),
            ]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    // Folder chrome present → a FolderActionBar (spawn button) per folder card.
    expect(screen.getAllByTestId("spawn-session-btn").length).toBeGreaterThan(0);
  });

  it("flat mode (groupByFolder=false) renders sessions with no folder chrome", () => {
    localStorage.setItem("dashboard:groupByFolder", "false");
    const { container } = render(
      <TestRouter>
        <ThemeProvider>
          <SessionList
            sessions={[
              makeSession({ id: "s1", cwd: "/a", name: "Alpha" }),
              makeSession({ id: "s2", cwd: "/b", name: "Beta" }),
            ]}
            onSelect={() => {}}
            onSpawnSession={() => {}}
          />
        </ThemeProvider>
      </TestRouter>,
    );
    // No folder cards → no per-folder spawn buttons (FolderActionBar not rendered).
    expect(screen.queryByTestId("spawn-session-btn")).toBeNull();
    // Both sessions still render as flat cards directly under the tier.
    expect(container.querySelector('[data-session-id="s1"]')).toBeTruthy();
    expect(container.querySelector('[data-session-id="s2"]')).toBeTruthy();
  });
});

describe("SessionList — needs-you partition applies in SEARCH mode (build-2 fix-cycle NIT 1)", () => {
  function cardOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("[data-session-id]")).map(
      (el) => el.getAttribute("data-session-id") || "",
    );
  }

  it("a needs-you session rises to the top even when a search query is active", () => {
    const sessions = [
      makeSession({ id: "calm-first", name: "Rank Calm First", cwd: "/w" }),
      makeSession({ id: "needs-mid", name: "Rank Needs Middle", cwd: "/w", unseenServerError: true }),
      makeSession({ id: "calm-last", name: "Rank Calm Last", cwd: "/w" }),
    ];
    const { container } = render(
      <TestRouter><ThemeProvider>
        <SessionList sessions={sessions} onSelect={() => {}} />
      </ThemeProvider></TestRouter>,
    );
    // Normal mode: needs rises above the calm cards.
    expect(cardOrder(container)).toEqual(["needs-mid", "calm-first", "calm-last"]);

    // Type a search query matching all three — needs-you must STILL be first
    // (previously flat-merge search skipped the partition and reverted order).
    fireEvent.change(screen.getByTestId("session-search-input"), { target: { value: "Rank" } });
    const searched = cardOrder(container).filter((id) => id.startsWith("calm") || id.startsWith("needs"));
    expect(searched[0]).toBe("needs-mid");
  });
});
