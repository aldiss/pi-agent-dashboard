import { test, expect, type Page } from "@playwright/test";

/**
 * Real interaction e2e for the ADAPTIVE ChatGPT-style mobile composer (single-row ⇄ column).
 * Drives a live Chromium against the isolated harness — types, taps, asserts handler-fire +
 * geometry + the data-multiline state. Regression guard for the adaptive restructure AND the
 * two engineered traps:
 *   TRAP 1 (oscillation) — asymmetric hysteresis; once column, stays column until short/cleared.
 *   TRAP 2 (focus-loss)  — one stable element tree; the textarea never remounts on a mode flip.
 *
 * Layout contract asserted below:
 *   single-row (data-multiline="false"): card `flex items-end` → attach | textarea(flex-1) |
 *     [mic stop send] all inline, bottoms aligned → send.top < textarea.bottom (same row).
 *   column     (data-multiline="true"):  card `flex flex-wrap`; textarea `order-first basis-full`
 *     on line 1 full-width → attach + controls wrap to line 2 → their tops ≥ textarea.bottom.
 */

const HARNESS = "/__e2e__/composer-harness.html";
const CARD = '[data-testid="mobile-composer-card"]';
const TEXTAREA = '[data-testid="mobile-composer-textarea"]';
const SEND = '[data-testid="mobile-composer-send"]';
const STOP = '[data-testid="mobile-composer-stop"]';
const ATTACH = '[data-testid="mobile-composer-attach"]';
const MIC = '[data-testid="push-to-talk"]';

const flush = (page: Page) => page.waitForTimeout(80);
const clientH = (page: Page) =>
  page.locator(TEXTAREA).evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
const scrollH = (page: Page) =>
  page.locator(TEXTAREA).evaluate((el) => (el as HTMLTextAreaElement).scrollHeight);
