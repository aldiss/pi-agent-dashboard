/**
 * DashboardPage component test — renders the dedicated `/dashboard`
 * route page and asserts that `<ActiveOperatorSurfaces />` is mounted
 * inside it.
 *
 * Operator ratification 2026-05-26 ~00:40 CEST (defaults 1a + 2a + 3a):
 * v1 dashboard hosts Active Surfaces ONLY. This test pins that the
 * page's primary content is the surfaces tile; future widgets bank as
 * Section E candidates.
 *
 * Sister-shape to SessionList.test.tsx mount pattern (wouter memory
 * Router + ThemeProvider + jsdom matchMedia stub) + ChatView-thinking-
 * filter.test.tsx jsdom-stubs preamble.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { DashboardPage } from "../DashboardPage.js";
import { ThemeProvider } from "../ThemeProvider.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  // ActiveOperatorSurfaces polls /api/operator-active-surfaces on mount.
  // Stub fetch to return an empty surfaces list so the component renders
  // its frame without network calls.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          schema_version: "1.0",
          updated_at: null,
          surfaces: [],
        },
      }),
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function TestRouter({ children }: { children: React.ReactNode }) {
  const { hook } = memoryLocation({ path: "/dashboard", static: true });
  return <Router hook={hook}>{children}</Router>;
}

describe("DashboardPage", () => {
  it("renders the dashboard heading", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <DashboardPage />
        </ThemeProvider>
      </TestRouter>,
    );
    expect(screen.getByText(/Dashboard/i)).toBeTruthy();
  });

  it("hosts the ActiveOperatorSurfaces tile", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <DashboardPage />
        </ThemeProvider>
      </TestRouter>,
    );
    // ActiveOperatorSurfaces exposes data-testid="active-operator-surfaces".
    const tile = screen.getByTestId("active-operator-surfaces");
    expect(tile).toBeTruthy();
  });

  it("uses data-testid=\"dashboard-page\" as the page root", () => {
    render(
      <TestRouter>
        <ThemeProvider>
          <DashboardPage />
        </ThemeProvider>
      </TestRouter>,
    );
    const root = screen.getByTestId("dashboard-page");
    expect(root).toBeTruthy();
    // Surfaces tile lives inside the page root.
    const tile = screen.getByTestId("active-operator-surfaces");
    expect(root.contains(tile)).toBe(true);
  });
});
