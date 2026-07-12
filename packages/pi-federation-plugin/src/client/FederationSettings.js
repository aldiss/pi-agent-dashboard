import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * FederationSettings — settings-section panel for the federation plugin.
 *
 * Reads + writes plugin config via usePluginConfig + plugin_config_write.
 * Surfaces:
 *   - This machine's id (auto-fills from os.hostname() server-side if blank)
 *   - List of peers (host / port / machineId / label)
 *   - Add-peer + remove-peer affordances
 *   - mDNS LAN-shortcut toggle
 *   - Auth mode (loopback-trusted-networks vs shared-secret-jwt + secret)
 *   - Live peer connection status (polled from /api/federation/peers)
 *
 * Phase 4 minimal implementation per investigator #1 §6.3 + §7.1 #5
 * (write only to plugins.federation.* keyspace) + §7.1 #6 (treat
 * plugin_config_update broadcast as source of truth).
 */
import { useCallback, useEffect, useState } from "react";
import { usePluginConfig, usePluginSend, } from "@blackbelt-technology/dashboard-plugin-runtime/context";
const DEFAULT_PORT = 8000;
export function FederationSettings() {
    const config = usePluginConfig();
    const send = usePluginSend();
    const [machineId, setMachineId] = useState(config.machineId ?? "");
    const [peers, setPeers] = useState(config.peers ?? []);
    const [discoverLan, setDiscoverLan] = useState(config.discoverLan ?? true);
    const [authMode, setAuthMode] = useState(config.authMode ?? "loopback-trusted-networks");
    const [sharedSecret, setSharedSecret] = useState(config.sharedAuthSecret ?? "");
    const [savedAt, setSavedAt] = useState(null);
    // Add-peer form
    const [newHost, setNewHost] = useState("");
    const [newPort, setNewPort] = useState(DEFAULT_PORT);
    const [newMachineId, setNewMachineId] = useState("");
    const [newLabel, setNewLabel] = useState("");
    // Live peer status (polled)
    const [status, setStatus] = useState([]);
    useEffect(() => {
        let alive = true;
        const fetchStatus = async () => {
            try {
                const resp = await fetch("/api/federation/peers");
                if (!resp.ok)
                    return;
                const json = (await resp.json());
                if (alive && json.success && json.data)
                    setStatus(json.data);
            }
            catch { /* network blip; next tick will retry */ }
        };
        void fetchStatus();
        const t = setInterval(fetchStatus, 3000);
        return () => { alive = false; clearInterval(t); };
    }, []);
    const onAddPeer = useCallback(() => {
        if (!newHost.trim() || !newMachineId.trim())
            return;
        const peer = {
            host: newHost.trim(),
            port: Number(newPort) || DEFAULT_PORT,
            machineId: newMachineId.trim(),
            ...(newLabel.trim() ? { label: newLabel.trim() } : {}),
        };
        setPeers((prev) => {
            // Replace existing peer with same machineId
            const filtered = prev.filter((p) => p.machineId !== peer.machineId);
            return [...filtered, peer];
        });
        setNewHost("");
        setNewMachineId("");
        setNewLabel("");
    }, [newHost, newPort, newMachineId, newLabel]);
    const onRemovePeer = useCallback((machineId) => {
        setPeers((prev) => prev.filter((p) => p.machineId !== machineId));
    }, []);
    const onSave = useCallback(() => {
        send({
            type: "plugin_config_write",
            id: "federation",
            config: {
                machineId,
                peers,
                discoverLan,
                authMode,
                sharedAuthSecret: sharedSecret,
            },
        });
        setSavedAt(Date.now());
    }, [machineId, peers, discoverLan, authMode, sharedSecret, send]);
    const stateColor = (st) => {
        switch (st) {
            case "open": return "#4a9a4a";
            case "connecting":
            case "reconnecting": return "#daa520";
            case "closed": return "#888";
            default: return "#aa4a4a";
        }
    };
    return (_jsxs("section", { className: "border border-[var(--border-secondary)] rounded-lg p-4 space-y-3", "data-testid": "federation-plugin-settings", children: [_jsxs("header", { children: [_jsx("h3", { className: "text-sm font-semibold text-[var(--text-primary)]", children: "Federation (cross-machine sessions)" }), _jsx("p", { className: "text-xs text-[var(--text-secondary)]", children: "Aggregate sessions across pi-dashboard instances on your Tailnet. Per Schema 7 \u00A73.5 (option E) \u2014 WebSocket-over-Tailscale + mDNS LAN-shortcut." })] }), _jsxs("label", { className: "block text-xs text-[var(--text-secondary)]", children: [_jsx("span", { className: "block mb-0.5", children: "This machine's id (used as prefix when peers federate back)" }), _jsx("input", { type: "text", value: machineId, onChange: (e) => setMachineId(e.target.value), placeholder: "imac / macbook / win \u2014 auto-fills from hostname if blank", className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-full", "data-testid": "federation-machine-id" })] }), _jsxs("div", { children: [_jsx("h4", { className: "text-xs font-semibold text-[var(--text-primary)] mb-1", children: "Peers" }), peers.length === 0 && (_jsx("p", { className: "text-[10px] text-[var(--text-secondary)] italic", children: "No peers configured. Add one below." })), _jsx("ul", { className: "space-y-1", "data-testid": "federation-peers", children: peers.map((peer) => {
                            const liveStatus = status.find((s) => s.machineId === peer.machineId);
                            return (_jsxs("li", { className: "flex items-center justify-between text-xs border border-[var(--border-secondary)] rounded px-2 py-1", "data-testid": `federation-peer-${peer.machineId}`, children: [_jsxs("span", { className: "font-mono", children: [_jsx("span", { style: { color: stateColor(liveStatus?.state ?? "idle") }, children: "\u25CF" }), " ", peer.label ? _jsx("strong", { children: peer.label }) : null, " ", _jsx("code", { children: peer.machineId }), " ", _jsxs("span", { className: "text-[var(--text-secondary)]", children: [peer.host, ":", peer.port, liveStatus && liveStatus.effectiveHost !== peer.host
                                                        ? ` (active: ${liveStatus.effectiveHost})`
                                                        : ""] }), liveStatus && (_jsxs("span", { className: "text-[10px] text-[var(--text-secondary)] ml-2", children: [liveStatus.state, " \u00B7 ", liveStatus.knownSessionCount, " session(s)"] }))] }), _jsx("button", { type: "button", onClick: () => onRemovePeer(peer.machineId), className: "text-[10px] px-2 py-0.5 rounded border border-[var(--border-secondary)] hover:bg-[var(--bg-tertiary)]", "data-testid": `federation-remove-${peer.machineId}`, children: "remove" })] }, peer.machineId));
                        }) })] }), _jsxs("div", { className: "border border-dashed border-[var(--border-secondary)] rounded p-2 space-y-1", children: [_jsx("h4", { className: "text-xs font-semibold text-[var(--text-primary)]", children: "Add peer" }), _jsxs("div", { className: "flex gap-1 items-center text-xs", children: [_jsx("input", { type: "text", placeholder: "host or Tailscale IP", value: newHost, onChange: (e) => setNewHost(e.target.value), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono flex-1", "data-testid": "federation-add-host" }), _jsx("input", { type: "number", placeholder: "port", value: newPort, onChange: (e) => setNewPort(Number(e.target.value) || DEFAULT_PORT), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-16", "data-testid": "federation-add-port" }), _jsx("input", { type: "text", placeholder: "machineId", value: newMachineId, onChange: (e) => setNewMachineId(e.target.value), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-24", "data-testid": "federation-add-machineid" }), _jsx("input", { type: "text", placeholder: "label (opt)", value: newLabel, onChange: (e) => setNewLabel(e.target.value), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] w-24", "data-testid": "federation-add-label" }), _jsx("button", { type: "button", onClick: onAddPeer, disabled: !newHost.trim() || !newMachineId.trim(), className: "text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40", "data-testid": "federation-add-button", children: "+" })] })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs text-[var(--text-secondary)]", children: [_jsx("input", { type: "checkbox", checked: discoverLan, onChange: (e) => setDiscoverLan(e.target.checked), "data-testid": "federation-discover-lan" }), "mDNS LAN-shortcut (prefer same-LAN address when discovered; lower latency vs Tailscale relay)"] }), _jsxs("div", { className: "space-y-1", children: [_jsxs("label", { className: "block text-xs text-[var(--text-secondary)]", children: [_jsx("span", { className: "block mb-0.5", children: "Auth mode" }), _jsxs("select", { value: authMode, onChange: (e) => setAuthMode(e.target.value), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)]", "data-testid": "federation-auth-mode", children: [_jsx("option", { value: "loopback-trusted-networks", children: "Trust Tailscale (default \u2014 relies on peer's trustedNetworks bypass)" }), _jsx("option", { value: "shared-secret-jwt", children: "Shared-secret JWT (machine-pair auth per Schema 7 \u00A79.3)" })] })] }), authMode === "shared-secret-jwt" && (_jsxs("label", { className: "block text-xs text-[var(--text-secondary)]", children: [_jsx("span", { className: "block mb-0.5", children: "Shared HMAC secret (must match peer auth.secret)" }), _jsx("input", { type: "password", value: sharedSecret, onChange: (e) => setSharedSecret(e.target.value), className: "text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-full", "data-testid": "federation-shared-secret" })] }))] }), _jsxs("div", { className: "flex items-center gap-2 pt-2", children: [_jsx("button", { type: "button", onClick: onSave, className: "text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500", "data-testid": "federation-settings-save", children: "Save" }), savedAt && (_jsxs("span", { className: "text-[10px] text-[var(--text-secondary)]", children: ["Saved at ", new Date(savedAt).toLocaleTimeString(), " \u00B7 server restart may be required for new peers to connect"] }))] })] }));
}
//# sourceMappingURL=FederationSettings.js.map