import { describe, it, expect, vi } from "vitest";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  computeResizeDimensions,
  isResizableImageMime,
  outputMimeFor,
  resizeImageContent,
  resizeImagesForSend,
  type ResizeBackend,
} from "../image-resize.js";

// Fake backend — jsdom has no real canvas toDataURL. `decode` reads the natural
// dims out of the base64 data string (pattern "<w>x<h>...") so a mixed array
// resolves per-image without depending on call order. `toResizedBase64` is a
// shared spy returning a short deterministic string so afterBytes < beforeBytes.
function makeFakeBackend() {
  const toResizedBase64 = vi.fn(
    async (_w: number, _h: number, _mime: string, _q: number) => "RS",
  );
  const decode = vi.fn(async (base64: string, _mimeType: string) => {
    const m = /^(\d+)x(\d+)/.exec(base64);
    return {
      width: m ? Number(m[1]) : 100,
      height: m ? Number(m[2]) : 100,
      toResizedBase64,
    };
  });
  return { backend: { decode } as ResizeBackend, decode, toResizedBase64 };
}

function img(mimeType: string, data: string): ImageContent {
  return { type: "image", data, mimeType };
}

// A base64-ish string that decodes (via the fake) to WxH and is long enough that
// the resized "RS" output is strictly smaller.
function bigImageData(w: number, h: number): string {
  return `${w}x${h}` + "A".repeat(2000);
}

describe("computeResizeDimensions", () => {
  it("caps a landscape long edge and preserves aspect", () => {
    expect(computeResizeDimensions(4032, 3024)).toEqual({
      width: 1568,
      height: 1176,
      resized: true,
    });
  });

  it("caps a portrait long edge and preserves aspect", () => {
    expect(computeResizeDimensions(3024, 4032)).toEqual({
      width: 1176,
      height: 1568,
      resized: true,
    });
  });

  it("caps a square to the max on both edges", () => {
    expect(computeResizeDimensions(4000, 4000)).toEqual({
      width: 1568,
      height: 1568,
      resized: true,
    });
  });

  it("never upscales an already-small image", () => {
    expect(computeResizeDimensions(1200, 800)).toEqual({
      width: 1200,
      height: 800,
      resized: false,
    });
  });

  it("treats exactly-at-cap as already-small (no resize)", () => {
    expect(computeResizeDimensions(1568, 1000)).toEqual({
      width: 1568,
      height: 1000,
      resized: false,
    });
  });

  it("rounds and floors the short edge at >=1px", () => {
    expect(computeResizeDimensions(1569, 10)).toEqual({
      width: 1568,
      height: 10,
      resized: true,
    });
  });

  it("honors a custom maxLongEdge", () => {
    expect(computeResizeDimensions(1000, 500, 400)).toEqual({
      width: 400,
      height: 200,
      resized: true,
    });
  });

  it("passes through non-finite / zero dims without resizing", () => {
    expect(computeResizeDimensions(0, 100).resized).toBe(false);
    expect(computeResizeDimensions(Number.NaN, 100).resized).toBe(false);
    expect(computeResizeDimensions(Number.POSITIVE_INFINITY, 100).resized).toBe(false);
  });
});

describe("isResizableImageMime", () => {
  it("accepts jpeg/png/webp", () => {
    expect(isResizableImageMime("image/jpeg")).toBe(true);
    expect(isResizableImageMime("image/png")).toBe(true);
    expect(isResizableImageMime("image/webp")).toBe(true);
  });

  it("rejects gif and everything else", () => {
    expect(isResizableImageMime("image/gif")).toBe(false);
    expect(isResizableImageMime("image/heic")).toBe(false);
    expect(isResizableImageMime("text/plain")).toBe(false);
  });
});

describe("outputMimeFor", () => {
  it("keeps the source MIME for resizable types (no cross-convert)", () => {
    expect(outputMimeFor("image/png")).toBe("image/png");
    expect(outputMimeFor("image/jpeg")).toBe("image/jpeg");
    expect(outputMimeFor("image/webp")).toBe("image/webp");
  });
});

