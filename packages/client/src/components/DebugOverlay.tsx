// DebugOverlay.tsx — TEMPORARY diagnostic overlay for the operator's iPhone 14
// Pro Max PWA. Renders a fixed top-right pill showing the live values needed to
// diagnose the residual ~140px empty band below MobileComposer post-r29
// (commit 9cc91427). Opt-in via the URL query `?debug=1`, or by setting
// window.__DEBUG_OVERLAY__ = true, or via `import.meta.env.DEV`. Safe to
// delete once the diagnostic loop is closed.
import React, { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    __DEBUG_OVERLAY__?: boolean;
    __BUNDLE_HASH__?: string;
  }
}

function readBundleHash(): string {
  // Prefer an explicitly-injected hash if the build (or a script tag) provides one.
  if (typeof window !== "undefined" && window.__BUNDLE_HASH__) return window.__BUNDLE_HASH__;
  try {
    // Fallback: inspect the loaded module script tag for /assets/index-<hash>.js
    if (typeof document !== "undefined") {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/assets/index-"]'));
      for (const s of scripts) {
        const m = s.src.match(/\/assets\/(index-[A-Za-z0-9_-]+)\.js/);
        if (m) return m[1];
      }
    }
  } catch { /* ignore */ }
  return "unknown";
}

interface Snapshot {
  bundle: string;
  innerH: number;
  vvH: number | null;
  vvGap: number;
  keyboardH: string;
  focusedYN: "Y" | "N";
  focusedTag: string;
  displayMode: string;
  safeBot: string;
}

function takeSnapshot(probe: HTMLDivElement | null): Snapshot {
  const innerH = typeof window !== "undefined" ? window.innerHeight : 0;
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const vvH = vv ? Math.round(vv.height) : null;
  const vvGap = vvH != null ? innerH - vvH : 0;

  let keyboardH = "";
  try {
    if (typeof document !== "undefined") {
      keyboardH = (getComputedStyle(document.documentElement).getPropertyValue("--keyboard-h") || "").trim();
    }
  } catch { /* ignore */ }

  let focusedYN: "Y" | "N" = "N";
  let focusedTag = "-";
  try {
    if (typeof document !== "undefined") {
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        focusedTag = ae.tagName.toLowerCase();
        if (typeof ae.matches === "function" && ae.matches('input,textarea,[contenteditable="true"]')) {
          focusedYN = "Y";
        }
      }
    }
  } catch { /* ignore */ }

  let displayMode = "browser";
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      displayMode = window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser";
    }
  } catch { /* ignore */ }

  let safeBot = "?";
  try {
    if (probe) {
      // Force a fresh layout read of the env() value applied below.
      const cs = getComputedStyle(probe);
      safeBot = cs.paddingBottom || "?";
    }
  } catch { /* ignore */ }

  return {
    bundle: readBundleHash(),
    innerH: Math.round(innerH),
    vvH,
    vvGap: Math.round(vvGap),
    keyboardH: keyboardH || "(unset)",
    focusedYN,
    focusedTag,
    displayMode,
    safeBot,
  };
}

export function DebugOverlay() {
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [snap, setSnap] = useState<Snapshot>(() => takeSnapshot(null));

  useEffect(() => {
    const tick = () => setSnap(takeSnapshot(probeRef.current));
    // initial after mount (so probeRef is populated)
    tick();

    const onResize = tick;
    const onScroll = tick;
    const onFocusIn = tick;
    const onFocusOut = tick;

    window.addEventListener("resize", onResize);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onResize);
    vv?.addEventListener("scroll", onScroll);

    const id = window.setInterval(tick, 1000);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", onScroll);
      window.clearInterval(id);
    };
  }, []);

  return (
    <>
      {/* Off-screen probe used to measure env(safe-area-inset-bottom). */}
      <div
        ref={probeRef}
        aria-hidden
        style={{
          position: "fixed",
          left: -9999,
          top: -9999,
          width: 1,
          height: 1,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          pointerEvents: "none",
        }}
      />
      <div
        data-testid="debug-overlay"
        style={{
          position: "fixed",
          top: 4,
          right: 4,
          zIndex: 99999,
          background: "rgba(0,0,0,0.78)",
          color: "#fff",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 11,
          lineHeight: 1.25,
          padding: 6,
          maxWidth: 200,
          borderRadius: 4,
          pointerEvents: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {`bundle: ${snap.bundle}
innerH: ${snap.innerH}
vvH: ${snap.vvH ?? "n/a"}
vvGap: ${snap.vvGap}
--keyboard-h: ${snap.keyboardH}
editable: ${snap.focusedYN} (${snap.focusedTag})
display-mode: ${snap.displayMode}
safe-bot: ${snap.safeBot}`}
      </div>
    </>
  );
}

export default DebugOverlay;

/**
 * Returns true if the debug overlay should mount in the current environment.
 * - URL query `?debug=1` (operator opt-in for PWA, persists across reboot
 *   only if the operator opens the URL with the query)
 * - window.__DEBUG_OVERLAY__ truthy (manual paste from devtools)
 * - import.meta.env.DEV (vite dev server)
 */
export function shouldShowDebugOverlay(): boolean {
  // ⚠️ TEMPORARY (r30.1, 2026-05-20): unconditional return so the installed
  // PWA shows the overlay even when the launcher loses `?debug=1` (manifest
  // start_url="/" strips the query). Revert by deleting `return true;` and
  // un-prefixing the `// ` from each line in the "original gate" block below.
  return true;
  // ---- original gate (revert: delete `return true;` above + strip leading `// ` from these lines) ----
  // try {
  //   if (typeof window !== "undefined" && window.__DEBUG_OVERLAY__) return true;
  // } catch { /* ignore */ }
  // try {
  //   if (typeof window !== "undefined") {
  //     const params = new URLSearchParams(window.location.search);
  //     const v = params.get("debug");
  //     if (v && v !== "0" && v.toLowerCase() !== "false") return true;
  //   }
  // } catch { /* ignore */ }
  // try {
  //   // import.meta.env may be undefined outside Vite-bundled contexts; guard.
  //   // @ts-expect-error vite-injected
  //   if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) return true;
  // } catch { /* ignore */ }
  // return false;
}
