/**
 * Eager-bundle-graph invariant: the three home-useless heavy chunks
 * (react-syntax-highlighter `syntax-*`, @git-diff-view `diff-*`, @xterm
 * `xterm-*`) MUST stay async-only — never reachable from the eager
 * modulepreload graph that the browser fetches on first paint of the
 * session-list home view.
 *
 * Why this exists: those three graphs total ~2.05 MB decoded and are only
 * needed deep inside the diff view / a terminal tab / a rendered code block.
 * The React.lazy boundaries (HighlightedCode, LazyDiffPanel, LazyRichDiff,
 * lazy TerminalView) plus the vite.config chunk levers (vite-preload-helper
 * isolation, jsdiff split, hoistTransitiveImports:false, modulePreload
 * polyfill off) keep them out of the eager set. Two failure modes this guards:
 *
 *   1. A heavy chunk sneaks back into index.html's <script>/modulepreload
 *      graph (e.g. a static import re-introduced, or a chunk lever removed) —
 *      caught by the "absent from eager preloads" assertion.
 *   2. The lazy split is reverted entirely and the heavy modules merge INTO
 *      the index chunk (so no `syntax-*`/`diff-*`/`xterm-*` chunk is emitted
 *      at all) — caught by the "emitted as an async chunk" assertion, which
 *      would otherwise let mode (1) pass vacuously.
 *
 * Skips gracefully when packages/client/dist is absent (CI without a build),
 * so the suite stays green without a prior `npm run build`.
 *
 * See change: lazy-split-heavy-client-chunks.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "..", "dist");
const INDEX_HTML = path.join(DIST, "index.html");
const ASSETS_DIR = path.join(DIST, "assets");

/** Chunk-name prefixes that must remain async-only (anchored, so `jsdiff-`
 *  is NOT matched by `diff-`). */
const HEAVY_PREFIXES = ["syntax-", "diff-", "xterm-"] as const;

/** Pull every eager JS module reference out of index.html: the entry
 *  `<script type="module" src>` and each `<link rel="modulepreload" href>`.
 *  Stylesheet links are intentionally excluded. */
function eagerModuleBasenames(html: string): string[] {
  const refs: string[] = [];
  const re =
    /<(?:script\b[^>]*\bsrc|link\b[^>]*\brel="modulepreload"[^>]*\bhref)\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    refs.push(path.basename(m[1]));
  }
  return refs;
}

describe("eager bundle graph excludes heavy lazy chunks", () => {
  it("keeps syntax/diff/xterm chunks async-only", (ctx) => {
    if (!fs.existsSync(INDEX_HTML)) {
      ctx.skip(); // no build present — nothing to assert
      return;
    }

    const html = fs.readFileSync(INDEX_HTML, "utf-8");
    const eager = eagerModuleBasenames(html);
    const assetJs = fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => f.endsWith(".js"));

    // Sanity: the eager graph should be non-empty (entry + preloads).
    expect(eager.length, `no eager module refs parsed from ${INDEX_HTML}`).toBeGreaterThan(0);

    for (const prefix of HEAVY_PREFIXES) {
      // (2) The heavy chunk MUST be emitted as its own async chunk — proves
      // the lazy split actually happened (guards against a revert merging it
      // into the eager index chunk, which would make the absence check pass
      // vacuously).
      const asyncMatches = assetJs.filter((f) => f.startsWith(prefix));
      expect(
        asyncMatches.length,
        `expected at least one async chunk named "${prefix}*.js" in ${ASSETS_DIR} ` +
          `— if the lazy split was reverted, the heavy module merged into the eager index chunk`,
      ).toBeGreaterThan(0);

      // (1) None of those heavy chunks may appear in the eager preload graph.
      const eagerLeaks = eager.filter((f) => f.startsWith(prefix));
      expect(
        eagerLeaks,
        `heavy chunk "${prefix}*" leaked into the eager modulepreload graph of index.html: ` +
          `${eagerLeaks.join(", ")} — re-check the React.lazy boundary and vite.config chunk levers`,
      ).toEqual([]);
    }
  });
});
