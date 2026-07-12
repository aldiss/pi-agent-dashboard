export function PortOverrideNotice({ config }) {
    // The server-side regenerateComposeForChanges() writes a .regenerated sibling.
    // We surface a notice when mode is self-host. The server's status endpoint
    // or a future field can surface this properly. For now, a static hint.
    if (config.mode !== "self-host")
        return null;
    // TODO: wire to actual detection (e.g., status.regeneratedComposeExists).
    // For now, render nothing. The notice activates once the server surfaces
    // the regenerated-file flag in HonchoPluginStatus.
    return null;
}
//# sourceMappingURL=PortOverrideNotice.js.map