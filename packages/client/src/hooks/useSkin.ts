import { useState, useEffect, useCallback } from "react";

/**
 * Visual skin — an axis independent of the light/dark theme.
 *
 *  - "editorial" (default): the warm, characterful "Editorial Craft" look —
 *    espresso-dark hero + warm-paper light, Fraunces / Hanken Grotesk / IBM
 *    Plex Mono webfonts, terracotta accent, status-as-color rails.
 *  - "legacy": today's flat-gray system-font look, byte-for-byte unchanged.
 *
 * Composes with the existing `data-theme` (light/dark/system). The skin is
 * driven by a `data-skin` attribute on <html>; the editorial token blocks
 * live in index.css under `[data-skin="editorial"]`.
 */
export type Skin = "editorial" | "legacy";

const STORAGE_KEY = "dashboard:skin";
const DEFAULT_SKIN: Skin = "editorial";

/** Self-hosted-equivalent Google Fonts stylesheet for the editorial skin. */
const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

function readSkin(): Skin {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "editorial" || raw === "legacy") return raw;
  } catch {
    /* noop */
  }
  return DEFAULT_SKIN;
}

/** Apply the `data-skin` attribute on <html>. Editorial is the default, so we
 *  always write the attribute (rather than relying on absence) to keep the CSS
 *  cascade explicit. */
function applySkinAttr(skin: Skin) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-skin", skin);
}

/** Inject the editorial webfonts lazily, only when the editorial skin is
 *  active. Legacy never pays the font network cost. Idempotent: the <link>
 *  elements carry stable ids so repeated calls are no-ops. */
function applyFonts(skin: Skin) {
  if (typeof document === "undefined") return;
  const head = document.head;
  const existing = document.getElementById("editorial-fonts");

  if (skin === "editorial") {
    if (existing) return;
    const pre1 = document.createElement("link");
    pre1.id = "editorial-fonts-pre1";
    pre1.rel = "preconnect";
    pre1.href = "https://fonts.googleapis.com";
    const pre2 = document.createElement("link");
    pre2.id = "editorial-fonts-pre2";
    pre2.rel = "preconnect";
    pre2.href = "https://fonts.gstatic.com";
    pre2.crossOrigin = "anonymous";
    const sheet = document.createElement("link");
    sheet.id = "editorial-fonts";
    sheet.rel = "stylesheet";
    sheet.href = FONT_HREF;
    head.append(pre1, pre2, sheet);
  } else {
    for (const id of ["editorial-fonts", "editorial-fonts-pre1", "editorial-fonts-pre2"]) {
      document.getElementById(id)?.remove();
    }
  }
}

export interface SkinState {
  skin: Skin;
  setSkin: (skin: Skin) => void;
}

export function useSkin(): SkinState {
  const [skin, setSkinRaw] = useState<Skin>(readSkin);

  const setSkin = useCallback((next: Skin) => {
    setSkinRaw(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* noop */
    }
    applySkinAttr(next);
    applyFonts(next);
    // Notify useTheme so it can re-apply / strip named-theme inline overrides
    // for the new skin (editorial owns its palette; legacy restores the theme).
    try {
      window.dispatchEvent(new Event("skinchange"));
    } catch {
      /* noop */
    }
  }, []);

  // Apply on mount (the inline boot script in index.html sets the attribute
  // pre-paint to avoid FOUC; this re-asserts it and wires up fonts for React).
  useEffect(() => {
    applySkinAttr(skin);
    applyFonts(skin);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { skin, setSkin };
}

export { STORAGE_KEY as SKIN_STORAGE_KEY, DEFAULT_SKIN };
