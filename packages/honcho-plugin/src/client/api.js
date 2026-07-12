function getApiBase() {
    // In the dashboard plugin context, API calls are same-origin.
    return "";
}
const BASE = "/api/plugins/honcho";
async function jsonFetch(url, init) {
    const res = await fetch(`${getApiBase()}${url}`, init);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status}: ${body}`);
    }
    return res.json();
}
// ── Config ───────────────────────────────────────────────────────────────────
export async function fetchConfig() {
    return jsonFetch(`${BASE}/config`);
}
export async function saveConfig(partial) {
    return jsonFetch(`${BASE}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
    });
}
// ── Sessions map ─────────────────────────────────────────────────────────────
export async function upsertSessionMapping(cwd, name) {
    return jsonFetch(`${BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name }),
    });
}
export async function deleteSessionMapping(cwd) {
    return jsonFetch(`${BASE}/sessions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
    });
}
// ── Doctor ───────────────────────────────────────────────────────────────────
export async function runDoctor() {
    return jsonFetch(`${BASE}/doctor`, { method: "POST" });
}
// ── Sync ─────────────────────────────────────────────────────────────────────
export async function triggerSync() {
    return jsonFetch(`${BASE}/sync`, { method: "POST" });
}
// ── Interview ────────────────────────────────────────────────────────────────
export async function submitInterview(content) {
    return jsonFetch(`${BASE}/interview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
    });
}
// ── Status ───────────────────────────────────────────────────────────────────
export async function fetchStatus() {
    return jsonFetch(`${BASE}/status`);
}
// ── Server lifecycle ─────────────────────────────────────────────────────────
export async function serverStart() {
    return jsonFetch(`${BASE}/server/start`, { method: "POST" });
}
export async function serverStop() {
    return jsonFetch(`${BASE}/server/stop`, { method: "POST" });
}
export async function serverRestart() {
    return jsonFetch(`${BASE}/server/restart`, { method: "POST" });
}
// ── Models ───────────────────────────────────────────────────────────────────
export async function fetchModels() {
    return jsonFetch(`${BASE}/models`);
}
export async function refreshModels(source) {
    const qs = source ? `?source=${encodeURIComponent(source)}` : "";
    return jsonFetch(`${BASE}/models/refresh${qs}`, { method: "POST" });
}
// ── Install gate ─────────────────────────────────────────────────────────────
export async function checkExtensionInstalled() {
    try {
        const res = await fetch(`${getApiBase()}/api/packages/installed`);
        const json = await res.json();
        // Response: { success, data: Array<{ source, displayName, installedPath, ... }> }
        const list = json?.data ?? json?.packages ?? json ?? [];
        return list.some((p) => p.source === "npm:pi-memory-honcho" ||
            p.displayName === "pi-memory-honcho" ||
            p.name === "pi-memory-honcho" ||
            p.id === "pi-memory-honcho");
    }
    catch {
        return false;
    }
}
export async function installExtension() {
    const res = await fetch(`${getApiBase()}/api/packages/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "npm:pi-memory-honcho" }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Install failed: ${res.status} ${body}`);
    }
}
//# sourceMappingURL=api.js.map