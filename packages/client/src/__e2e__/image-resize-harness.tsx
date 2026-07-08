// Test-only harness for the pre-send image-resize e2e (qa/image-resize).
//
// Exposes the REAL resize module on window.__imageResizeE2E. Its default backend
// (canvasResizeBackend) runs an actual <canvas> decode+encode — the exact browser
// path the jsdom unit tests cannot exercise (jsdom has no canvas toDataURL). The
// Playwright spec generates real, browser-encoded images here, runs the production
// resizeImagesForSend, and asserts the long-edge cap + payload shrink.
//
// Served only by the qa/image-resize Playwright webServer; never imported by the
// shipped app, so it stays out of the production bundle.
import {
  resizeImagesForSend,
  computeResizeDimensions,
  IMAGE_MAX_LONG_EDGE,
} from "../lib/image-resize.js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** ≈ decoded byte length of a base64 string. */
function approxBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Draw a high-entropy image (gradient + deterministic pseudo-random blocks) and
 * encode it in-browser. The entropy matters: a flat color compresses to almost
 * nothing and would make the payload-shrink assertion meaningless. Deterministic
 * so runs are reproducible.
 */
async function makeImage(
  width: number,
  height: number,
  mimeType = "image/jpeg",
  quality = 0.92,
): Promise<ImageContent> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, "#ff5722");
  grad.addColorStop(0.5, "#2196f3");
  grad.addColorStop(1, "#4caf50");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})`;
    ctx.fillRect(rnd() * width, rnd() * height, rnd() * 40, rnd() * 40);
  }
  const dataUrl = canvas.toDataURL(mimeType, quality);
  return { type: "image", data: dataUrl.split(",")[1] ?? "", mimeType };
}

/** Decode a base64 image back to its NATURAL dimensions via a real browser decode. */
function decodeDims(img: ImageContent): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve({ width: el.naturalWidth, height: el.naturalHeight });
    el.onerror = () => reject(new Error("decode failed"));
    el.src = `data:${img.mimeType};base64,${img.data}`;
  });
}

declare global {
  interface Window {
    __imageResizeE2E: {
      IMAGE_MAX_LONG_EDGE: number;
      makeImage: typeof makeImage;
      decodeDims: typeof decodeDims;
      resizeImagesForSend: typeof resizeImagesForSend;
      computeResizeDimensions: typeof computeResizeDimensions;
      approxBytes: (base64: string) => number;
    };
  }
}

window.__imageResizeE2E = {
  IMAGE_MAX_LONG_EDGE,
  makeImage,
  decodeDims,
  resizeImagesForSend,
  computeResizeDimensions,
  approxBytes,
};
