import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Connection section — apiKey, peerName, workspace, aiPeer, endpoint, linkedHosts, sessionStrategy.
 * Task 6.5.
 */
import { useState, useEffect } from "react";
const SESSION_STRATEGIES = [
    "per-directory",
    "git-branch",
    "pi-session",
    "per-repo",
    "global",
];
export function ConnectionSection({ config, onSave, saving }) {
    const [apiKey, setApiKey] = useState("");
    const [showKey, setShowKey] = useState(false);
    const [peerName, setPeerName] = useState(config.peerName ?? "");
    const [workspace, setWorkspace] = useState(config.workspace ?? "");
    const [aiPeer, setAiPeer] = useState(config.aiPeer ?? "");
    const [endpoint, setEndpoint] = useState(config.hosts?.pi?.endpoint ?? "");
    const [linkedHosts, setLinkedHosts] = useState(config.linkedHosts ?? "");
    const [sessionStrategy, setSessionStrategy] = useState(config.hosts?.pi?.sessionStrategy ?? "per-directory");
    // Sync from config on refresh
    useEffect(() => {
        setPeerName(config.peerName ?? "");
        setWorkspace(config.workspace ?? "");
        setAiPeer(config.aiPeer ?? "");
        setEndpoint(config.hosts?.pi?.endpoint ?? "");
        setLinkedHosts(config.linkedHosts ?? "");
        setSessionStrategy(config.hosts?.pi?.sessionStrategy ?? "per-directory");
    }, [config]);
    const handleSave = () => {
        const partial = {
            peerName,
            workspace,
            aiPeer,
            linkedHosts,
            hosts: {
                pi: {
                    endpoint,
                    sessionStrategy,
                },
            },
        };
        // Only send apiKey if the user typed a new one
        if (apiKey) {
            partial.apiKey = apiKey;
        }
        onSave(partial);
    };
    return (_jsxs("fieldset", { className: "space-y-2", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Connection" }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "API Key" }), _jsx("input", { type: showKey ? "text" : "password", value: apiKey, onChange: (e) => setApiKey(e.target.value), placeholder: config.apiKeySet ? config.apiKeyMasked ?? "••••" : "Not set", className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono" }), _jsx("button", { onClick: () => setShowKey(!showKey), className: "text-[var(--text-muted)] hover:text-[var(--text)] text-xs", children: showKey ? "Hide" : "Show" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "Peer Name" }), _jsx("input", { type: "text", value: peerName, onChange: (e) => setPeerName(e.target.value), className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "Workspace" }), _jsx("input", { type: "text", value: workspace, onChange: (e) => setWorkspace(e.target.value), className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "AI Peer" }), _jsx("input", { type: "text", value: aiPeer, onChange: (e) => setAiPeer(e.target.value), className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "Endpoint" }), _jsx("input", { type: "text", value: endpoint, onChange: (e) => setEndpoint(e.target.value), placeholder: "https://api.honcho.dev", className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "Linked Hosts" }), _jsx("input", { type: "text", value: linkedHosts, onChange: (e) => setLinkedHosts(e.target.value), placeholder: "host1, host2", className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-28 text-[var(--text-muted)]", children: "Session Strategy" }), _jsx("select", { value: sessionStrategy, onChange: (e) => setSessionStrategy(e.target.value), className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs", children: SESSION_STRATEGIES.map((s) => (_jsx("option", { value: s, children: s }, s))) })] }), _jsx("button", { onClick: handleSave, disabled: saving, className: "text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50", children: saving ? "Saving…" : "Save Connection" })] }));
}
//# sourceMappingURL=ConnectionSection.js.map