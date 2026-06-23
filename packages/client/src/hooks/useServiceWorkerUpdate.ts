import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useServiceWorkerUpdate — surfaces the "a new service worker is waiting" signal
 * to the UI and drives the skip-waiting → reload handoff on demand.
 *
 * Why this exists (the bug it fixes): public/sw.js used to call
 * `self.skipWaiting()` inside its own install handler, so a new SW silently took
 * over the controller mid-session. The already-loaded client kept running its
 * OLD in-memory bundle while the SW served NEW cached assets — the operator saw
 * a stale/half-updated app until a manual cache-clear. The SW now PARKS in the
 * `waiting` state instead; this hook notices that, the app shows an "Update
 * ready" pill, and only when the operator taps it do we post {type:"SKIP_WAITING"}
 * and reload onto the fresh SW. Visible, opt-in, never yanks assets mid-task.
 *
 * Lifecycle wiring:
 *   - The SW is registered once in main.tsx. This hook ACQUIRES that
 *     registration (getRegistration, falling back to `.ready`) — it never
 *     double-registers.
 *   - `reg.waiting` already set  → update is ready right now.
 *   - `updatefound` → the installing worker's `statechange` to `installed`
 *     WHILE a controller already exists → update is ready (a fresh first
 *     install has no prior controller, so it does NOT trip the pill).
 *   - `applyUpdate()` posts SKIP_WAITING to the waiting worker and reloads the
 *     page exactly once, on the `controllerchange` that the new SW's activation
 *     fires. A guard ref ensures the first-install `clients.claim()`
 *     controllerchange (which fires with no prior controller) never triggers a
 *     spurious reload.
 *   - On `visibilitychange → visible` we call `reg.update()` so a backgrounded
 *     installed PWA (the iOS home-screen case — it can stay in memory for days)
 *     actually re-checks for a new sw.js when the operator reopens it.
 */
export interface ServiceWorkerUpdate {
  /** True once a new SW is installed and waiting to take over. */
  updateReady: boolean;
  /** Skip-waiting the waiting SW and reload onto it. No-op if none waiting. */
  applyUpdate: () => void;
}

export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
  const [updateReady, setUpdateReady] = useState(false);
  const waitingRef = useRef<ServiceWorker | null>(null);
  // Set true the instant WE initiate the skip-waiting handoff, so the
  // controllerchange listener only reloads for an operator-driven update —
  // never for the first-install clients.claim() controllerchange.
  const applyingRef = useRef(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    let cancelled = false;

    const markWaiting = (worker: ServiceWorker | null) => {
      if (cancelled || !worker) return;
      waitingRef.current = worker;
      setUpdateReady(true);
    };

    // A worker is an UPDATE (not a first install) only when something already
    // controls the page. Without this guard the very first install would trip
    // the pill on a brand-new visit.
    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          markWaiting(worker);
        }
      });
    };

    const attach = (reg: ServiceWorkerRegistration) => {
      if (cancelled) return;
      // Already waiting (installed before this hook mounted, e.g. page open
      // across a deploy).
      if (reg.waiting && navigator.serviceWorker.controller) {
        markWaiting(reg.waiting);
      }
      // Currently installing — watch it cross into `installed`.
      trackInstalling(reg.installing);
      // Future updates discovered while the page stays open.
      reg.addEventListener("updatefound", () => trackInstalling(reg.installing));

      // Re-check for a new sw.js whenever the app is foregrounded. Critical for
      // the installed iOS PWA, which is reopened (not cold-loaded) for days.
      const onVisible = () => {
        if (document.visibilityState === "visible") {
          reg.update().catch(() => { /* offline / transient — ignore */ });
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      visibilityCleanup = () => document.removeEventListener("visibilitychange", onVisible);
    };

    let visibilityCleanup: (() => void) | null = null;

    // Acquire the registration created in main.tsx. getRegistration resolves
    // immediately if one exists; `.ready` is the fallback (resolves once a SW is
    // active) so we are robust to the main.tsx register() still being in flight.
    (async () => {
      try {
        const reg =
          (await navigator.serviceWorker.getRegistration()) ??
          (await navigator.serviceWorker.ready);
        if (reg) attach(reg);
      } catch {
        /* SW unsupported / blocked — no update flow, app still works. */
      }
    })();

    // Single reliable reload signal: the new SW activating swaps the controller.
    const onControllerChange = () => {
      if (applyingRef.current) {
        applyingRef.current = false;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (visibilityCleanup) visibilityCleanup();
    };
  }, []);

  const applyUpdate = useCallback(() => {
    const waiting = waitingRef.current;
    if (!waiting) return;
    applyingRef.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    // The reload happens in the controllerchange handler once the new SW
    // activates. We do NOT reload here — reloading before activation would just
    // re-serve the old controller.
  }, []);

  return { updateReady, applyUpdate };
}
