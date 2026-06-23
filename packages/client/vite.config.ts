import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
// Import via a relative workspace path so vite's esbuild config-loader bundles
// the plugin (and its transitive .ts deps) into the temp config bundle. Using
// the package specifier "@blackbelt-technology/dashboard-plugin-runtime"
// instead would externalize the module and hit ERR_MODULE_NOT_FOUND because
// the runtime ships raw .ts (no compiled dist) and Node can't resolve
// `.js`-extensioned internal imports back to `.ts` at runtime.
import { viteDashboardPluginsPlugin } from "../dashboard-plugin-runtime/src/vite-plugin/index.js";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteDashboardPluginsPlugin(path.resolve(__dirname, "../..")),
  ],
  root: "src",
  // publicDir is resolved relative to `root` (= packages/client/src/), so three
  // `../` hops are needed to reach the project-root public/ directory which
  // holds icon-192.png, manifest.json, sw.js, etc.
  publicDir: "../../../public",
  resolve: {
    // Resolve symlinked workspace packages to their real path so a module
    // imported BOTH directly (App.tsx → ./components/MarkdownContent) AND via
    // the flows-plugin package symlink (flows → ../../../client/src/components/
    // MarkdownContent, reached through node_modules/@…/pi-dashboard-flows-plugin)
    // dedupes to ONE module. Without this, Rollup keys the two specifiers as
    // separate modules and emits TWO MarkdownContent copies — the flows copy
    // re-pulling react-syntax-highlighter eagerly and defeating the lazy split.
    // See change: lazy-split-heavy-client-chunks.
    preserveSymlinks: false,
    dedupe: ["react", "react-dom", "react-syntax-highlighter"],
    alias: {
      "@blackbelt-technology/pi-dashboard-shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Disable the __vitePreload polyfill. The polyfill helper is a tiny shared
    // module that Rollup parks in an arbitrary chunk (here it landed in the
    // 662KB syntax-core chunk); because EVERY dynamic import() wraps in the
    // helper, the eager entry then statically imports whatever chunk holds it —
    // re-dragging the 662KB syntax core into the modulepreload graph for the
    // sake of one helper. Modern evergreen targets (the dashboard's audience)
    // support <link rel=modulepreload> natively, so the polyfill is unnecessary.
    // See change: lazy-split-heavy-client-chunks.
    modulePreload: { polyfill: false },
    // Split the main bundle so no single chunk exceeds ~500 KB. This avoids
    // zrok / free-tunnel aborts on large static assets and improves caching
    // (only changed chunks invalidate).
    rollupOptions: {
      output: {
        // Do NOT add static imports of transitively-reachable chunks to a
        // chunk's own static import list. Vite/Rollup parks the shared
        // __vitePreload helper in an arbitrary vendor chunk (it landed in the
        // 662KB syntax core); with hoisting ON, the eager entry gains a STATIC
        // import of that whole chunk just to reach the helper, re-dragging the
        // syntax core into the modulepreload graph. With hoisting OFF, the
        // entry only statically imports what it directly needs; the syntax core
        // stays behind its lazy import(). See change: lazy-split-heavy-client-chunks.
        hoistTransitiveImports: false,
        manualChunks(id: string) {
          // Pin Vite's synthetic __vitePreload helper to its OWN tiny chunk.
          // Otherwise Rollup parks it inside whichever lazy vendor chunk it
          // processes first (here the 662KB syntax core); since EVERY dynamic
          // import() in the app calls the helper, the eager entry then carries a
          // real static ESM import of that whole chunk — re-dragging the syntax
          // core into the modulepreload graph. Isolating the helper lets the
          // syntax core stay purely async behind its lazy import().
          // See change: lazy-split-heavy-client-chunks.
          if (id.includes("vite/preload-helper")) {
            return "vite-preload-helper";
          }
          // Prism color-theme STYLE DATA (data-only, ~tens of KB for the 10
          // themes we use) is split into its OWN chunk, isolated from the heavy
          // react-syntax-highlighter CORE (refractor + ~200 language grammars,
          // ~662KB). Why: syntax-theme.ts is imported by TWO React.lazy chunks
          // (HighlightedCodeImpl + DiffPanel), so Rollup hoists it into the
          // eager entry as their common ancestor. The default
          // `"syntax": ["react-syntax-highlighter"]` rule glues the tiny style
          // data to the 662KB core, so that hoist re-drags the whole core into
          // the modulepreload graph. Isolating the styles means the eager entry
          // only pulls the small style chunk; the core stays purely async,
          // loaded only when a code block / diff actually renders.
          // See change: lazy-split-heavy-client-chunks.
          if (id.includes("/node_modules/react-syntax-highlighter/dist/esm/styles/")) {
            return "syntax-styles";
          }
          const chunks: Record<string, string[]> = {
            "react-vendor": ["react", "react-dom"],
            "markdown": ["react-markdown", "remark-gfm", "rehype-raw", "dompurify"],
            "syntax": ["react-syntax-highlighter"],
            "diff": [
              "@git-diff-view/core",
              "@git-diff-view/file",
              "@git-diff-view/lowlight",
              "@git-diff-view/react",
            ],
            // jsdiff (the `diff` package) is split into its OWN chunk, separate
            // from the heavy @git-diff-view graph above. EditToolRenderer
            // eagerly imports createTwoFilesPatch from jsdiff for the mobile
            // diff path, so if jsdiff stayed glued to @git-diff-view the whole
            // 1.1MB rich-diff chunk would be dragged back into the eager graph,
            // defeating the React.lazy boundaries on RichDiff/DiffPanel.
            // See change: lazy-split-heavy-client-chunks.
            "jsdiff": ["diff"],
            "xterm": [
              "@xterm/xterm",
              "@xterm/addon-attach",
              "@xterm/addon-fit",
            ],
            "dnd": [
              "@dnd-kit/core",
              "@dnd-kit/sortable",
              "@dnd-kit/utilities",
            ],
            "util": ["fuse.js", "qrcode", "wouter", "ansi-to-react"],
          };
          for (const [chunk, deps] of Object.entries(chunks)) {
            if (deps.some((dep) => id.includes(`/node_modules/${dep}/`))) {
              return chunk;
            }
          }
        },
      },
    },
    // Raise the warning limit — mermaid and cytoscape chunks are already
    // code-split by vite's dynamic-import detection and don't need further
    // splitting.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 3000,
    hmr: {
      // When served through the dashboard server (port 8000), HMR WebSocket
      // must connect directly to Vite's port, not the dashboard's.
      clientPort: 3000,
    },
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  // `vite preview` serves the built dist/ (production assets — incl. the
  // SW precache manifest injected by the build, which the dev server can't
  // serve). It needs the SAME backend proxy as the dev server so a full
  // production-parity e2e run (motion + SW) can point at it. Mirrors server.proxy.
  preview: {
    port: 4173,
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
});
