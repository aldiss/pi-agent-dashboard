/** Inputs for computing mobile navigation depth */
export interface MobileDepthInput {
  selectedId?: string;
  folderTermCwd?: string | null;
  folderEditorCwd?: string | null;
  settingsMatch?: boolean;
  tunnelSetupMatch?: boolean;
  /** `/dashboard` route active. Treated as a depth-1 detail view
   *  (sister-shape to settings / tunnel-setup) on mobile. */
  dashboardMatch?: boolean;
  hasPreview?: boolean;
}

/**
 * Compute MobileShell depth: 0 = list, 1 = detail, 2 = preview.
 */
export function getMobileDepth(input: MobileDepthInput): number {
  if (input.hasPreview) return 2;
  if (input.selectedId || input.folderTermCwd || input.folderEditorCwd || input.settingsMatch || input.tunnelSetupMatch || input.dashboardMatch) return 1;
  return 0;
}