describe("resizeImagesForSend", () => {
  it("returns [] for an empty array", async () => {
    const { backend, decode } = makeFakeBackend();
    expect(await resizeImagesForSend([], undefined, backend)).toEqual([]);
    expect(decode).not.toHaveBeenCalled();
  });

  it("sendFullResolution:true → returns originals, never touches the backend", async () => {
    const { backend, decode } = makeFakeBackend();
    const originals = [img("image/jpeg", bigImageData(4032, 3024))];
    const out = await resizeImagesForSend(originals, { sendFullResolution: true }, backend);
    expect(out).toBe(originals);
    expect(decode).not.toHaveBeenCalled();
  });

  it("downscales a large jpeg (decode + encode called)", async () => {
    const { backend, decode, toResizedBase64 } = makeFakeBackend();
    const out = await resizeImagesForSend(
      [img("image/jpeg", bigImageData(4032, 3024))],
      undefined,
      backend,
    );
    expect(decode).toHaveBeenCalledTimes(1);
    expect(toResizedBase64).toHaveBeenCalledTimes(1);
    expect(out[0]).toEqual({ type: "image", data: "RS", mimeType: "image/jpeg" });
  });

  it("passes an already-small jpeg through (no re-encode)", async () => {
    const { backend, decode, toResizedBase64 } = makeFakeBackend();
    const original = img("image/jpeg", bigImageData(800, 600));
    const out = await resizeImagesForSend([original], undefined, backend);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(toResizedBase64).not.toHaveBeenCalled();
    expect(out[0]).toBe(original);
  });

  it("passes a gif through without decoding (animation-safe)", async () => {
    const { backend, decode } = makeFakeBackend();
    const original = img("image/gif", bigImageData(4032, 3024));
    const out = await resizeImagesForSend([original], undefined, backend);
    expect(decode).not.toHaveBeenCalled();
    expect(out[0]).toBe(original);
  });

  it("passes a non-image attachment through", async () => {
    const { backend, decode } = makeFakeBackend();
    const original = img("application/pdf", "not-an-image");
    const out = await resizeImagesForSend([original], undefined, backend);
    expect(decode).not.toHaveBeenCalled();
    expect(out[0]).toBe(original);
  });

  it("never throws when the backend decode fails → sends the original", async () => {
    const backend: ResizeBackend = {
      decode: vi.fn(async () => {
        throw new Error("decode boom");
      }),
    };
    const original = img("image/jpeg", bigImageData(4032, 3024));
    const out = await resizeImagesForSend([original], undefined, backend);
    expect(out[0]).toBe(original);
  });

  it("resizes only the large resizable image in a mixed array", async () => {
    const { backend, toResizedBase64 } = makeFakeBackend();
    const smallJpeg = img("image/jpeg", bigImageData(800, 600));
    const largePng = img("image/png", bigImageData(4032, 3024));
    const gif = img("image/gif", bigImageData(4032, 3024));
    const out = await resizeImagesForSend([smallJpeg, largePng, gif], undefined, backend);
    expect(out[0]).toBe(smallJpeg);
    expect(out[1]).toEqual({ type: "image", data: "RS", mimeType: "image/png" });
    expect(out[2]).toBe(gif);
    expect(toResizedBase64).toHaveBeenCalledTimes(1);
  });
});

describe("resizeImageContent", () => {
  it("reports before/after bytes and reason:resized for a downscale", async () => {
    const { backend } = makeFakeBackend();
    const data = bigImageData(4032, 3024);
    const result = await resizeImageContent(img("image/jpeg", data), undefined, backend);
    expect(result.reason).toBe("resized");
    expect(result.changed).toBe(true);
    expect(result.beforeBytes).toBe(Math.floor((data.length * 3) / 4));
    expect(result.afterBytes).toBe(Math.floor(("RS".length * 3) / 4));
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
  });

  it("reason:already-small for an in-cap image", async () => {
    const { backend } = makeFakeBackend();
    const result = await resizeImageContent(
      img("image/jpeg", bigImageData(800, 600)),
      undefined,
      backend,
    );
    expect(result.reason).toBe("already-small");
    expect(result.changed).toBe(false);
  });

  it("reason:non-resizable-mime for a gif", async () => {
    const { backend } = makeFakeBackend();
    const result = await resizeImageContent(
      img("image/gif", bigImageData(4032, 3024)),
      undefined,
      backend,
    );
    expect(result.reason).toBe("non-resizable-mime");
  });

  it("reason:not-image for a non-image MIME", async () => {
    const { backend } = makeFakeBackend();
    const result = await resizeImageContent(img("application/pdf", "x"), undefined, backend);
    expect(result.reason).toBe("not-image");
  });

  it("reason:error (original returned) when the backend throws", async () => {
    const backend: ResizeBackend = {
      decode: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const original = img("image/jpeg", bigImageData(4032, 3024));
    const result = await resizeImageContent(original, undefined, backend);
    expect(result.reason).toBe("error");
    expect(result.image).toBe(original);
    expect(result.changed).toBe(false);
  });
});
