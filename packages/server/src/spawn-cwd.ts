import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ResolvedCwd =
  | { ok: true; realPath: string }
  | { ok: false; problem: "missing" | "not-a-directory" | "unresolvable" };

export function resolveSpawnCwd(requestedCwd: string): ResolvedCwd {
  if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) return { ok: false, problem: "unresolvable" };
  try {
    const realPath = realpathSync(requestedCwd);
    return statSync(realPath).isDirectory() ? { ok: true, realPath } : { ok: false, problem: "not-a-directory" };
  } catch (err) {
    return { ok: false, problem: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unresolvable" };
  }
}

/** Both arguments contain canonical absolute paths. Empty roots deny, never disable policy. */
export function isContained(realPath: string, permittedRoots: readonly string[]): boolean {
  if (typeof realPath !== "string" || !path.isAbsolute(realPath)) return false;
  return permittedRoots.some(root => {
    if (typeof root !== "string" || !path.isAbsolute(root)) return false;
    const relative = path.relative(root, realPath);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

export function computePermittedRoots(input: {
  pinnedDirectories: readonly string[];
  knownSessionCwds: readonly string[];
}): string[] {
  const roots = [...input.pinnedDirectories, ...input.knownSessionCwds].map(resolveSpawnCwd);
  return [...new Set(roots.flatMap(root => root.ok ? [root.realPath] : []))];
}
