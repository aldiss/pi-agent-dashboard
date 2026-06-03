#!/usr/bin/env node
/**
 * Post-build step: enumerate dist/ entry-chunk + manual-chunk + stylesheets
 * + static public/ assets; substitute the resulting JSON array into
 * dist/sw.js at the literal placeholder `__PRECACHE_MANIFEST__`.
 *
 * Why: SW v3 (see public/sw.js) precaches the app-shell on install.
 * Vite emits hashed asset filenames per build — the precache list
 * MUST be regenerated per build OR the SW serves stale assets.
 *
 * Zero-dep — Node built-ins only (fs, path).
 * Sister-shape to packages/client/scripts/precompress.mjs canonical zero-dep pattern.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");
const swPath = path.join(distDir, "sw.js");
const indexHtmlPath = path.join(distDir, "index.html");

// 1. Read dist/index.html — parse out asset URLs from <script src> + <link href>.
// We use regex (not a full HTML parser) because Vite's emitted index.html
// is canonical-shape (no operator-authored interpolation).
const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");

const SCRIPT_SRC = /<script[^>]+src="(\/[^"]+)"/g;
const LINK_HREF = /<link[^>]+href="(\/[^"]+\.(?:js|css))"/g;

const assetUrls = new Set();
// Always include shell + entry HTML
assetUrls.add("/");
assetUrls.add("/index.html");

for (const re of [SCRIPT_SRC, LINK_HREF]) {
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    assetUrls.add(m[1]);
  }
}

// 2. Static public/ assets (canonical-fixed list; not hashed)
const STATIC_PUBLIC = ["/icon-192.png", "/icon-512.png", "/manifest.json"];
for (const u of STATIC_PUBLIC) assetUrls.add(u);

// 3. Substitute into dist/sw.js
const precacheList = Array.from(assetUrls).sort();
const sw = fs.readFileSync(swPath, "utf-8");
if (!sw.includes("__PRECACHE_MANIFEST__")) {
  console.error("[inject-sw-precache] FATAL: sw.js does not contain __PRECACHE_MANIFEST__ placeholder");
  process.exit(1);
}
const substituted = sw.replace("__PRECACHE_MANIFEST__", JSON.stringify(precacheList, null, 2));
fs.writeFileSync(swPath, substituted);

console.log(`[inject-sw-precache] injected ${precacheList.length} assets into dist/sw.js:`);
for (const u of precacheList) console.log(`  ${u}`);
