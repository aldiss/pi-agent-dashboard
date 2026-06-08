import { describe, it, expect, vi } from "vitest";
import { classifyHeap, createHeapWatchdog } from "../heap-watchdog.js";

const GB = 1024 * 1024 * 1024;

describe("classifyHeap", () => {
  it("is ok well below the warn threshold", () => {
    const s = classifyHeap({ heapUsed: 1 * GB, heapLimit: 8 * GB }, 0.7, 0.85);
    expect(s.level).toBe("ok");
    expect(s.ratio).toBeCloseTo(0.125, 3);
  });

  it("warns at exactly the warn ratio", () => {
    const s = classifyHeap({ heapUsed: 5.6 * GB, heapLimit: 8 * GB }, 0.7, 0.85);
    expect(s.level).toBe("warn"); // 0.70
  });

  it("stays warn between warn and error", () => {
    const s = classifyHeap({ heapUsed: 6.4 * GB, heapLimit: 8 * GB }, 0.7, 0.85);
    expect(s.level).toBe("warn"); // 0.80
  });

  it("errors at exactly the error ratio", () => {
    const s = classifyHeap({ heapUsed: 6.8 * GB, heapLimit: 8 * GB }, 0.7, 0.85);
    expect(s.level).toBe("error"); // 0.85
  });

  it("errors near the cap", () => {
    const s = classifyHeap({ heapUsed: 7.9 * GB, heapLimit: 8 * GB }, 0.7, 0.85);
    expect(s.level).toBe("error");
  });

  it("is ok (not NaN) when the limit is zero", () => {
    const s = classifyHeap({ heapUsed: 1 * GB, heapLimit: 0 }, 0.7, 0.85);
    expect(s.level).toBe("ok");
    expect(s.ratio).toBe(0);
  });
});

describe("createHeapWatchdog.check", () => {
  function harness(heapUsed: number, heapLimit = 8 * GB) {
    const warn = vi.fn();
    const error = vi.fn();
    const wd = createHeapWatchdog({
      readHeap: () => ({ heapUsed, heapLimit }),
      warn,
      error,
    });
    return { wd, warn, error };
  }

  it("does not log when ok", () => {
    const { wd, warn, error } = harness(1 * GB);
    const s = wd.check();
    expect(s.level).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("emits a WARNING in the warn band", () => {
    const { wd, warn, error } = harness(5.7 * GB);
    wd.check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[heap-watchdog]");
    expect(warn.mock.calls[0][0]).toContain("% of V8 cap");
    expect(error).not.toHaveBeenCalled();
  });

  it("emits an ERROR in the error band", () => {
    const { wd, error } = harness(7 * GB);
    wd.check();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("[heap-watchdog]");
  });

  it("warns once per band-entry, not every check (no log spam)", () => {
    const { wd, warn } = harness(5.7 * GB);
    wd.check();
    wd.check();
    wd.check();
    expect(warn).toHaveBeenCalledTimes(1); // stayed in warn band — logged once
  });

  it("re-logs every check while in the error band", () => {
    const { wd, error } = harness(7.5 * GB);
    wd.check();
    wd.check();
    expect(error).toHaveBeenCalledTimes(2); // error re-logs — it is urgent
  });

  it("folds getContext into the log line", () => {
    const warn = vi.fn();
    const wd = createHeapWatchdog({
      readHeap: () => ({ heapUsed: 5.7 * GB, heapLimit: 8 * GB }),
      getContext: () => ({ eventStoreBytes: 12345, eventStoreSessions: 7 }),
      warn,
      error: vi.fn(),
    });
    wd.check();
    expect(warn.mock.calls[0][0]).toContain("eventStoreBytes=12345");
    expect(warn.mock.calls[0][0]).toContain("eventStoreSessions=7");
  });

  it("survives a throwing getContext", () => {
    const warn = vi.fn();
    const wd = createHeapWatchdog({
      readHeap: () => ({ heapUsed: 5.7 * GB, heapLimit: 8 * GB }),
      getContext: () => { throw new Error("boom"); },
      warn,
      error: vi.fn(),
    });
    expect(() => wd.check()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("createHeapWatchdog lifecycle", () => {
  it("polls on the interval and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      let used = 1 * GB;
      const error = vi.fn();
      const wd = createHeapWatchdog({
        intervalMs: 60_000,
        readHeap: () => ({ heapUsed: used, heapLimit: 8 * GB }),
        warn: vi.fn(),
        error,
      });
      wd.start();
      used = 7 * GB; // climb into error band
      vi.advanceTimersByTime(60_000);
      expect(error).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(error).toHaveBeenCalledTimes(2);
      wd.stop();
      vi.advanceTimersByTime(180_000);
      expect(error).toHaveBeenCalledTimes(2); // no more ticks after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("start is idempotent (no double timer)", () => {
    vi.useFakeTimers();
    try {
      const error = vi.fn();
      const wd = createHeapWatchdog({
        intervalMs: 60_000,
        readHeap: () => ({ heapUsed: 7 * GB, heapLimit: 8 * GB }),
        warn: vi.fn(),
        error,
      });
      wd.start();
      wd.start(); // second start must be a no-op
      vi.advanceTimersByTime(60_000);
      expect(error).toHaveBeenCalledTimes(1); // one tick, not two
      wd.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop without start is a no-op", () => {
    const wd = createHeapWatchdog({ readHeap: () => ({ heapUsed: 0, heapLimit: 8 * GB }) });
    expect(() => wd.stop()).not.toThrow();
  });
});
