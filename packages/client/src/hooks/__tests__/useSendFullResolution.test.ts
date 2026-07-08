import { describe, it, expect, beforeEach } from "vitest";
import {
  getSendFullResolution,
  setSendFullResolution,
} from "../useSendFullResolution.js";

const STORAGE_KEY = "dashboard:send-full-resolution";

beforeEach(() => {
  localStorage.clear();
  // The module reads localStorage once at import; reset the in-memory value to a
  // known default so tests don't leak state into each other.
  setSendFullResolution(false);
  localStorage.clear();
});

describe("useSendFullResolution store", () => {
  it("defaults to false", () => {
    expect(getSendFullResolution()).toBe(false);
  });

  it("setSendFullResolution(true) persists 'true' and reads back true", () => {
    setSendFullResolution(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(getSendFullResolution()).toBe(true);
  });

  it("resets back to false", () => {
    setSendFullResolution(true);
    setSendFullResolution(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(getSendFullResolution()).toBe(false);
  });
});
