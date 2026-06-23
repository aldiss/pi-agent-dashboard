import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Shared e2e helpers — the single source of truth for selectors, the
 * skin/theme localStorage contract, WebSocket-frame capture, and boot-wait.
 * Specs import from here so a DOM change touches ONE file, not twenty.
 *
 * Every selector below was read off the committed editorial components
 * (SkinProvider/useSkin, AppearanceSection, ModelReasoningSheet, SessionHeader,
 * SessionCard, SettingsPanel) — not guessed.
 */

export type Skin = "editorial" | "legacy";
export type ThemePref = "light" | "dark" | "system";

// localStorage keys — mirror hooks/useSkin.ts + hooks/useTheme.ts verbatim.
export const SKIN_KEY = "dashboard:skin";
export const THEME_KEY = "dashboard:theme";

/** A WS frame the client sent to the server, captured in-page. */
export interface CapturedFrame {
  type: string;
  [k: string]: unknown;
}

declare global {
  interface Window {
    __wsFrames?: CapturedFrame[];
    /** When true, mutating control frames (set_model / set_thinking_level /
     *  set_push_prefs) are RECORDED but NOT forwarded to the server, so the
     *  suite never permanently mutates a live session. Default true. */
    __wsSwallowMutations?: boolean;
  }
}

/** Control frames that change live-session state. Recorded then swallowed by
 *  default so the e2e suite is non-destructive against the live :8000 server. */
const MUTATING_FRAME_TYPES = new Set(["set_model", "set_thinking_level", "set_push_prefs"]);

/**
 * Install — BEFORE any app script runs — three things:
 *   1. The chosen skin + theme in localStorage, so the pre-paint boot script in
 *      index.html and the React hooks both pick them up (no flash, no reload).
 *   2. A WebSocket.prototype.send shim that records every JSON frame the client
 *      sends into window.__wsFrames, and (by default) swallows the mutating
 *      control frames so we can assert their shape without corrupting a live
 *      session.
 *   3. prefers-reduced-motion is left to the project; we disable animations at
 *      screenshot time via the Playwright config.
 */
export async function primeApp(
  page: Page,
  opts: { skin?: Skin; theme?: ThemePref; swallowMutations?: boolean } = {},
): Promise<void> {
  const skin = opts.skin ?? "editorial";
  const theme = opts.theme ?? "dark";
  const swallow = opts.swallowMutations ?? true;

  await page.addInitScript(
    ({ skinKey, themeKey, skinVal, themeVal, swallowVal, mutating }) => {
      try {
        // Seed the INITIAL skin/theme only when unset. Re-running on every
        // navigation (incl. reload) must NOT clobber a choice the test just
        // made via the UI — that would defeat the persistence assertions.
        if (localStorage.getItem(skinKey) === null) localStorage.setItem(skinKey, skinVal);
        if (localStorage.getItem(themeKey) === null) localStorage.setItem(themeKey, themeVal);
      } catch {
        /* noop */
      }
      window.__wsFrames = [];
      window.__wsSwallowMutations = swallowVal;

      const NativeWS = window.WebSocket;
      const send = NativeWS.prototype.send;
      NativeWS.prototype.send = function (this: WebSocket, data: unknown) {
        try {
          if (typeof data === "string") {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.type === "string") {
              window.__wsFrames!.push(parsed);
              if (window.__wsSwallowMutations && mutating.includes(parsed.type)) {
                // Recorded for assertion; do NOT forward to the server.
                return;
              }
            }
          }
        } catch {
          /* non-JSON frame (e.g. binary terminal) — fall through */
        }
        return send.call(this, data as never);
      };
    },
    {
      skinKey: SKIN_KEY,
      themeKey: THEME_KEY,
      skinVal: skin,
      themeVal: theme,
      swallowVal: swallow,
      mutating: [...MUTATING_FRAME_TYPES],
    },
  );
}

/** Read the WS frames captured in-page, optionally filtered by type. */
export async function wsFrames(page: Page, type?: string): Promise<CapturedFrame[]> {
  const all = await page.evaluate(() => window.__wsFrames ?? []);
  return type ? all.filter((f) => f.type === type) : all;
}

/** Wait until a WS frame of `type` has been captured, then return the last one. */
export async function waitForFrame(page: Page, type: string, timeout = 8_000): Promise<CapturedFrame> {
  await expect
    .poll(async () => (await wsFrames(page, type)).length, { timeout })
    .toBeGreaterThan(0);
  const frames = await wsFrames(page, type);
  return frames[frames.length - 1];
}

/**
 * Navigate to the app and wait until it has booted AND the WS has connected:
 *   - the pre-paint skeleton (#root > .pi-skeleton) is gone (React hydrated),
 *   - the header app-bar is visible (session-list shell rendered),
 *   - the "Connecting..." banner is NOT showing (status === "connected"),
 *   - at least one session card has rendered (WS replayed session state — the
 *     list populates async a beat after the shell, so downstream helpers that
 *     walk cards don't race an empty list).
 */
