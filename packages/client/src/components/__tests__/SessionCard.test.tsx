import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { SessionCard } from "../SessionCard.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

vi.mock("../../lib/api-context.js", () => ({
  getApiBase: () => "",
}));

afterEach(() => cleanup());

function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "test-session",
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

const defaultProps = {
  selectedId: undefined,
  onSelect: () => {},
  now: Date.now(),
  isHidden: false,
  onHide: () => {},
  onUnhide: () => {},
};

describe("SessionCard", () => {
  it("should render session name or fallback to cwd", () => {
    const session = makeSession({ name: "My Session" });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("My Session")).toBeTruthy();
  });

  it("should show active status indicator", () => {
    const session = makeSession({ status: "active" });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const statusDot = container.querySelector(".bg-green-500");
    expect(statusDot).toBeTruthy();
  });

  it("should highlight when selected", () => {
    const session = makeSession();
    const { container } = render(
      <SessionCard session={session} {...defaultProps} selectedId="test-session" />
    );
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("border-blue-500/60");
    expect(card.className).toContain("backdrop-blur-sm");
  });

  it("should call onSelect when clicked", () => {
    const onSelect = vi.fn();
    const session = makeSession();
    const { container } = render(
      <SessionCard session={session} {...defaultProps} onSelect={onSelect} />
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("test-session");
  });

  it("should NOT show cost when 0", () => {
    const session = makeSession({ cost: 0 });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("should show cost when > 0", () => {
    const session = makeSession({ cost: 0.42 });
    render(<SessionCard session={session} {...defaultProps} />);
    const costs = screen.getAllByText("$0.42");
    expect(costs.length).toBeGreaterThan(0);
  });

  it("should show ended status for ended sessions", () => {
    const session = makeSession({ status: "ended" });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const statusDot = container.querySelector(".bg-\\[var\\(--bg-surface\\)\\]");
    expect(statusDot).toBeTruthy();
  });

  it("should show Check-liveness button when session is alive and onCheckLiveness provided (build-2 fix #4)", () => {
    const onCheckLiveness = vi.fn();
    const session = makeSession({ status: "active" });
    render(
      <SessionCard session={session} {...defaultProps} onCheckLiveness={onCheckLiveness} />
    );
    expect(screen.queryByTestId("session-check-liveness-btn")).toBeTruthy();
  });

  it("Check-liveness is read-only: clicking calls onCheckLiveness, never a shutdown/exit", () => {
    const onCheckLiveness = vi.fn();
    const session = makeSession({ status: "streaming" });
    render(
      <SessionCard session={session} {...defaultProps} onCheckLiveness={onCheckLiveness} />
    );
    // No confirm prompt, no destructive control.
    fireEvent.click(screen.getByTestId("session-check-liveness-btn"));
    expect(onCheckLiveness).toHaveBeenCalledWith("test-session");
    expect(screen.queryByTestId("session-close-btn")).toBeNull();
  });

  it("renders a mobile-only Check-liveness affordance on alive cards (build-2 fix #12, 393px)", () => {
    const onCheckLiveness = vi.fn();
    const session = makeSession({ status: "active" });
    render(<SessionCard session={session} {...defaultProps} onCheckLiveness={onCheckLiveness} />);
    // The mobile affordance exists so the 393px card has a reachable liveness
    // re-check (desktop uses the hover cluster). jsdom renders both; the md:
    // breakpoint hides the desktop cluster / this pill by viewport at runtime.
    const mobileBtn = screen.getByTestId("session-check-liveness-btn-mobile");
    fireEvent.click(mobileBtn);
    expect(onCheckLiveness).toHaveBeenCalledWith("test-session");
  });

  it("shows an Open control on alive cards and never a destructive Exit (kill-0 hole closed)", () => {
    const onSelect = vi.fn();
    const session = makeSession({ status: "active" });
    render(<SessionCard session={session} {...defaultProps} onSelect={onSelect} />);
    const openBtn = screen.getByTestId("session-open-btn");
    fireEvent.click(openBtn);
    expect(onSelect).toHaveBeenCalledWith("test-session");
    // The removed destructive control must not exist on any card.
    expect(screen.queryByTestId("session-close-btn")).toBeNull();
  });

  it("should apply streaming pulse background when streaming", () => {
    const session = makeSession({ status: "streaming" });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("bg-yellow-500/5");
    expect(card.className).toContain("animate-pulse");
  });

  it("should apply streaming pulse when resuming", () => {
    const session = makeSession({ status: "idle", resuming: true });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("bg-yellow-500/5");
  });

  it("should apply ask_user pulse when currentTool is ask_user", () => {
    const session = makeSession({ status: "streaming", currentTool: "ask_user" });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("bg-purple-500/5");
  });

  it("should tint background when unread and idle", () => {
    const session = makeSession({ status: "idle", unread: true });
    const { container } = render(<SessionCard session={session} {...defaultProps} />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain("bg-cyan-500/5");
  });

  it("should show meta chips for git branch", () => {
    const session = makeSession({ gitBranch: "feature/x" });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("feature/x")).toBeTruthy();
  });

  it("should show meta chips for git branch with PR number", () => {
    const session = makeSession({ gitBranch: "feature/x", gitPrNumber: 42 });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("feature/x · #42")).toBeTruthy();
  });

  it("should show meta chips for worktree", () => {
    const session = makeSession({ worktree: { path: "/tmp/shadow/x", branch: "shadow/x" } });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("shadow/x")).toBeTruthy();
  });

  it("should show meta chips for attached proposal", () => {
    const session = makeSession({ attachedProposal: "add-auth" });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("add-auth")).toBeTruthy();
  });

  it("should render all meta chips in one row", () => {
    const session = makeSession({
      gitBranch: "feature/x",
      gitPrNumber: 42,
      worktree: { path: "/tmp/shadow/x", branch: "shadow/x" },
      attachedProposal: "add-auth",
    });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("feature/x · #42")).toBeTruthy();
    expect(screen.getByText("shadow/x")).toBeTruthy();
    expect(screen.getByText("add-auth")).toBeTruthy();
  });

  it("should render OpenSpec badge when phase or change is set", () => {
    const session = makeSession({ openspecPhase: "apply", openspecChange: "feat-x" });
    render(<SessionCard session={session} {...defaultProps} />);
    // OpenSpecActivityBadge renders the change name
    expect(screen.getByText(/feat-x/)).toBeTruthy();
  });

  it("should NOT render OpenSpec badge when no phase or change", () => {
    const session = makeSession();
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.queryByText(/openspec/i)).toBeNull();
  });

  it("should show Resume/Fork buttons for ended sessions with sessionFile", () => {
    const onResume = vi.fn();
    const session = makeSession({ status: "ended", sessionFile: "/path/to/session.jsonl" });
    render(<SessionCard session={session} {...defaultProps} onResume={onResume} />);
    expect(screen.getByText("Resume")).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
  });

  it("should show hide/unhide buttons", () => {
    const onHide = vi.fn();
    const onUnhide = vi.fn();
    const session = makeSession();
    render(<SessionCard session={session} {...defaultProps} onHide={onHide} onUnhide={onUnhide} />);
    expect(screen.getByTestId("session-hide-btn")).toBeTruthy();
  });

  it("should NOT show Open/Check-liveness controls when session is ended", () => {
    const session = makeSession({ status: "ended" });
    render(<SessionCard session={session} {...defaultProps} onCheckLiveness={() => {}} />);
    expect(screen.queryByTestId("session-check-liveness-btn")).toBeNull();
    expect(screen.queryByTestId("session-open-btn")).toBeNull();
    // The removed destructive control never exists either.
    expect(screen.queryByTestId("session-close-btn")).toBeNull();
  });

  it("should show model when present", () => {
    const session = makeSession({ model: "claude-sonnet-4" });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("claude-sonnet-4")).toBeTruthy();
  });

  it("should show model with thinking level", () => {
    const session = makeSession({ model: "claude-sonnet-4", thinkingLevel: "high" });
    render(<SessionCard session={session} {...defaultProps} />);
    expect(screen.getByText("claude-sonnet-4 (high)")).toBeTruthy();
  });
});
