const EXTERNAL_RUNTIMES = ["codex", "claude-code"] as const;

export function isExternalSessionId(id: string | undefined): boolean {
  return EXTERNAL_RUNTIMES.some((runtime) => id?.startsWith(`${runtime}:`) === true);
}

/**
 * Wouter applies decodeURI to the path before matching. That decodes `%25`
 * inside a tmux name but deliberately preserves the reserved `%3A` delimiter.
 * Decode only that known prefix so a literal `%` suffix stays byte-identical.
 */
export function decodeSessionRouteId(
  id: string | undefined,
  rawPathname?: string,
): string | undefined {
  if (!id) return undefined;
  const routeMarker = "/session/";
  const markerIndex = rawPathname?.lastIndexOf(routeMarker) ?? -1;
  if (rawPathname && markerIndex >= 0) {
    const rawId = rawPathname.slice(markerIndex + routeMarker.length);
    try {
      return decodeURIComponent(rawId);
    } catch {
      // Fall through to Wouter's partially decoded param.
    }
  }
  const lower = id.toLowerCase();
  for (const runtime of EXTERNAL_RUNTIMES) {
    const encodedPrefix = `${runtime}%3a`;
    if (lower.startsWith(encodedPrefix)) {
      return `${runtime}:${id.slice(encodedPrefix.length)}`;
    }
  }
  return id;
}

export function sessionDetailPath(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}
