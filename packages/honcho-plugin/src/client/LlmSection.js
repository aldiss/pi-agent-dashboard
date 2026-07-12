import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * LLM section (self-host only) — model dropdown, route override, credential editors.
 * Tasks 6.8a through 6.8e.
 */
import { useState, useEffect, useCallback } from "react";
import Icon from "@mdi/react";
import { mdiChevronDown, mdiRefresh, mdiCheck, mdiAlert, mdiMagnify, mdiLoading, } from "@mdi/js";
import { fetchModels, refreshModels, saveConfig } from "./api.js";
const SOURCE_LABELS = {
    "pi-model-proxy": "via pi-model-proxy",
    anthropic: "via Anthropic direct",
    openai: "via OpenAI direct",
    gemini: "via Gemini direct",
    "openai-compatible": "via OpenAI-compatible",
};
const SOURCE_ORDER = [
    "pi-model-proxy",
    "anthropic",
    "openai",
    "gemini",
    "openai-compatible",
];
export function LlmSection({ config, onSave, saving }) {
    const [models, setModels] = useState(null);
    const [loadingModels, setLoadingModels] = useState(true);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [expandedCredential, setExpandedCredential] = useState(null);
    const [credKey, setCredKey] = useState("");
    const [credBaseUrl, setCredBaseUrl] = useState("");
    const [credSaving, setCredSaving] = useState(false);
    const currentModel = config.selfHost?.llm?.model ?? "";
    const currentSource = config.selfHost?.llm?.source ?? "pi-model-proxy";
    const loadModels = useCallback(async () => {
        setLoadingModels(true);
        try {
            setModels(await fetchModels());
        }
        catch {
            /* ignore */
        }
        finally {
            setLoadingModels(false);
        }
    }, []);
    useEffect(() => {
        loadModels();
    }, [loadModels]);
    const handleRefresh = async () => {
        setLoadingModels(true);
        try {
            await refreshModels();
            setModels(await fetchModels());
        }
        finally {
            setLoadingModels(false);
        }
    };
    const handleSelect = async (source, modelId) => {
        setDropdownOpen(false);
        setSearch("");
        await onSave({ selfHost: { llm: { source, model: modelId } } });
    };
    // Find which sources have the currently selected model
    const sourcesWithCurrentModel = [];
    if (models && currentModel) {
        for (const src of SOURCE_ORDER) {
            const info = models.sources[src];
            if (info?.models.some((m) => m.id === currentModel)) {
                sourcesWithCurrentModel.push(src);
            }
        }
    }
    const showRouteOverride = sourcesWithCurrentModel.length > 1;
    const handleRouteChange = async (source) => {
        await onSave({ selfHost: { llm: { source } } });
    };
    const handleSaveCredential = async (source) => {
        setCredSaving(true);
        try {
            if (source === "openai-compatible") {
                await saveConfig({ selfHost: { llm: { baseUrl: credBaseUrl, apiKey: credKey || undefined } } });
            }
            else {
                await saveConfig({ selfHost: { llm: { apiKey: credKey } } });
            }
            await refreshModels(source);
            setModels(await fetchModels());
            setExpandedCredential(null);
            setCredKey("");
            setCredBaseUrl("");
        }
        finally {
            setCredSaving(false);
        }
    };
    return (_jsxs("fieldset", { className: "space-y-2", children: [_jsxs("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2", children: ["LLM Model", _jsxs("button", { onClick: handleRefresh, disabled: loadingModels, className: "text-[10px] text-blue-400 hover:text-blue-300 disabled:opacity-50 inline-flex items-center gap-0.5", title: "Refresh model list", children: [_jsx(Icon, { path: loadingModels ? mdiLoading : mdiRefresh, size: 0.5, spin: loadingModels }), "Refresh"] })] }), _jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setDropdownOpen(!dropdownOpen), className: "w-full text-left bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1.5 text-xs flex items-center justify-between", children: [_jsx("span", { className: "font-mono", children: currentModel || "Select model…" }), _jsx(Icon, { path: mdiChevronDown, size: 0.5, className: "text-[var(--text-muted)]" })] }), dropdownOpen && (_jsxs("div", { className: "absolute z-50 mt-1 w-full max-h-72 overflow-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded shadow-lg", children: [_jsx("div", { className: "sticky top-0 bg-[var(--bg-secondary)] p-1 border-b border-[var(--border)]", children: _jsxs("div", { className: "relative", children: [_jsx(Icon, { path: mdiMagnify, size: 0.5, className: "absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" }), _jsx("input", { type: "text", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search models\u2026", className: "w-full bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded pl-6 pr-2 py-1 text-xs", autoFocus: true })] }) }), models &&
                                SOURCE_ORDER.map((source) => {
                                    const info = models.sources[source];
                                    if (!info)
                                        return null;
                                    const filtered = info.models.filter((m) => !search ||
                                        m.id.toLowerCase().includes(search.toLowerCase()) ||
                                        m.displayName.toLowerCase().includes(search.toLowerCase()));
                                    const isDisabled = !info.available;
                                    return (_jsxs("div", { children: [_jsxs("div", { className: "px-2 py-1 text-[10px] font-semibold text-[var(--text-muted)] bg-[var(--bg)] flex items-center justify-between", children: [_jsxs("span", { children: [SOURCE_LABELS[source], " (", info.models.length, ")"] }), _jsxs("span", { className: "inline-flex items-center gap-1", children: [info.reachable && !info.stale && (_jsx(Icon, { path: mdiCheck, size: 0.4, color: "rgb(134, 239, 172)" })), info.stale && (_jsxs("span", { className: "inline-flex items-center gap-0.5 text-yellow-400", title: "Using bundled list", children: [_jsx(Icon, { path: mdiAlert, size: 0.4 }), "stale"] })), isDisabled && (_jsx("span", { className: "text-[var(--text-muted)]", children: "disabled" }))] })] }), isDisabled && (_jsx("button", { onClick: (e) => {
                                                    e.stopPropagation();
                                                    setExpandedCredential(expandedCredential === source ? null : source);
                                                }, className: "w-full text-left px-3 py-1 text-[10px] text-blue-400 hover:bg-[var(--bg)]", children: source === "openai-compatible"
                                                    ? "Configure base URL"
                                                    : source === "pi-model-proxy"
                                                        ? "Install pi-model-proxy"
                                                        : `Add ${SOURCE_LABELS[source].replace("via ", "")} API key` })), expandedCredential === source && (_jsx(CredentialInlineForm, { source: source, apiKey: credKey, baseUrl: credBaseUrl, onApiKeyChange: setCredKey, onBaseUrlChange: setCredBaseUrl, onSave: () => handleSaveCredential(source), saving: credSaving })), filtered.map((m) => (_jsxs("button", { onClick: () => !isDisabled && handleSelect(source, m.id), disabled: isDisabled, className: `w-full text-left px-3 py-1 text-xs hover:bg-[var(--bg)] ${isDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"} ${currentModel === m.id && currentSource === source ? "bg-blue-900/30" : ""}`, children: [_jsx("span", { className: "font-mono text-[var(--text)]", children: m.id }), m.notes && (_jsx("span", { className: "text-[10px] text-[var(--text-muted)] ml-2", children: m.notes }))] }, `${source}:${m.id}`)))] }, source));
                                })] }))] }), showRouteOverride && (_jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "text-[var(--text-muted)]", children: "Route:" }), _jsx("select", { value: currentSource, onChange: (e) => handleRouteChange(e.target.value), disabled: saving, className: "bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs", children: sourcesWithCurrentModel.map((src) => (_jsx("option", { value: src, children: SOURCE_LABELS[src] }, src))) })] }))] }));
}
/** Inline credential editor for a source (6.8d, 6.8e). */
function CredentialInlineForm({ source, apiKey, baseUrl, onApiKeyChange, onBaseUrlChange, onSave, saving, }) {
    const isOpenAICompat = source === "openai-compatible";
    return (_jsxs("div", { className: "px-3 py-2 space-y-1 bg-[var(--bg)] border-y border-[var(--border)]", children: [isOpenAICompat && (_jsx("input", { type: "text", value: baseUrl, onChange: (e) => onBaseUrlChange(e.target.value), placeholder: "Base URL (e.g. http://localhost:11434/v1)", className: "w-full bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono" })), _jsx("input", { type: "password", value: apiKey, onChange: (e) => onApiKeyChange(e.target.value), placeholder: isOpenAICompat ? "API key (optional)" : "API key", className: "w-full bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono" }), _jsx("button", { onClick: onSave, disabled: saving || (!isOpenAICompat && !apiKey), className: "text-[10px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50", children: saving ? "Saving…" : "Save" })] }));
}
//# sourceMappingURL=LlmSection.js.map