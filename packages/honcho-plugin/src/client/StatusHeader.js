import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const STATE_COLORS = {
    connected: "text-green-400",
    running: "text-green-400",
    configured: "text-blue-400",
    syncing: "text-yellow-400",
    starting: "text-yellow-400",
    stopped: "text-[var(--text-muted)]",
    offline: "text-red-400",
    "docker-missing": "text-red-400",
    "port-conflict": "text-red-400",
    uninstalled: "text-[var(--text-muted)]",
};
export function StatusHeader({ status, config, }) {
    const state = status?.state ?? "unknown";
    const mode = status?.mode ?? config.mode ?? "cloud";
    const endpoint = status?.endpoint ?? config.hosts?.pi?.endpoint ?? "honcho.dev";
    const cacheChars = status?.cacheChars ?? 0;
    const sessionKey = status?.sessionKey ?? null;
    return (_jsxs("div", { className: "flex flex-wrap gap-x-4 gap-y-1 text-xs border-b border-[var(--border)] pb-2 mb-2", children: [_jsxs("span", { className: "text-[var(--text-muted)]", children: ["Mode: ", _jsx("span", { className: "text-[var(--text)]", children: mode })] }), _jsxs("span", { className: "text-[var(--text-muted)]", children: ["State:", " ", _jsx("span", { className: STATE_COLORS[state] ?? "text-[var(--text)]", children: state })] }), _jsxs("span", { className: "text-[var(--text-muted)]", children: ["Endpoint: ", _jsx("span", { className: "text-[var(--text)] font-mono", children: endpoint })] }), _jsxs("span", { className: "text-[var(--text-muted)]", children: ["Cache: ", _jsxs("span", { className: "text-[var(--text)]", children: [cacheChars.toLocaleString(), " chars"] })] }), sessionKey && (_jsxs("span", { className: "text-[var(--text-muted)]", children: ["Session: ", _jsx("span", { className: "text-[var(--text)] font-mono", children: sessionKey })] }))] }));
}
//# sourceMappingURL=StatusHeader.js.map