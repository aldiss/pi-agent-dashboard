import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Advanced collapsible section — Phase-1 flags from hosts.pi.*.
 * Task 6.12.
 */
import { useState, useEffect } from "react";
/** All Phase-1 advanced flags exposed in the settings panel. */
const ADVANCED_FIELDS = [
    { key: "writeFrequency", label: "Write Frequency", type: "number" },
    { key: "dialecticDynamic", label: "Dialectic Dynamic", type: "boolean" },
    { key: "dialecticMaxChars", label: "Dialectic Max Chars", type: "number" },
    { key: "dialecticMaxInputChars", label: "Dialectic Max Input Chars", type: "number" },
    { key: "reasoningLevel", label: "Reasoning Level", type: "text" },
    { key: "reasoningLevelCap", label: "Reasoning Level Cap", type: "text" },
    { key: "contextCadence", label: "Context Cadence", type: "number" },
    { key: "dialecticCadence", label: "Dialectic Cadence", type: "number" },
    { key: "sessionPeerPrefix", label: "Session Peer Prefix", type: "text" },
    { key: "observationMode", label: "Observation Mode", type: "text" },
    { key: "contextTokens", label: "Context Tokens", type: "number" },
    { key: "contextRefreshTtlSeconds", label: "Context Refresh TTL (s)", type: "number" },
    { key: "maxMessageLength", label: "Max Message Length", type: "number" },
    { key: "searchLimit", label: "Search Limit", type: "number" },
    { key: "saveMessages", label: "Save Messages", type: "boolean" },
    { key: "injectionFrequency", label: "Injection Frequency", type: "number" },
    { key: "environment", label: "Environment", type: "text" },
    { key: "logging", label: "Logging", type: "text" },
];
export function AdvancedSection({ config, onSave, saving }) {
    const [open, setOpen] = useState(false);
    const pi = config.hosts?.pi ?? {};
    const [values, setValues] = useState({});
    useEffect(() => {
        const v = {};
        for (const f of ADVANCED_FIELDS) {
            const val = pi[f.key];
            v[f.key] = val != null ? String(val) : "";
        }
        setValues(v);
    }, [config]);
    const handleSave = () => {
        const piPatch = {};
        for (const f of ADVANCED_FIELDS) {
            const raw = values[f.key];
            if (raw === "")
                continue;
            if (f.type === "number")
                piPatch[f.key] = Number(raw);
            else if (f.type === "boolean")
                piPatch[f.key] = raw === "true";
            else
                piPatch[f.key] = raw;
        }
        onSave({ hosts: { pi: piPatch } });
    };
    return (_jsxs("details", { open: open, onToggle: (e) => setOpen(e.target.open), children: [_jsx("summary", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider cursor-pointer select-none", children: "Advanced" }), _jsxs("div", { className: "mt-2 space-y-1.5", children: [ADVANCED_FIELDS.map((f) => (_jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "w-44 text-[var(--text-muted)] shrink-0", children: f.label }), f.type === "boolean" ? (_jsxs("select", { value: values[f.key] || "", onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })), className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs", children: [_jsx("option", { value: "", children: "\u2014" }), _jsx("option", { value: "true", children: "true" }), _jsx("option", { value: "false", children: "false" })] })) : (_jsx("input", { type: f.type === "number" ? "number" : "text", value: values[f.key] || "", onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })), placeholder: f.placeholder, className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs" }))] }, f.key))), _jsx("button", { onClick: handleSave, disabled: saving, className: "text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 mt-1", children: saving ? "Saving…" : "Save Advanced" })] })] }));
}
//# sourceMappingURL=AdvancedSection.js.map