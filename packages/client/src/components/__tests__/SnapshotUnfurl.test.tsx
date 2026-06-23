import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { MarkdownContent } from "../MarkdownContent.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { SessionAssetsProvider } from "../../lib/SessionAssetsContext.js";

/**
 * Snapshot-unfurl card behavior + the brief's explicit zero-regression
 * assertions, exercised through the real `MarkdownContent` → `a` renderer
 * seam. See change: dashboard-link-unfurl.
 */

afterEach(() => cleanup());

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

function renderMd(content: string, assets: Record<string, { data: string; mimeType: string }> = {}) {
  return render(
    <ThemeProvider>
      <SessionAssetsProvider assets={assets}>
        <MarkdownContent content={content} />
      </SessionAssetsProvider>
    </ThemeProvider>,
  );
}

function findLightboxBackdrop(): HTMLElement | null {
  return document.querySelector('[data-testid="lightbox-backdrop"]');
}

// A 1×1 transparent PNG data URL — renders directly without an asset registry,
// so the card is testable in replay-only mode (no live bridge).
const DATA_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("snapshot-unfurl card", () => {
  it("renders a card (not a plain anchor) for external + image-child + snapshot directive", () => {
    const { container } = renderMd(`[![NOS Map](${DATA_PNG})](https://host.example:9090/page 'snapshot')`);
    expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="snapshot-unfurl-title"]')!.textContent).toBe("NOS Map");
    // Domain derived from href host
    expect(container.textContent).toContain("host.example:9090");
  });

  it("shows both buttons: View inline (lightbox) and Open source (external new-tab)", () => {
    const { container } = renderMd(`[![Map](${DATA_PNG})](https://host.example/p 'snapshot')`);
    const viewInline = container.querySelector('[data-testid="snapshot-unfurl-view-inline"]');
    const openSource = container.querySelector('[data-testid="snapshot-unfurl-open-source"]') as HTMLAnchorElement;
    expect(viewInline).not.toBeNull();
    expect(openSource).not.toBeNull();
    // Open source = external new tab, reverse-tabnabbing guard
    expect(openSource.getAttribute("href")).toBe("https://host.example/p");
    expect(openSource.getAttribute("target")).toBe("_blank");
    expect(openSource.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("View inline opens the lightbox INSIDE the dashboard (no new tab)", () => {
    const { container } = renderMd(`[![Map](${DATA_PNG})](https://host.example/p 'snapshot')`);
    expect(findLightboxBackdrop()).toBeNull();
    fireEvent.click(container.querySelector('[data-testid="snapshot-unfurl-view-inline"]')!);
    // Lightbox rendered (annotated backdrop or plain backdrop — either is in-dashboard)
    const backdrop = document.querySelector('[data-testid="lightbox-backdrop"]');
    expect(backdrop).not.toBeNull();
    const modalImg = backdrop!.querySelector("img");
    expect(modalImg!.getAttribute("src")).toBe(DATA_PNG);
  });

  it("clicking the media also opens the lightbox", () => {
    const { container } = renderMd(`[![Map](${DATA_PNG})](https://host.example/p 'snapshot')`);
    fireEvent.click(container.querySelector('[data-testid="snapshot-unfurl-media"]')!);
    expect(document.querySelector('[data-testid="lightbox-backdrop"]')).not.toBeNull();
  });

  it("renders highlight overlays + flag tag when the directive carries highlights", () => {
    const directive = 'snapshot:{"ts":"12:47","highlights":[{"top":57,"left":28,"width":28,"height":7,"label":"the seam"},{"top":82,"left":6,"width":88,"height":12}]}';
    const { container } = renderMd(`[![Map](${DATA_PNG})](https://host.example/p '${directive}')`);
    // Flag tag on the card
    const flag = container.querySelector('[data-testid="snapshot-unfurl-flag"]');
    expect(flag!.textContent).toContain("2 flagged");
    // Open the lightbox and assert overlay regions render
    fireEvent.click(container.querySelector('[data-testid="snapshot-unfurl-view-inline"]')!);
    const highlights = document.querySelectorAll('[data-testid="lightbox-highlight"]');
    expect(highlights.length).toBe(2);
    // The annotated lightbox exposes an open-source link in its bar
    expect(document.querySelector('[data-testid="lightbox-open-source"]')).not.toBeNull();
  });

  it("resolves a pi-asset snapshot src against the session asset map", () => {
    const { container } = renderMd(
      `[![Map](pi-asset:deadbeefcafe0001)](https://host.example/p 'snapshot')`,
      { deadbeefcafe0001: { data: "AAAA", mimeType: "image/png" } },
    );
    const card = container.querySelector('[data-testid="snapshot-unfurl-card"]');
    expect(card).not.toBeNull();
    const img = card!.querySelector("img");
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  // ── ZERO-REGRESSION ASSERTIONS (the bar) ─────────────────────────────────

  describe("graceful fallback to plain link (zero-regression bar)", () => {
    it("unresolved pi-asset snapshot → PLAIN anchor, exactly as before (no card)", () => {
      const { container } = renderMd(
        `[![Map](pi-asset:notpresent00000)](https://host.example/p 'snapshot')`,
        {}, // hash NOT in the map → no snapshot bytes
      );
      // No card…
      expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).toBeNull();
      // …falls back to a plain external anchor.
      const a = container.querySelector("a");
      expect(a).not.toBeNull();
      expect(a!.getAttribute("href")).toBe("https://host.example/p");
      expect(a!.getAttribute("target")).toBe("_blank");
      expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("external link WITHOUT a snapshot directive → unchanged plain anchor", () => {
      const { container } = renderMd("[docs](https://example.com)");
      expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).toBeNull();
      const a = container.querySelector("a")!;
      expect(a.getAttribute("href")).toBe("https://example.com");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.className).toContain("text-blue-400");
    });

    it("linked image WITHOUT a snapshot directive → unchanged linked image (not a card)", () => {
      // This is the existing [![alt](src)](href) behavior — must stay an <img>.
      const { container } = renderMd(`[![logo](${DATA_PNG})](https://example.com/page)`);
      expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).toBeNull();
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toBe(DATA_PNG);
    });

    it("snapshot directive on a NON-image link → plain anchor (no card)", () => {
      const { container } = renderMd("[just text](https://example.com 'snapshot')");
      expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).toBeNull();
      const a = container.querySelector("a")!;
      expect(a.textContent).toBe("just text");
      expect(a.getAttribute("href")).toBe("https://example.com");
    });

    it("snapshot directive on an INTERNAL link with image → plain (isExternalHref gate holds)", () => {
      const { container } = renderMd(`[![x](${DATA_PNG})](#frag 'snapshot')`);
      expect(container.querySelector('[data-testid="snapshot-unfurl-card"]')).toBeNull();
      const a = container.querySelector("a")!;
      expect(a.getAttribute("href")).toBe("#frag");
      expect(a.getAttribute("target")).toBeNull();
    });
  });
});
