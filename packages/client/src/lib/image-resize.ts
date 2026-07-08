// ---------------------------------------------------------------------------
// image-resize — pre-send client-side downscale of attached images.
//
// Large phone photos (12MP → multi-MB) sent as raw base64 balloon both the
// outgoing message and the persisted session history, pushing context toward
// overflow. This module caps the LONG edge at IMAGE_MAX_LONG_EDGE just before
// send, shrinking iPhone photos ~6× in base64 while staying at Claude's
// max-usable resolution.
//
// The canvas decode/encode is behind an injectable ResizeBackend so the pure
// logic is unit-testable under jsdom (which has no real canvas toDataURL) — a
// fake backend is passed in tests. The real backend is never touched at module
// import time, only inside calls, so importing this file is SSR/test-safe.
// ---------------------------------------------------------------------------

import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
// NOTE: `import type` is erased at runtime — zero module-resolution cost in tests.

/** Max long-edge (px) for pre-send downscale. 1568 = Claude's max-usable
 *  resolution; iPhone 12MP photos shrink ~6× in base64 payload. THE config
 *  constant — change here. */
export const IMAGE_MAX_LONG_EDGE = 1568;

/** Re-encode quality for JPEG/WebP downscales (ignored for PNG). */
export const IMAGE_RESIZE_QUALITY = 0.85;

/** Raster MIME types we downscale via canvas. Animated GIF is EXCLUDED on
 *  purpose (canvas flattens to one frame → breaks animation) → passes through
 *  untouched. */
export const RESIZABLE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ResizeDimensions {
  width: number;
  height: number;
  resized: boolean;
}

/** PURE. Cap the LONG edge at maxLongEdge, preserve aspect ratio, round to int,
 *  floor at 1px. NEVER upscales → resized:false when already within the cap.
 *  Non-finite/≤0 dims → resized:false passthrough. */
export function computeResizeDimensions(
  width: number,
  height: number,
  maxLongEdge = IMAGE_MAX_LONG_EDGE,
): ResizeDimensions {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(maxLongEdge) ||
    maxLongEdge <= 0
  ) {
    return { width, height, resized: false };
  }
  const long = Math.max(width, height);
  if (long <= maxLongEdge) return { width, height, resized: false };
  const scale = maxLongEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/** PURE. True iff we downscale this MIME (jpeg/png/webp). gif + anything else
 *  → false. */
export function isResizableImageMime(mimeType: string): boolean {
  return RESIZABLE_IMAGE_MIME_TYPES.has(mimeType);
}

/** Keep-format-sensibly: output MIME == source MIME for resizable types (no
 *  cross-convert, so PNG/WebP alpha is preserved). The 1568 cap alone gives the
 *  payload win. */
export function outputMimeFor(sourceMime: string): string {
  return sourceMime;
}

/** Injectable decode/encode backend. Real one uses Image + <canvas>. */
export interface ResizeBackend {
  /** Decode the base64 image; expose natural dims + a redraw-encode fn. */
  decode(
    base64: string,
    mimeType: string,
  ): Promise<{
    width: number;
    height: number;
    /** Redraw at (w,h) and return base64 (NO data: prefix) of outputMime at
     *  quality. */
    toResizedBase64(
      width: number,
      height: number,
      outputMime: string,
      quality: number,
    ): Promise<string>;
  }>;
}

/** Real browser backend: `new Image()` from `data:${mime};base64,${data}`, draw
 *  into a `<canvas>` sized to target, `canvas.toDataURL(outputMime, quality)`,
 *  take the base64 part. Guarded for SSR/no-document. Never referenced at
 *  module top-level (only inside calls). */
export const canvasResizeBackend: ResizeBackend = {
  decode(base64, mimeType) {
    if (typeof document === "undefined") {
      return Promise.reject(new Error("no canvas"));
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
          toResizedBase64: (width, height, outputMime, quality) => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return Promise.reject(new Error("no 2d context"));
            ctx.drawImage(img, 0, 0, width, height);
            const url = canvas.toDataURL(outputMime, quality);
            return Promise.resolve(url.split(",")[1] ?? "");
          },
        });
      };
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = `data:${mimeType};base64,${base64}`;
    });
  },
};

export interface ResizeOneResult {
  image: ImageContent; // resized OR original passthrough
  changed: boolean; // true iff afterBytes < beforeBytes
  beforeBytes: number; // ≈ base64.length * 3/4
  afterBytes: number;
  reason: "resized" | "already-small" | "non-resizable-mime" | "not-image" | "error";
}

/** ≈ decoded byte length of a base64 string (ignoring padding — good enough for
 *  the before/after comparison). */
function approxBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** Resize ONE image per the skip/passthrough rules. NEVER throws — on any
 *  backend error, returns the ORIGINAL with reason:"error" (a resize failure
 *  must never block a send). Passthrough (original returned unchanged) when:
 *   - img.type !== "image" or mimeType doesn't start with "image/"  → "not-image"
 *   - !isResizableImageMime(mime) (e.g. gif)                        → "non-resizable-mime"
 *   - computeResizeDimensions(...).resized === false (already ≤cap) → "already-small"
 */
export async function resizeImageContent(
  img: ImageContent,
  opts?: { maxLongEdge?: number; quality?: number },
  backend: ResizeBackend = canvasResizeBackend,
): Promise<ResizeOneResult> {
  const beforeBytes = approxBytes(img.data);
  const passthrough = (reason: ResizeOneResult["reason"]): ResizeOneResult => ({
    image: img,
    changed: false,
    beforeBytes,
    afterBytes: beforeBytes,
    reason,
  });

  if (img.type !== "image" || !img.mimeType.startsWith("image/")) {
    return passthrough("not-image");
  }
  if (!isResizableImageMime(img.mimeType)) {
    return passthrough("non-resizable-mime");
  }

  const maxLongEdge = opts?.maxLongEdge ?? IMAGE_MAX_LONG_EDGE;
  const quality = opts?.quality ?? IMAGE_RESIZE_QUALITY;

  try {
    const decoded = await backend.decode(img.data, img.mimeType);
    const dims = computeResizeDimensions(decoded.width, decoded.height, maxLongEdge);
    if (!dims.resized) {
      return passthrough("already-small");
    }
    const outputMime = outputMimeFor(img.mimeType);
    const newBase64 = await decoded.toResizedBase64(dims.width, dims.height, outputMime, quality);
    const afterBytes = approxBytes(newBase64);
    return {
      image: { type: "image", data: newBase64, mimeType: outputMime },
      changed: afterBytes < beforeBytes,
      beforeBytes,
      afterBytes,
      reason: "resized",
    };
  } catch {
    return passthrough("error");
  }
}

export interface ResizeForSendOptions {
  sendFullResolution?: boolean;
  maxLongEdge?: number;
  quality?: number;
}

/** Map attachments for send. When sendFullResolution===true → return the SAME
 *  array of originals (no backend touched). Else resize each via
 *  resizeImageContent (Promise.all) and return the resulting images. Non-image /
 *  gif / already-small pass through. */
export async function resizeImagesForSend(
  images: ImageContent[],
  opts?: ResizeForSendOptions,
  backend: ResizeBackend = canvasResizeBackend,
): Promise<ImageContent[]> {
  if (opts?.sendFullResolution) return images;
  const results = await Promise.all(
    images.map((img) =>
      resizeImageContent(img, { maxLongEdge: opts?.maxLongEdge, quality: opts?.quality }, backend),
    ),
  );
  return results.map((r) => r.image);
}
