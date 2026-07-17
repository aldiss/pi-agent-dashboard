import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LandingPage } from "../LandingPage.js";

function TestRouter({ children, path = "/" }: { children: React.ReactNode; path?: string }) {
  const { hook } = memoryLocation({ path, static: true });
  return <Router hook={hook}>{children}</Router>;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

function renderPage(props: Partial<React.ComponentProps<typeof LandingPage>> = {}) {
  const navigate = vi.fn();
  const onOpenPinDialog = vi.fn();
  const onSpawnSession = vi.fn();
  const defaults: React.ComponentProps<typeof LandingPage> = {
    providersReady: false,
    pinnedCount: 0,
    sessionsCount: 0,
    firstPinnedCwd: null,
    onOpenPinDialog,
    onSpawnSession,
    navigate,
  };
  const merged = { ...defaults, ...props };
  render(
    <TestRouter>
      <LandingPage {...merged} />
    </TestRouter>,
  );
  return { navigate: merged.navigate, onOpenPinDialog: merged.onOpenPinDialog, onSpawnSession: merged.onSpawnSession };
}

describe("LandingPage onboarding", () => {
  describe("calm-zero suppressed on unsettled load (build-2 fix-cycle-2 MAJOR 1)", () => {
    it("hasLoadedOnce=false + zero sessions → shows loading, NOT the Welcome checklist", () => {
      renderPage({ providersReady: true, sessionsCount: 0, hasLoadedOnce: false });
      expect(screen.getByTestId("landing-loading")).toBeTruthy();
      expect(screen.queryByText("Welcome to pi-dashboard")).toBeNull();
    });

    it("hasLoadedOnce=true + zero sessions → onboarding checklist shown (truthful empty)", () => {
      renderPage({ providersReady: true, sessionsCount: 0, hasLoadedOnce: true });
      expect(screen.queryByTestId("landing-loading")).toBeNull();
    });
  });

  describe("alive-only active count (build-2 fix-cycle MAJOR 3)", () => {
    it("renders the passed alive count as '1 active session' (singular)", () => {
      renderPage({ providersReady: true, pinnedCount: 1, sessionsCount: 1 });
      expect(screen.getByText("1 active session")).toBeTruthy();
    });

    it("renders '2 active sessions' when two are alive (plural)", () => {
      renderPage({ providersReady: true, pinnedCount: 1, sessionsCount: 2 });
      expect(screen.getByText("2 active sessions")).toBeTruthy();
    });

    it("zero alive → step 3 is the Start-session CTA, not a done row", () => {
      renderPage({ providersReady: true, pinnedCount: 1, sessionsCount: 0, hasLoadedOnce: true });
      // No "0 active sessions" done row; the spawn CTA is present instead.
      expect(screen.queryByText(/active session/)).toBeNull();
      expect(screen.getByTestId("onboarding-step-3-cta")).toBeTruthy();
    });
  });


  describe("Step 1: credentials", () => {
    it("pending state shows CTA that navigates to /settings?tab=providers", () => {
      const { navigate } = renderPage({ providersReady: false });
      const btn = screen.getByTestId("onboarding-step-1-cta");
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(btn);
      expect(navigate).toHaveBeenCalledWith("/settings?tab=providers");
    });

    it("done state collapses to checkmark row", () => {
      renderPage({ providersReady: true });
      expect(screen.getByTestId("onboarding-step-1-done")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-step-1-cta")).toBeNull();
    });
  });

  describe("Step 2: add folder", () => {
    it("locked when providersReady=false", () => {
      renderPage({ providersReady: false, pinnedCount: 0 });
      const btn = screen.getByTestId("onboarding-step-2-cta") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toMatch(/credential/i);
    });

    it("pending when providersReady && pinnedCount===0; CTA calls onOpenPinDialog", () => {
      const { onOpenPinDialog } = renderPage({ providersReady: true, pinnedCount: 0 });
      const btn = screen.getByTestId("onboarding-step-2-cta") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      fireEvent.click(btn);
      expect(onOpenPinDialog).toHaveBeenCalledTimes(1);
    });

    it("done state when pinnedCount>0", () => {
      renderPage({ providersReady: true, pinnedCount: 2 });
      expect(screen.getByTestId("onboarding-step-2-done")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-step-2-cta")).toBeNull();
    });
  });

  describe("Step 3: start session", () => {
    it("locked when no folder pinned", () => {
      renderPage({ providersReady: true, pinnedCount: 0, firstPinnedCwd: null });
      const btn = screen.getByTestId("onboarding-step-3-cta") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toMatch(/folder/i);
    });

    it("pending when pinnedCount>0 && sessionsCount===0; CTA calls onSpawnSession(firstPinnedCwd)", () => {
      const { onSpawnSession } = renderPage({
        providersReady: true,
        pinnedCount: 1,
        sessionsCount: 0,
        firstPinnedCwd: "/home/user/repo",
      });
      const btn = screen.getByTestId("onboarding-step-3-cta") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      fireEvent.click(btn);
      expect(onSpawnSession).toHaveBeenCalledWith("/home/user/repo");
    });

    it("done state when sessionsCount>0", () => {
      renderPage({ providersReady: true, pinnedCount: 1, firstPinnedCwd: "/x", sessionsCount: 3 });
      expect(screen.getByTestId("onboarding-step-3-done")).toBeTruthy();
      expect(screen.queryByTestId("onboarding-step-3-cta")).toBeNull();
    });
  });

  it("renders all three done rows and no CTAs when fully configured", () => {
    renderPage({
      providersReady: true,
      pinnedCount: 3,
      sessionsCount: 2,
      firstPinnedCwd: "/x",
    });
    expect(screen.getByTestId("onboarding-step-1-done")).toBeTruthy();
    expect(screen.getByTestId("onboarding-step-2-done")).toBeTruthy();
    expect(screen.getByTestId("onboarding-step-3-done")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-step-1-cta")).toBeNull();
    expect(screen.queryByTestId("onboarding-step-2-cta")).toBeNull();
    expect(screen.queryByTestId("onboarding-step-3-cta")).toBeNull();
  });

  it("renders pi glyph header", () => {
    renderPage();
    expect(screen.getByText("π")).toBeTruthy();
  });
});
