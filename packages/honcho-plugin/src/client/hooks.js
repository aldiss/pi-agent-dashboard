/**
 * Shared hooks for honcho plugin client components.
 */
import { useState, useEffect, useCallback } from "react";
import { fetchConfig, fetchStatus, checkExtensionInstalled } from "./api.js";
/** Poll-based config fetcher. Refreshes on `deps` change or manual trigger. */
export function useHonchoConfig() {
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const refresh = useCallback(async () => {
        try {
            const cfg = await fetchConfig();
            setConfig(cfg);
            setError(null);
        }
        catch (e) {
            setError(e.message ?? "Failed to load config");
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        refresh();
    }, [refresh]);
    return { config, loading, error, refresh };
}
/** Fetch plugin status once. */
export function useHonchoStatus() {
    const [status, setStatus] = useState(null);
    const refresh = useCallback(async () => {
        try {
            setStatus(await fetchStatus());
        }
        catch {
            /* ignore */
        }
    }, []);
    useEffect(() => {
        refresh();
    }, [refresh]);
    return { status, refresh };
}
/** Check if pi-memory-honcho extension is installed. */
export function useExtensionInstalled() {
    const [installed, setInstalled] = useState(null);
    const [checking, setChecking] = useState(true);
    const check = useCallback(async () => {
        setChecking(true);
        try {
            setInstalled(await checkExtensionInstalled());
        }
        catch {
            setInstalled(false);
        }
        finally {
            setChecking(false);
        }
    }, []);
    useEffect(() => {
        check();
    }, [check]);
    return { installed, checking, recheck: check };
}
//# sourceMappingURL=hooks.js.map