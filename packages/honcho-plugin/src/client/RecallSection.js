import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const RECALL_MODES = [
    { value: "hybrid", label: "Hybrid" },
    { value: "context", label: "Context only" },
    { value: "tools", label: "Tools only" },
];
export function RecallSection({ config, onSave, saving }) {
    const current = config.hosts?.pi?.recallMode ?? "hybrid";
    const handleChange = (mode) => {
        onSave({ hosts: { pi: { recallMode: mode } } });
    };
    return (_jsxs("fieldset", { className: "space-y-1", children: [_jsx("legend", { className: "text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider", children: "Recall Mode" }), _jsx("div", { className: "flex gap-4", children: RECALL_MODES.map(({ value, label }) => (_jsxs("label", { className: "flex items-center gap-1 text-xs cursor-pointer", children: [_jsx("input", { type: "radio", name: "recallMode", value: value, checked: current === value, onChange: () => handleChange(value), disabled: saving, className: "accent-blue-500" }), _jsx("span", { className: "text-[var(--text)]", children: label })] }, value))) })] }));
}
//# sourceMappingURL=RecallSection.js.map