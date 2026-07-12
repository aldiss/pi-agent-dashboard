import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import Icon from "@mdi/react";
import { mdiDocker, mdiOpenInNew } from "@mdi/js";
export function DockerMissingCallout() {
    return (_jsxs("div", { className: "border border-red-700 bg-red-900/20 rounded-lg p-3 space-y-1", children: [_jsxs("h4", { className: "text-xs font-semibold text-red-400 inline-flex items-center gap-1.5", children: [_jsx(Icon, { path: mdiDocker, size: 0.6 }), "Docker not found"] }), _jsx("p", { className: "text-[10px] text-[var(--text-muted)]", children: "Self-host mode requires Docker Desktop or Docker Engine. Install Docker and restart the dashboard." }), _jsxs("a", { href: "https://docs.docker.com/get-docker/", target: "_blank", rel: "noopener noreferrer", className: "text-[10px] text-blue-400 hover:underline inline-flex items-center gap-0.5", children: ["Install Docker", _jsx(Icon, { path: mdiOpenInNew, size: 0.4 })] })] }));
}
//# sourceMappingURL=DockerMissingCallout.js.map