const e2e = (page: Page) => page.evaluate(() => window.__e2e);
const multiline = async (page: Page) => (await page.locator(CARD).getAttribute("data-multiline")) ?? "";
const box = async (page: Page, sel: string) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no bounding box for ${sel}`);
  return b;
};
const resetSpies = (page: Page) =>
  page.evaluate(() => {
    window.__e2e = { sends: [], aborts: 0, attachClicks: 0 };
  });

/** single-row contract: send sits BESIDE the textarea (top above textarea.bottom + vertical overlap). */
async function assertSingleRowGeometry(page: Page) {
  const ta = await box(page, TEXTAREA);
  const send = await box(page, SEND);
  expect(send.y, "send.top is NOT below textarea.bottom (same row)").toBeLessThan(ta.y + ta.height);
  const overlap = Math.min(ta.y + ta.height, send.y + send.height) - Math.max(ta.y, send.y);
  expect(overlap, "send and textarea vertically overlap (inline, single row)").toBeGreaterThan(0);
}

/** column contract: attach AND send are BELOW the textarea (wrapped onto line 2). */
async function assertColumnGeometry(page: Page) {
  const ta = await box(page, TEXTAREA);
  const attach = await box(page, ATTACH);
  const send = await box(page, SEND);
  const taBottom = ta.y + ta.height;
  expect(attach.y, "attach.top >= textarea.bottom (controls below in column)").toBeGreaterThanOrEqual(taBottom - 1);
  expect(send.y, "send.top >= textarea.bottom (controls below in column)").toBeGreaterThanOrEqual(taBottom - 1);
}

/** pointer-events: each control is the top element at its own center, in whatever mode is active. */
async function assertControlsHittable(page: Page, mode: string) {
  for (const sel of [ATTACH, MIC, STOP, SEND]) {
    const ctl = page.locator(sel);
    await expect(ctl, `${mode}: ${sel} visible`).toBeVisible();
    const isTop = await ctl.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
    });
    expect(isTop, `${mode}: ${sel} center is NOT covered by another element`).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.locator(TEXTAREA).waitFor({ state: "visible" });
  await resetSpies(page);
});

test("1 - EMPTY -> single-row (data-multiline=false, controls beside the textarea)", async ({ page }) => {
  expect(await multiline(page), "empty composer is single-row").toBe("false");
  await assertSingleRowGeometry(page);
});

test("2 - 1 short line -> single-row (still false, still inline)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("hello world!"); // ~12 chars, no newline
  await flush(page);
  expect(await multiline(page), "one short line stays single-row").toBe("false");
  await assertSingleRowGeometry(page);
});

test("3 - newline -> column (data-multiline=true, controls below)", async ({ page }) => {
  await page.locator(TEXTAREA).fill("a\nb");
  await flush(page);
  expect(await multiline(page), "an explicit newline forces column").toBe("true");
  await assertColumnGeometry(page);
});

test("4 - wrap (no newline) -> column (long line wraps narrow -> column)", async ({ page }) => {
  await page.locator(TEXTAREA).fill("The quick brown fox jumps over the lazy dog and then it runs"); // ~59ch, no newline
  await flush(page);
  expect(await multiline(page), "a long wrapping line forces column").toBe("true");
  await assertColumnGeometry(page);
});

test("5 - transition BOTH ways: single -> (newline) column -> (shorten) single", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("hi");
  await flush(page);
  expect(await multiline(page), "starts single").toBe("false");

  await ta.press("Enter");
  await ta.pressSequentially("there");
  await flush(page);
  expect(await multiline(page), "newline -> column").toBe("true");

  await ta.fill("hi"); // short, no newline, len <= 20 -> reverts
  await flush(page);
  expect(await multiline(page), "shorten -> back to single").toBe("false");
  await assertSingleRowGeometry(page);
});

test("6 - NO OSCILLATION: once column while typing, stays column (monotonic, no per-keystroke flicker)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  const long = "the quick brown fox jumps over the lazy dog while running fast"; // ~61ch, no newline
  const states: string[] = [];
  for (const ch of long) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(15); // let React commit the data-multiline flip
    states.push(await multiline(page));
  }
  const firstTrue = states.indexOf("true");
  expect(firstTrue, `crossed into column at some keystroke (states=${states.join("")})`).toBeGreaterThanOrEqual(0);
  const tail = states.slice(firstTrue);
  expect(
    tail.every((s) => s === "true"),
    `column is monotonic after first crossing — no flip back to single while typing (states=${states.join("")})`,
  ).toBe(true);
});

test("7 - NO FOCUS-LOSS / NO REMOUNT on the flip (same textarea instance keeps focus)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  // stamp a probe React does not manage -> survives re-render, vanishes on remount.
  await ta.evaluate((el) => {
    (el as HTMLElement).dataset.probe = "X";
  });
  await ta.pressSequentially("hello there this is a sufficiently long single line to wrap"); // crosses into column
  await flush(page);
  expect(await multiline(page), "crossed into column").toBe("true");

  const activeIsTextarea = await page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") === "mobile-composer-textarea",
  );
  expect(activeIsTextarea, "textarea retained focus across the mode flip").toBe(true);

  const probe = await page.locator(TEXTAREA).evaluate((el) => (el as HTMLElement).dataset.probe);
  expect(probe, "same textarea element instance survived the flip (no remount)").toBe("X");
});

test("8 - POINTER-EVENTS in BOTH modes: +/mic/Stop/Send hittable + actionable", async ({ page }) => {
  const ta = page.locator(TEXTAREA);

  // --- MODE A: single-row (1 short line) ---
  await ta.fill("hello");
  await flush(page);
  expect(await multiline(page), "single-row mode").toBe("false");
  await assertControlsHittable(page, "single-row");
  await resetSpies(page);
  await page.locator(ATTACH).click();
  await page.locator(MIC).click();
  await page.locator(STOP).click();
  let s = await e2e(page);
  expect(s.attachClicks, "single-row: attach (+) handler fired").toBeGreaterThanOrEqual(1);
  expect(s.aborts, "single-row: Stop handler fired").toBe(1);

  // --- MODE B: column (multiline) ---
  await ta.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await flush(page);
  expect(await multiline(page), "column mode").toBe("true");
  await assertControlsHittable(page, "column");
  await resetSpies(page);
  await page.locator(ATTACH).click();
  await page.locator(MIC).click();
  await page.locator(STOP).click();
  s = await e2e(page);
  expect(s.attachClicks, "column: attach (+) handler fired").toBeGreaterThanOrEqual(1);
  expect(s.aborts, "column: Stop handler fired").toBe(1);
});

test("9a - Send tap fires onSend with the typed text, then resets the composer", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("hello world");
  await page.locator(SEND).click();
  await flush(page);

  const s = await e2e(page);
  expect(s.sends.length, "onSend fired exactly once").toBe(1);
  expect(s.sends[0].text, "onSend received the typed text").toBe("hello world");
  await expect(ta, "composer cleared after send").toHaveValue("");
  expect(await multiline(page), "reset returns to single-row").toBe("false");
});

test("9b - Enter inserts a newline and does NOT send (mobile composer contract)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("abc");
  await ta.press("Enter");
  await ta.pressSequentially("def");

  await expect(ta, "Enter inserted a newline").toHaveValue("abc\ndef");
  expect((await e2e(page)).sends.length, "Enter did NOT send").toBe(0);
});

test("9c - textarea caps at ~200px and scrolls past the cap (column, not unbounded growth)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  const many = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a very long draft`).join("\n");
  await ta.fill(many);
  await flush(page);

  expect(await multiline(page), "very long text is column").toBe("true");
  const ch = await clientH(page);
  const sh = await scrollH(page);
  expect(ch, "clientHeight capped near 200px").toBeLessThanOrEqual(206);
  expect(ch, "clientHeight reached the cap region (grew, then clamped)").toBeGreaterThanOrEqual(150);
  expect(sh, "content overflows the cap -> internal scroll engaged").toBeGreaterThan(ch + 40);
});

test("10 - one-shot fill (voice-dictation shape) settles to the SAME height as char-by-char typing (no phantom 'extra enter' rows)", async ({ page }) => {
  // Regression guard for the dictation over-grow bug: voice dictation lands a whole transcript in
  // ONE setText, flipping single-row -> column with NO follow-up keystroke. The pre-fix build
  // measured scrollHeight at the NARROW single-row width and never re-measured after the flip, so
  // the box stayed sized for the narrow width -> too tall for the now-wide column = phantom rows.
  const LONG = "the quick brown fox jumps over the lazy dog while running fast"; // ~61ch -> column
  const ta = page.locator(TEXTAREA);

  // (a) char-by-char typing self-heals: each post-flip keystroke re-runs the [text] auto-grow at
  //     the wide column width, so the final height is correct.
  await ta.click();
  await ta.pressSequentially(LONG);
  await flush(page);
  expect(await multiline(page), "typed long line is column").toBe("true");
  const typedH = await clientH(page);

  // (b) one-shot fill is the dictation shape: whole chunk at once, flip with no follow-up keystroke.
  await ta.fill("");
  await flush(page);
  await ta.fill(LONG);
  await flush(page);
  expect(await multiline(page), "filled long line is column").toBe("true");
  const filledH = await clientH(page);

  // Same text + same column layout => identical natural height. On the regression filledH > typedH
  // (phantom rows); the isMultiline height re-measure makes them equal.
  expect(
    filledH,
    `one-shot fill must not be taller than typed (phantom rows): filled=${filledH} typed=${typedH}`,
  ).toBeLessThanOrEqual(typedH);
});
