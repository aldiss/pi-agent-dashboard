/**
 * Lightweight package install hook for the honcho plugin.
 *
 * Uses the dashboard's existing WebSocket progress channel:
 *   1. POST /api/packages/install → 202 + operationId
 *   2. Server broadcasts `package_progress` events via WS
 *   3. Client dispatches as `pi-package-event` CustomEvent on window
 *   4. This hook listens for events matching our operationId/source
 *   5. On `package_operation_complete`, reports success/failure
 *
 * Does NOT import from the dashboard client package (avoids circular dep).
 */
import { useState, useEffect, useRef, useCallback } from "react";
export function usePackageInstall() {
    const [state, setState] = useState({
        phase: "idle",
        message: "",
        error: null,
    });
    const operationIdRef = useRef(null);
    const sourceRef = useRef(null);
    // Listen for package events on window
    useEffect(() => {
        function onEvent(e) {
            const msg = e.detail;
            if (!msg)
                return;
            // Match by operationId first, fall back to source (race window)
            const matchesOp = operationIdRef.current && msg.operationId === operationIdRef.current;
            const matchesSource = !operationIdRef.current &&
                sourceRef.current &&
                (msg.event?.source === sourceRef.current || msg.source === sourceRef.current);
            if (!matchesOp && !matchesSource)
                return;
            // Capture operationId from first matching event if we don't have it yet
            if (!operationIdRef.current && msg.operationId) {
                operationIdRef.current = msg.operationId;
            }
            if (msg.type === "package_progress") {
                setState({
                    phase: "installing",
                    message: msg.event?.message ?? `${msg.event?.action ?? "install"}: ${msg.event?.type ?? "working"}`,
                    error: null,
                });
            }
            if (msg.type === "package_operation_complete") {
                if (msg.success) {
                    setState({
                        phase: "success",
                        message: "Installed successfully",
                        error: null,
                    });
                }
                else {
                    setState({
                        phase: "error",
                        message: "",
                        error: msg.error ?? "Installation failed",
                    });
                }
                operationIdRef.current = null;
                sourceRef.current = null;
            }
        }
        window.addEventListener("pi-package-event", onEvent);
        return () => window.removeEventListener("pi-package-event", onEvent);
    }, []);
    const install = useCallback(async (source) => {
        sourceRef.current = source;
        operationIdRef.current = null;
        setState({ phase: "installing", message: "Starting install…", error: null });
        try {
            const res = await fetch("/api/packages/install", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source, scope: "global" }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                // 409 means another operation is in flight
                if (res.status === 409) {
                    setState({
                        phase: "error",
                        message: "",
                        error: "Another package operation is in progress. Try again shortly.",
                    });
                    return;
                }
                setState({
                    phase: "error",
                    message: "",
                    error: `Install failed: ${res.status} ${body}`,
                });
                return;
            }
            const data = await res.json();
            if (data.data?.operationId) {
                operationIdRef.current = data.data.operationId;
            }
            // Phase stays "installing" — progress events will update the message
        }
        catch (e) {
            setState({
                phase: "error",
                message: "",
                error: e.message ?? "Install request failed",
            });
        }
    }, []);
    const reset = useCallback(() => {
        setState({ phase: "idle", message: "", error: null });
        operationIdRef.current = null;
        sourceRef.current = null;
    }, []);
    return { ...state, install, reset };
}
//# sourceMappingURL=usePackageInstall.js.map