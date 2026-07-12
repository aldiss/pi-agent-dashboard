import { jsxs as _jsxs } from "react/jsx-runtime";
import { machineIdOf } from "./predicates.js";
export function MachineBadge({ session }) {
    const machineId = machineIdOf(session);
    if (!machineId)
        return null;
    return (_jsxs("span", { "data-testid": "federation-machine-badge", title: `Federated session from ${machineId}`, style: {
            display: "inline-flex",
            alignItems: "center",
            padding: "1px 5px",
            borderRadius: "3px",
            fontSize: "10px",
            fontFamily: "var(--font-mono, monospace)",
            background: "var(--bg-tertiary, #2a3a4a)",
            color: "var(--text-secondary, #b0c4de)",
            border: "1px solid var(--border-secondary, #4a5a6a)",
            textTransform: "lowercase",
            letterSpacing: "0.02em",
        }, children: ["\u2197 ", machineId] }));
}
//# sourceMappingURL=MachineBadge.js.map