import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Honcho settings panel — settings-section slot (tab=general).
 *
 * Gates on extension install. When installed, renders:
 *   - Status header (mode, state, endpoint, cacheChars, sessionKey)
 *   - Connection section (apiKey, peerName, workspace, aiPeer, endpoint, linkedHosts, sessionStrategy)
 *   - Recall section (recallMode radio)
 *   - Mode picker (cloud / self-host)
 *   - Server section (self-host only: start/stop/restart, autoStart, ports, storageBackend)
 *   - LLM section (self-host only: model dropdown)
 *   - Doctor / Sync / Interview
 *   - Advanced collapsible
 */
import { useState, useCallback } from "react";
import { useExtensionInstalled, useHonchoConfig, useHonchoStatus } from "./hooks.js";
import { InstallGate } from "./InstallGate.js";
import { StatusHeader } from "./StatusHeader.js";
import { ConnectionSection } from "./ConnectionSection.js";
import { RecallSection } from "./RecallSection.js";
import { ModeSection } from "./ModeSection.js";
import { ServerSection } from "./ServerSection.js";
import { LlmSection } from "./LlmSection.js";
import { DoctorSection } from "./DoctorSection.js";
import { SyncInterviewSection } from "./SyncInterviewSection.js";
import { AdvancedSection } from "./AdvancedSection.js";
import { DockerMissingCallout } from "./DockerMissingCallout.js";
import { PortOverrideNotice } from "./PortOverrideNotice.js";
import { saveConfig } from "./api.js";
export function HonchoSettings() {
    const { installed, checking, recheck } = useExtensionInstalled();
    const { config, loading, refresh } = useHonchoConfig();
    const { status, refresh: refreshStatus } = useHonchoStatus();
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const handleSave = useCallback(async (partial) => {
        setSaving(true);
        setSaveError(null);
        try {
            await saveConfig(partial);
            await refresh();
            await refreshStatus();
        }
        catch (e) {
            setSaveError(e.message ?? "Save failed");
        }
        finally {
            setSaving(false);
        }
    }, [refresh, refreshStatus]);
    if (checking || loading) {
        return (_jsx("div", { className: "text-[var(--text-muted)] text-sm py-2", children: "Loading Honcho settings\u2026" }));
    }
    if (!installed) {
        return _jsx(InstallGate, { onInstalled: recheck });
    }
    if (!config) {
        return (_jsx("div", { className: "text-[var(--text-muted)] text-sm py-2", children: "Could not load Honcho config." }));
    }
    const isSelfHost = config.mode === "self-host";
    return (_jsxs("div", { className: "space-y-4", children: [_jsx(StatusHeader, { status: status, config: config }), saveError && (_jsx("div", { className: "text-red-400 text-xs bg-red-900/20 rounded px-2 py-1", children: saveError })), _jsx(ConnectionSection, { config: config, onSave: handleSave, saving: saving }), _jsx(RecallSection, { config: config, onSave: handleSave, saving: saving }), _jsx(ModeSection, { config: config, onSave: handleSave, saving: saving }), status?.state === "docker-missing" && _jsx(DockerMissingCallout, {}), _jsx(PortOverrideNotice, { config: config }), isSelfHost && (_jsxs(_Fragment, { children: [_jsx(ServerSection, { config: config, status: status, onSave: handleSave, saving: saving, onRefreshStatus: refreshStatus }), _jsx(LlmSection, { config: config, onSave: handleSave, saving: saving })] })), _jsx(DoctorSection, {}), _jsx(SyncInterviewSection, {}), _jsx(AdvancedSection, { config: config, onSave: handleSave, saving: saving })] }));
}
//# sourceMappingURL=HonchoSettings.js.map