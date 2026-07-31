// @vitest-environment node
/**
 * VOICE-TRANSCRIPT SURFACE CENSUS — every composer that captures a transcript
 * must route Dawn to the spool, and there must be no un-audited surface.
 *
 * This is the guard that would have caught the mobile miss before it burned an
 * operator trial. The desktop composer (CommandInput) was wired; the mobile
 * composer (MobileComposer) was not — and nothing asserted over the SET of
 * transcript surfaces, only over the one that was checked. The census asserts
 * exhaustively: it walks the client source, finds every `<PushToTalkButton`
 * render (the transcript surfaces), and requires each to be a known, Dawn-wired
 * surface. A NEW surface that renders the button fails this test until it is
 * added here AND wired, so "one surface wired, one not" cannot recur silently.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__e2e__" || name === "__tests__") continue;
      sourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return file.slice(CLIENT_SRC.length).replace(/^\/+/, "");
}

/** Files that render a PushToTalkButton — i.e. the live transcript surfaces. */
function transcriptSurfaces(): string[] {
  return sourceFiles(CLIENT_SRC)
    .filter((f) => /<PushToTalkButton\b/.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();
}

// The exhaustive, audited set. Adding a surface here is a deliberate act that
// must be accompanied by Dawn wiring (asserted below); the equality check makes
// an un-audited new surface fail loudly.
const AUDITED_SURFACES = [
  "components/CommandInput.tsx",
  "components/MobileComposer/MobileComposer.tsx",
].sort();

describe("voice-transcript surface census", () => {
  it("found the transcript surfaces (the census is not vacuously empty)", () => {
    expect(transcriptSurfaces().length).toBeGreaterThan(0);
  });

  it("EVERY transcript surface is an audited, Dawn-wired surface — no un-audited surface", () => {
    expect(transcriptSurfaces()).toEqual(AUDITED_SURFACES);
  });

  it("CommandInput owns the Dawn handler and threads it into MobileComposer", () => {
    const src = readFileSync(join(CLIENT_SRC, "components/CommandInput.tsx"), "utf8");
    // Owns the handler + Dawn stream capture.
    expect(src).toMatch(/const handleVoiceTranscript = useCallback/);
    expect(src).toMatch(/const handleDawnStreamChange = useCallback/);
    // Its own button is wired.
    expect(src).toMatch(/onTranscript=\{handleVoiceTranscript\}/);
    // And it threads BOTH into the mobile surface — this is the line whose
    // absence was the defect.
    expect(src).toMatch(/onVoiceTranscript=\{handleVoiceTranscript\}/);
    expect(src).toMatch(/onDawnStreamChange=\{[^}]*handleDawnStreamChange[^}]*\}/);
  });

  it("MobileComposer reuses the parent handler and composes the stream to Dawn capture", () => {
    const src = readFileSync(
      join(CLIENT_SRC, "components/MobileComposer/MobileComposer.tsx"),
      "utf8",
    );
    // Accepts the reused handler + Dawn capture as props (no second spool impl).
    expect(src).toMatch(/onVoiceTranscript\?:/);
    expect(src).toMatch(/onDawnStreamChange\?:/);
    // Delegates the transcript to the parent handler rather than raw-appending.
    expect(src).toMatch(/if \(onVoiceTranscript\)/);
    // The waveform AND the Dawn capture receive the same stream.
    expect(src).toMatch(/setRecordingStream\(stream\)/);
    expect(src).toMatch(/onDawnStreamChange\?\.\(stream\)/);
    // And it does NOT define its own spool call.
    expect(src).not.toMatch(/voice-input\/spool/);
  });
});
