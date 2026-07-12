import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Icon from "@mdi/react";
import { mdiCloudOutline, mdiServer } from "@mdi/js";
export function ModeSection({ config, onSave, saving }) {
    const current = config.mode ?? "cloud";
    const handleChange = (mode) => {
        // Endpoint auto-set is handled server-side in routes-config.ts (D5).
        onSave({ mode });
    };
    return (_jsxs("fieldset", { className: "space-y-1", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Mode" }), _jsxs("div", { className: "flex gap-4", children: [_jsxs("label", { className: "flex items-center gap-1 text-xs cursor-pointer", children: [_jsx("input", { type: "radio", name: "honchoMode", value: "cloud", checked: current === "cloud", onChange: () => handleChange("cloud"), disabled: saving, className: "accent-blue-500" }), _jsxs("span", { className: "text-[var(--text)] inline-flex items-center gap-1", children: [_jsx(Icon, { path: mdiCloudOutline, size: 0.5 }), " Cloud (honcho.dev)"] })] }), _jsxs("label", { className: "flex items-center gap-1 text-xs cursor-pointer", children: [_jsx("input", { type: "radio", name: "honchoMode", value: "self-host", checked: current === "self-host", onChange: () => handleChange("self-host"), disabled: saving, className: "accent-blue-500" }), _jsxs("span", { className: "text-[var(--text)] inline-flex items-center gap-1", children: [_jsx(Icon, { path: mdiServer, size: 0.5 }), " Self-host (Docker)"] })] })] })] }));
}
//# sourceMappingURL=ModeSection.js.map