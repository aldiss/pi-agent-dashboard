/**
 * model-proxy second-port fail-loud (Stage-3 X4) — own-hand verification.
 *
 * Pre-fix (RED): the 2nd-port bind failure was swallowed by
 *   catch (err) { console.warn("Model proxy second port bind failed (continuing without):", err); }
 * so an ENABLED proxy that couldn't bind was SILENTLY dead — a suppressed failure.
 *
 * The fix (startModelProxySecondPort): reclaim-on-start the 2nd port, and on a genuine
 * conflict surface it LOUD (console.error) + mark /api/health.proxySecondPort DEGRADED,
 * never a buried warn — WITHOUT crashing the healthy main server (optional subsystem).
 */
import { describe, it, expect, vi } from "vitest";
import {
  startModelProxySecondPort,
  getModelProxySecondPortStatus,
  setModelProxySecondPortStatus,
} from "../model-proxy-second-port.js";

describe("model-proxy second port (X4 fail-loud)", () => {
  it("happy path — reclaim + listen succeed → listening + status listening", async () => {
    setModelProxySecondPortStatus({ status: "disabled" });
    const reclaim = vi.fn(async () => []);
    const listen = vi.fn(async () => {});
    const log = vi.fn();
    const errorLog = vi.fn();

    const r = await startModelProxySecondPort(8788, { reclaim, listen, log, errorLog });

    expect(r).toBe("listening");
    expect(reclaim).toHaveBeenCalledWith([8788]); // reclaim-on-start the 2nd port (Stage-2 reuse)
    expect(listen).toHaveBeenCalledOnce();
    expect(getModelProxySecondPortStatus()).toEqual({ status: "listening", port: 8788 });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("THE FIX — reclaim leaves the port held (conflict) → FAIL-LOUD degraded, no throw, no silent continue", async () => {
    setModelProxySecondPortStatus({ status: "disabled" });
    const reclaim = vi.fn(async () => {
      throw new Error(":8788 STILL held after reclaim — refusing to bind (fail loud)");
    });
    const listen = vi.fn(async () => {});
    const errorLog = vi.fn();

    // Must NOT throw upward — the healthy main server is untouched.
    const r = await startModelProxySecondPort(8788, { reclaim, listen, errorLog });

    expect(r).toBe("failed"); // surfaced, not swallowed
    expect(listen).not.toHaveBeenCalled(); // never attempted the bind
    const st = getModelProxySecondPortStatus();
    expect(st.status).toBe("failed");
    expect(st).toMatchObject({ port: 8788 });
    expect("reason" in st && st.reason).toContain("STILL held");
    // LOUD (error, not warn) and NOT the old buried "continuing without".
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]![0]).toContain("FAIL-LOUD");
    expect(errorLog.mock.calls[0]![0]).not.toContain("continuing without");
  });

  it("listen conflict after a clean reclaim (race) → FAIL-LOUD degraded", async () => {
    setModelProxySecondPortStatus({ status: "disabled" });
    const reclaim = vi.fn(async () => []); // reclaim frees it...
    const listen = vi.fn(async () => {
      throw new Error("listen EADDRINUSE 127.0.0.1:8788"); // ...but someone grabbed it first
    });
    const errorLog = vi.fn();

    const r = await startModelProxySecondPort(8788, { reclaim, listen, errorLog });

    expect(r).toBe("failed");
    expect(getModelProxySecondPortStatus()).toMatchObject({ status: "failed", port: 8788 });
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("degrade-clean when disabled — status stays disabled (caller gate skips the bind)", () => {
    setModelProxySecondPortStatus({ status: "disabled" });
    // server.ts gate `if (proxyCfg.enabled && proxyCfg.secondPort)` never calls us.
    expect(getModelProxySecondPortStatus()).toEqual({ status: "disabled" });
  });
});
