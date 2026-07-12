import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Server section (self-host only) — start/stop/restart, autoStart, ports, storageBackend.
 * Task 6.8.
 */
import { useState, useEffect } from "react";
import Icon from "@mdi/react";
import { mdiAlert, mdiPlay, mdiStop, mdiRestart } from "@mdi/js";
import { serverStart, serverStop, serverRestart } from "./api.js";
const BACKEND_OPTIONS = [
    { value: "host-directory", label: "Host directory (~/.pi-dashboard/honcho/pgdata/)" },
    { value: "docker-volume", label: "Docker volume" },
    { value: "loop-image", label: "Loop image", disabled: true, note: "(coming in v0.3 — Linux only)" },
];
const STATE_PILLS = {
    running: { label: "Running", cls: "bg-green-700 text-green-200" },
    starting: { label: "Starting…", cls: "bg-yellow-700 text-yellow-200" },
    stopped: { label: "Stopped", cls: "bg-gray-700 text-gray-300" },
    "docker-missing": { label: "Docker missing", cls: "bg-red-700 text-red-200" },
    "port-conflict": { label: "Port conflict", cls: "bg-red-700 text-red-200" },
    offline: { label: "Offline", cls: "bg-red-700 text-red-200" },
};
export function ServerSection({ config, status, onSave, saving, onRefreshStatus }) {
    const selfHost = config.selfHost ?? {};
    const [autoStart, setAutoStart] = useState(selfHost.autoStart !== false);
    const [apiPort, setApiPort] = useState(String(selfHost.apiPort ?? 8765));
    const [dbPort, setDbPort] = useState(String(selfHost.dbPort ?? 5455));
    const [backend, setBackend] = useState(selfHost.storageBackend ?? "host-directory");
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    useEffect(() => {
        setAutoStart(selfHost.autoStart !== false);
        setApiPort(String(selfHost.apiPort ?? 8765));
        setDbPort(String(selfHost.dbPort ?? 5455));
        setBackend(selfHost.storageBackend ?? "host-directory");
    }, [config]);
    const doAction = async (action) => {
        setBusy(true);
        setActionError(null);
        try {
            const fns = { start: serverStart, stop: serverStop, restart: serverRestart };
            const result = await fns[action]();
            if (!result.ok)
                setActionError(result.error ?? `${action} failed`);
        }
        catch (e) {
            setActionError(e.message ?? `${action} failed`);
        }
        finally {
            setBusy(false);
            onRefreshStatus();
        }
    };
    const handleSaveServer = () => {
        onSave({
            selfHost: {
                autoStart,
                apiPort: parseInt(apiPort, 10) || 8765,
                dbPort: parseInt(dbPort, 10) || 5455,
                storageBackend: backend,
            },
        });
    };
    const state = status?.state ?? "stopped";
    const pill = STATE_PILLS[state] ?? { label: state, cls: "bg-gray-700 text-gray-300" };
    return (_jsxs("fieldset", { className: "space-y-2", children: [_jsxs("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2", children: ["Server", _jsx("span", { className: `text-[10px] px-1.5 py-0.5 rounded-full ${pill.cls}`, children: pill.label })] }), _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => doAction("start"), disabled: busy || state === "running" || state === "starting", className: "text-xs px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-white disabled:opacity-50 inline-flex items-center gap-1", children: [_jsx(Icon, { path: mdiPlay, size: 0.5 }), "Start"] }), _jsxs("button", { onClick: () => doAction("stop"), disabled: busy || state === "stopped", className: "text-xs px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-white disabled:opacity-50 inline-flex items-center gap-1", children: [_jsx(Icon, { path: mdiStop, size: 0.5 }), "Stop"] }), _jsxs("button", { onClick: () => doAction("restart"), disabled: busy || state === "stopped", className: "text-xs px-2 py-1 rounded bg-yellow-700 hover:bg-yellow-600 text-white disabled:opacity-50 inline-flex items-center gap-1", children: [_jsx(Icon, { path: mdiRestart, size: 0.5 }), "Restart"] })] }), actionError && (_jsx("div", { className: "text-red-400 text-xs", children: actionError })), status?.lastError && (_jsx("div", { className: "text-red-400 text-xs bg-red-900/20 rounded px-2 py-1", children: status.lastError })), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("input", { type: "checkbox", checked: autoStart, onChange: (e) => setAutoStart(e.target.checked), className: "accent-blue-500" }), _jsx("span", { className: "text-[var(--text)]", children: "Auto-start on dashboard launch" })] }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "API Port" }), _jsx("input", { type: "number", value: apiPort, onChange: (e) => setApiPort(e.target.value), className: "w-20 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "DB Port" }), _jsx("input", { type: "number", value: dbPort, onChange: (e) => setDbPort(e.target.value), className: "w-20 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] })] }), _jsx("p", { className: "text-[10px] text-[var(--text-muted)]", children: "Defaults 8765/5455 \u2014 changed from upstream 8000/5432 to avoid collisions with pi-dashboard and local Postgres." }), _jsxs("div", { className: "space-y-1", children: [_jsx("span", { className: "text-xs text-[var(--text-muted)]", children: "Storage Backend" }), BACKEND_OPTIONS.map((opt) => (_jsxs("label", { className: "flex items-center gap-1 text-xs cursor-pointer", children: [_jsx("input", { type: "radio", name: "storageBackend", value: opt.value, checked: backend === opt.value, onChange: () => !opt.disabled && setBackend(opt.value), disabled: opt.disabled, className: "accent-blue-500" }), _jsxs("span", { className: opt.disabled ? "text-[var(--text-muted)] opacity-50" : "text-[var(--text)]", children: [opt.label, opt.note && _jsx("span", { className: "text-[var(--text-muted)] ml-1", children: opt.note })] })] }, opt.value))), backend === "host-directory" && (_jsxs("p", { className: "text-[10px] text-yellow-500 ml-4 inline-flex items-start gap-1", children: [_jsx(Icon, { path: mdiAlert, size: 0.4, style: { flexShrink: 0, marginTop: 1 } }), _jsx("span", { children: "~10-25% slower on macOS/Windows due to Docker bind-mount translation. Switch to Docker volume for better perf." })] }))] }), _jsx("button", { onClick: handleSaveServer, disabled: saving, className: "text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50", children: saving ? "Saving…" : "Save Server Settings" })] }));
}
//# sourceMappingURL=ServerSection.js.map