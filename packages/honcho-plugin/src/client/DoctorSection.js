import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Doctor section — runs preflight checks and displays results.
 * Task 6.9.
 */
import { useState } from "react";
import Icon from "@mdi/react";
import { mdiCheckCircle, mdiAlert, mdiCloseCircle, mdiHeartPulse, mdiLoading, } from "@mdi/js";
import { runDoctor } from "./api.js";
const STATUS_ICON = {
    ok: { path: mdiCheckCircle, color: "rgb(134, 239, 172)" },
    warn: { path: mdiAlert, color: "rgb(253, 224, 71)" },
    fail: { path: mdiCloseCircle, color: "rgb(252, 165, 165)" },
};
export function DoctorSection() {
    const [checks, setChecks] = useState(null);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);
    const handleRun = async () => {
        setRunning(true);
        setError(null);
        try {
            const result = await runDoctor();
            setChecks(result.checks);
        }
        catch (e) {
            setError(e.message ?? "Doctor failed");
        }
        finally {
            setRunning(false);
        }
    };
    return (_jsxs("fieldset", { className: "space-y-2", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Diagnostics" }), _jsxs("button", { onClick: handleRun, disabled: running, className: "text-xs px-3 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg)] disabled:opacity-50 inline-flex items-center gap-1.5", children: [_jsx(Icon, { path: running ? mdiLoading : mdiHeartPulse, size: 0.5, spin: running }), running ? "Running…" : "Run preflight"] }), error && _jsx("div", { className: "text-red-400 text-xs", children: error }), checks && (_jsx("div", { className: "space-y-0.5", children: checks.map((c) => {
                    const ic = STATUS_ICON[c.status];
                    return (_jsxs("div", { className: "flex items-start gap-1.5 text-xs", children: [ic ? (_jsx(Icon, { path: ic.path, size: 0.5, color: ic.color, style: { flexShrink: 0, marginTop: 2 } })) : (_jsx("span", { children: "\u2022" })), _jsx("span", { className: "text-[var(--text)]", children: c.id }), c.detail && (_jsxs("span", { className: "text-[var(--text-muted)]", children: ["\u2014 ", c.detail] }))] }, c.id));
                }) }))] }));
}
//# sourceMappingURL=DoctorSection.js.map