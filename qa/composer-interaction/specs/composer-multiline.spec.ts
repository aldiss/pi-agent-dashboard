import { test, expect, type Page } from "@playwright/test";

/**
 * Real interaction e2e for the ChatGPT-style multiline mobile composer (column layout).
 * Drives a live Chromium against the isolated harness — types, taps, asserts handler-fire +
 * geometry. Regression guard against the single-row -> column restructure.
 */

const HARNESS = "/__e2e__/composer-harness.html";
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

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.locator(TEXTAREA).waitFor({ state: "visible" });
  await page.evaluate(() => {
    window.__e2e = { sends: [], aborts: 0, attachClicks: 0 };
  });
});

test("1 - textarea grows downward as the user types multiline (controls stay put)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await flush(page);
  const hEmpty = await clientH(page);
  await ta.pressSequentially("Line one of the draft message");
  await flush(page);
  const h1 = await clientH(page);
  await ta.pressSequentially("\nSecond line\nThird line");
  await flush(page);
  const h3 = await clientH(page);

  expect(hEmpty, "empty composer stays compact (~36px floor)").toBeLessThanOrEqual(40);
  expect(h3, "textarea grew taller as lines were added").toBeGreaterThan(h1 + 10);
  await expect(page.locator(SEND), "Send not pushed off when text grows").toBeVisible();
  await expect(page.locator(ATTACH), "Attach not pushed off when text grows").toBeVisible();
});

test("2 - textarea caps at ~200px and scrolls past the cap (not unbounded growth)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  const many = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a very long draft`).join("\n");
  await ta.fill(many);
  await flush(page);

  const ch = await clientH(page);
  const sh = await scrollH(page);
  expect(ch, "clientHeight capped near 200px").toBeLessThanOrEqual(206);
  expect(ch, "clientHeight reached the cap region (grew, then clamped)").toBeGreaterThanOrEqual(150);
  expect(sh, "content overflows the cap -> internal scroll engaged").toBeGreaterThan(ch + 40);
});

test("3 - Send tap fires onSend with the typed text, then resets the composer", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("hello world");
  await page.locator(SEND).click();
  await flush(page);

  const s = await e2e(page);
  expect(s.sends.length, "onSend fired exactly once").toBe(1);
  expect(s.sends[0].text, "onSend received the typed text").toBe("hello world");
  await expect(ta, "composer cleared after send").toHaveValue("");
});

test("4 - POINTER-EVENTS: full-width text row does NOT intercept taps for +/mic/Stop/Send", async ({ page }) => {
  // Fill to max height so the text row sits at its tallest, directly above the controls row —
  // the exact condition where a single-row->column restructure could let the text overlap the
  // controls and steal their taps.
  const ta = page.locator(TEXTAREA);
  await ta.fill(Array.from({ length: 24 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await flush(page);

  // (a) explicit hit-test — each control must be the top element at its own center.
  for (const sel of [ATTACH, MIC, STOP, SEND]) {
    const ctl = page.locator(sel);
    await expect(ctl, `${sel} visible`).toBeVisible();
    const isTop = await ctl.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
    });
    expect(isTop, `${sel} center is NOT covered by the text row`).toBe(true);
  }

  // (b) actionability — Playwright .click() throws if pointer events are intercepted.
  await page.locator(ATTACH).click();
  await page.locator(MIC).click();
  await page.locator(STOP).click();

  const s = await e2e(page);
  expect(s.attachClicks, "attach (+) handler fired on tap").toBeGreaterThanOrEqual(1);
  expect(s.aborts, "Stop handler fired on tap").toBe(1);
});

test("5 - Enter inserts a newline and does NOT send (mobile composer contract)", async ({ page }) => {
  const ta = page.locator(TEXTAREA);
  await ta.click();
  await ta.pressSequentially("abc");
  await ta.press("Enter");
  await ta.pressSequentially("def");

  await expect(ta, "Enter inserted a newline").toHaveValue("abc\ndef");
  expect((await e2e(page)).sends.length, "Enter did NOT send").toBe(0);
});
