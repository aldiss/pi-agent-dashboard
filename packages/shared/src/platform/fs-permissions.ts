/** Check POSIX privacy bits; Windows file privacy is governed by ACLs, not mode bits. */
export function isPrivateFileMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || (mode & 0o077) === 0;
}
