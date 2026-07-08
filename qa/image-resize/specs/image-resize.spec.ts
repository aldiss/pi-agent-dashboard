import { test, expect, type Page } from "@playwright/test";

/**
 * Pre-send image-resize — REAL browser canvas e2e. Drives live Chromium against the
 * isolated harness, which exposes the production resize module. Every assertion below
 * runs the actual canvasResizeBackend (Image + <canvas> + toDataURL) that the jsdom
 * unit tests stub out — this is the gap-closer for the real encode path.
 */

const HARNESS = "/__e2e__/image-resize-harness.html";

interface HarnessImage {
  type: "image";
  data: string;
  mimeType: string;
}

declare global {
  interface Window {
    __imageResizeE2E: {
      IMAGE_MAX_LONG_EDGE: number;
      makeImage: (w: number, h: number, mime?: string, q?: number) => Promise<HarnessImage>;
      decodeDims: (img: HarnessImage) => Promise<{ width: number; height: number }>;
      resizeImagesForSend: (
        images: HarnessImage[],
        opts?: { sendFullResolution?: boolean; maxLongEdge?: number; quality?: number },
      ) => Promise<HarnessImage[]>;
      computeResizeDimensions: (
        w: number,
        h: number,
        max?: number,
      ) => { width: number; height: number; resized: boolean };
      approxBytes: (base64: string) => number;
    };
  }
}

async function ready(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__imageResizeE2E, null, { timeout: 15_000 });
}

test.describe("pre-send image resize (real browser canvas)", () => {
  test("caps a 12MP landscape JPEG at 1568px long edge and shrinks the payload", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const orig = await E.makeImage(4032, 3024, "image/jpeg");
      const before = E.approxBytes(orig.data);
      const [out] = await E.resizeImagesForSend([orig]);
      const after = E.approxBytes(out.data);
      const dims = await E.decodeDims(out);
      return { before, after, dims, mimeType: out.mimeType, cap: E.IMAGE_MAX_LONG_EDGE };
    });
    expect(r.cap).toBe(1568);
    expect(Math.max(r.dims.width, r.dims.height)).toBe(1568);
    expect(r.dims).toEqual({ width: 1568, height: 1176 }); // 4:3 aspect preserved
    expect(r.mimeType).toBe("image/jpeg");
    // The whole point: a real, substantial payload cut (well past 2x).
    expect(r.after).toBeLessThan(r.before * 0.5);
  });

  test("caps a 12MP portrait JPEG on its height (long edge = height)", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const orig = await E.makeImage(3024, 4032, "image/jpeg");
      const [out] = await E.resizeImagesForSend([orig]);
      return { dims: await E.decodeDims(out) };
    });
    expect(r.dims).toEqual({ width: 1176, height: 1568 });
  });

  test("does NOT upscale an already-small image (skip, untouched)", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const orig = await E.makeImage(800, 600, "image/jpeg");
      const [out] = await E.resizeImagesForSend([orig]);
      return { dims: await E.decodeDims(out), sameData: out.data === orig.data };
    });
    expect(r.dims).toEqual({ width: 800, height: 600 });
    expect(r.sameData).toBe(true);
  });

  test("full-resolution override sends the original bytes untouched", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const orig = await E.makeImage(4032, 3024, "image/jpeg");
      const [out] = await E.resizeImagesForSend([orig], { sendFullResolution: true });
      return { sameData: out.data === orig.data, mimeType: out.mimeType };
    });
    expect(r.sameData).toBe(true);
    expect(r.mimeType).toBe("image/jpeg");
  });

  test("animated-gif MIME passes through untouched (no canvas flatten)", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const big = await E.makeImage(4032, 3024, "image/jpeg");
      const gif = { type: "image", data: big.data, mimeType: "image/gif" } as const;
      const [out] = await E.resizeImagesForSend([gif]);
      return { sameData: out.data === gif.data, mimeType: out.mimeType };
    });
    expect(r.sameData).toBe(true);
    expect(r.mimeType).toBe("image/gif");
  });

  test("PNG stays PNG, capped at 1568px, and shrinks", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const orig = await E.makeImage(4032, 3024, "image/png");
      const before = E.approxBytes(orig.data);
      const [out] = await E.resizeImagesForSend([orig]);
      const after = E.approxBytes(out.data);
      return { dims: await E.decodeDims(out), mimeType: out.mimeType, before, after };
    });
    expect(r.dims).toEqual({ width: 1568, height: 1176 });
    expect(r.mimeType).toBe("image/png");
    expect(r.after).toBeLessThan(r.before);
  });

  test("resizes a 5-image batch (the overflow case) — all capped, aggregate cut", async ({ page }) => {
    await ready(page);
    const r = await page.evaluate(async () => {
      const E = window.__imageResizeE2E;
      const batch = await Promise.all([
        E.makeImage(4032, 3024, "image/jpeg"),
        E.makeImage(4032, 3024, "image/jpeg"),
        E.makeImage(3024, 4032, "image/jpeg"),
        E.makeImage(4032, 3024, "image/jpeg"),
        E.makeImage(3024, 4032, "image/jpeg"),
      ]);
      const before = batch.reduce((n, i) => n + E.approxBytes(i.data), 0);
      const out = await E.resizeImagesForSend(batch);
      const after = out.reduce((n, i) => n + E.approxBytes(i.data), 0);
      const longs = await Promise.all(
        out.map(async (i) => {
          const d = await E.decodeDims(i);
          return Math.max(d.width, d.height);
        }),
      );
      return { count: out.length, longs, before, after };
    });
    expect(r.count).toBe(5);
    expect(r.longs.every((l) => l === 1568)).toBe(true);
    expect(r.after).toBeLessThan(r.before * 0.5);
  });
});