export async function bootAndConnect(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  // React hydrates and replaces the boot skeleton.
  await expect(page.locator(".pi-skeleton")).toHaveCount(0, { timeout: 25_000 });
  await expect(headerAppBar(page)).toBeVisible({ timeout: 25_000 });
  // status leaves "connecting" → the yellow banner disappears.
  await expect(page.getByText("Connecting...", { exact: true })).toHaveCount(0, { timeout: 25_000 });
  // Session state replayed into the list.
  await expect.poll(() => sessionCards(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
}

/** Read the live `data-skin` / `data-theme` attributes off <html>. */
export async function rootAttrs(page: Page): Promise<{ skin: string | null; theme: string | null }> {
  return page.evaluate(() => ({
    skin: document.documentElement.getAttribute("data-skin"),
    theme: document.documentElement.getAttribute("data-theme"),
  }));
}

// ── Selectors (all verified against committed components) ──────────────────

export const headerAppBar = (p: Page): Locator => p.getByTestId("header-app-bar");
export const settingsButton = (p: Page): Locator => p.getByTestId("settings-btn");
export const sessionCards = (p: Page): Locator => p.locator("[data-session-id]");

// Settings → Appearance
export const skinSelector = (p: Page): Locator => p.getByTestId("skin-selector");
export const skinOption = (p: Page, skin: Skin): Locator => p.getByTestId(`skin-${skin}`);
export const themeToggle = (p: Page): Locator => p.getByTestId("appearance-theme-toggle");
export const themeOption = (p: Page, t: ThemePref): Locator => p.getByTestId(`appearance-theme-${t}`);
/** The Appearance section root. Anchored on the stable `skin-selector` testid
 *  and walked two fixed levels up (skin-block → section root), so it resolves
 *  the same node whether or not the build carries the additive
 *  `appearance-section` testid. */
export const appearanceSection = (p: Page): Locator =>
  p.getByTestId("skin-selector").locator("xpath=../..");
export const settingsTabBar = (p: Page): Locator => p.getByTestId("settings-tab-bar");

// Mobile model/reasoning sheet (the MVP)
export const modelRow = (p: Page): Locator => p.getByTestId("mobile-header-model-row");
export const modelSheet = (p: Page): Locator => p.getByTestId("model-sheet");
export const modelSheetScrim = (p: Page): Locator => p.getByTestId("model-sheet-scrim");
export const sheetThinkingSeg = (p: Page): Locator => p.getByTestId("sheet-thinking-seg");
export const sheetThinkingLevel = (p: Page, level: string): Locator => p.getByTestId(`sheet-thinking-${level}`);
export const sheetBell = (p: Page): Locator => p.getByTestId("sheet-bell");
export const sheetModelList = (p: Page): Locator => p.getByTestId("sheet-model-list");
export const backButton = (p: Page): Locator => p.getByTestId("back-button");

/**
 * Dismiss the model sheet by tapping the scrim ABOVE the sheet. The scrim is a
 * full-screen sibling of the bottom-anchored sheet, so its center is *under*
 * the sheet — a default center-click hits the sheet and is intercepted. Tapping
 * near the top-left lands on the exposed dimmed area, exactly as a user taps to
 * dismiss. Idempotent-safe: callers assert the sheet is hidden afterward.
 */
export async function dismissSheet(page: Page): Promise<void> {
  await modelSheetScrim(page).click({ position: { x: 24, y: 24 } });
}

/** Open Settings and wait for the tab bar + Appearance section. Navigates to
 *  /settings directly (deterministic) rather than racing a single header-button
 *  click on the live SPA; falls back to the button if the route render lags. */
export async function openSettings(page: Page): Promise<void> {
  await settingsButton(page).click();
  const tabBar = settingsTabBar(page);
  if (!(await tabBar.isVisible({ timeout: 4_000 }).catch(() => false))) {
    // Click didn't land (live SPA race) — go to the route directly.
    await page.goto("/settings");
  }
  await expect(tabBar).toBeVisible({ timeout: 10_000 });
  await expect(appearanceSection(page)).toBeVisible();
}

/**
 * Open the first live session that exposes the tappable mobile model row, and
 * return its id. The live server has many sessions; some are cold (no model yet)
 * and render no model row. We walk visible cards until one shows the row, capped
 * so a fully-cold server fails fast rather than hanging.
 *
 * Assumes the caller already ran bootAndConnect (so the card list is populated).
 * Re-reads the card count up front and caps tries to whatever is actually there.
 */
export async function openSessionWithModelRow(page: Page, maxTries = 12): Promise<string | null> {
  // The list is populated by bootAndConnect; settle one more beat in case more
  // cards stream in.
  await expect.poll(() => sessionCards(page).count(), { timeout: 10_000 }).toBeGreaterThan(0);
  const count = await sessionCards(page).count();
  const tries = Math.min(count, maxTries);
  for (let i = 0; i < tries; i++) {
    const card = sessionCards(page).nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;
    const id = await card.getAttribute("data-session-id");
    await card.click();
    // Mobile routes to /session/:id; the model row appears iff a model or
    // thinking level is known for the session.
    if (await modelRow(page).isVisible({ timeout: 2_500 }).catch(() => false)) {
      return id;
    }
    // Not this one — go back to the list and try the next card.
    if (await backButton(page).isVisible().catch(() => false)) {
      await backButton(page).click();
    } else {
      await page.goto("/");
    }
    await expect(headerAppBar(page)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => sessionCards(page).count(), { timeout: 10_000 }).toBeGreaterThan(0);
  }
  return null;
}
