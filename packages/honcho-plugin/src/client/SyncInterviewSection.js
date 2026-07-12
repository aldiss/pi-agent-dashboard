import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Sync + Interview section.
 * Tasks 6.10 + 6.11.
 */
import { useState } from "react";
import Icon from "@mdi/react";
import { mdiSync, mdiBrain, mdiLoading } from "@mdi/js";
import { triggerSync, submitInterview } from "./api.js";
export function SyncInterviewSection() {
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState(null);
    const [interviewText, setInterviewText] = useState("");
    const [interviewing, setInterviewing] = useState(false);
    const [interviewResult, setInterviewResult] = useState(null);
    const handleSync = async () => {
        setSyncing(true);
        setSyncResult(null);
        try {
            const r = await triggerSync();
            setSyncResult(r.ok ? `Forwarded to ${r.forwarded} session(s)` : "Sync failed");
        }
        catch (e) {
            setSyncResult(e.message ?? "Sync failed");
        }
        finally {
            setSyncing(false);
        }
    };
    const handleInterview = async () => {
        if (!interviewText.trim())
            return;
        setInterviewing(true);
        setInterviewResult(null);
        try {
            const r = await submitInterview(interviewText.trim());
            if (r.ok) {
                setInterviewResult("Preference saved");
                setInterviewText("");
            }
            else {
                setInterviewResult(r.error ?? "Interview failed");
            }
        }
        catch (e) {
            setInterviewResult(e.message ?? "Interview failed");
        }
        finally {
            setInterviewing(false);
        }
    };
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("fieldset", { className: "space-y-1", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Sync" }), _jsxs("button", { onClick: handleSync, disabled: syncing, className: "text-xs px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg)] disabled:opacity-50 inline-flex items-center gap-1.5", children: [_jsx(Icon, { path: syncing ? mdiLoading : mdiSync, size: 0.5, spin: syncing }), syncing ? "Syncing…" : "Force refresh"] }), syncResult && (_jsx("div", { className: "text-xs text-[var(--text-muted)]", children: syncResult }))] }), _jsxs("fieldset", { className: "space-y-1", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Interview \u2014 Save a preference" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "text", value: interviewText, onChange: (e) => setInterviewText(e.target.value), placeholder: "e.g. I prefer TypeScript over JavaScript", className: "flex-1 bg-[var(--bg-secondary)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-xs", onKeyDown: (e) => e.key === "Enter" && handleInterview() }), _jsxs("button", { onClick: handleInterview, disabled: interviewing || !interviewText.trim(), className: "text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 inline-flex items-center gap-1.5", children: [_jsx(Icon, { path: interviewing ? mdiLoading : mdiBrain, size: interviewing ? 0.5 : 0.6, spin: interviewing }), "Save"] })] }), interviewResult && (_jsx("div", { className: "text-xs text-[var(--text-muted)]", children: interviewResult }))] })] }));
}
//# sourceMappingURL=SyncInterviewSection.js.map