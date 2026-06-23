#!/usr/bin/env node
/**
 * spawn-unfurl-fixtures.mjs — idempotent fixture provisioner for the
 * snapshot-unfurl regression suite.
 *
 * Seeds three deterministic sessions into the test HOME's pi sessions dir and
 * injects the snapshot asset bytes via the pi-gateway so the production
 * `pi-asset:` provenance path resolves at render time:
 *
 *   1. UNFURL_SESSION       — assistant message with the snapshot-unfurl
 *      linked-image (pi-asset src + `snapshot:{…highlights…}` title directive)
 *      plus the raw link line (render-only / history-safe proof).
 *   2. PLAIN_IMAGE_SESSION  — a normal ![alt](data:) markdown image (proves
 *      image-inline + ImageLightbox behavior is unchanged).
 *   3. CC_SOURCE_SESSION    — a claude-code-source session (proves transcript
 *      render for the claude-code source path).
 *
 * Usage:
 *   PI_TEST_HOME=/tmp/pi-unfurl-home PI_PI_PORT=9998 \
 *     node qa/playwright-mobile/scripts/spawn-unfurl-fixtures.mjs [--seed-only|--inject-only]
 *
 * Modes (the server scans sessions ONCE at startup, so file-seeding must
 * happen BEFORE the dashboard starts; asset injection needs the gateway up):
 *   (default)      seed files to disk AND inject the asset.
 *   --seed-only    only write the session files (run BEFORE dashboard start).
 *   --inject-only  only inject the asset via the gateway (run AFTER start).
 *
 * Env (all optional, sensible defaults):
 *   PI_TEST_HOME   isolated HOME holding `.pi/agent/sessions` (default /tmp/pi-unfurl-home)
 *   PI_PI_PORT     pi-gateway port to inject the asset_register into (default 9998)
 *   PI_NOW_ISO     pin "now" for deterministic, non-stale timestamps
 */
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

const HOME = process.env.PI_TEST_HOME || "/tmp/pi-unfurl-home";
const PI_PORT = Number(process.env.PI_PI_PORT || 9998);
const NOW = process.env.PI_NOW_ISO ? Date.parse(process.env.PI_NOW_ISO) : Date.parse("2026-06-23T12:47:00.000Z");

// Mode: seed files, inject asset, or both (default).
const MODE = process.argv.includes("--seed-only") ? "seed"
  : process.argv.includes("--inject-only") ? "inject"
  : "both";

const SESSIONS_DIR = `${HOME}/.pi/agent/sessions/--Users-dev-my-project--`;
mkdirSync(SESSIONS_DIR, { recursive: true });

const UNFURL_SESSION = "bbbbcccc-1111-2222-3333-444455556666";
const PLAIN_IMAGE_SESSION = "eeee1111-2222-3333-4444-555566667777";
const CC_SOURCE_SESSION = "ccdd1111-2222-3333-4444-555566667777";

const iso = (ms) => new Date(ms).toISOString();
const baseName = (ms, id) => `${iso(ms).replace(/[:.]/g, "-")}_${id}`;

// A small, self-contained SVG snapshot (architecture map). Rendered as an
// image/svg+xml asset injected via the gateway under its content hash.
const SNAPSHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="520" viewBox="0 0 760 520"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient><linearGradient id="node" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2330"/><stop offset="1" stop-color="#141b26"/></linearGradient></defs><rect width="760" height="520" fill="url(#bg)"/><text x="32" y="46" fill="#e5e5e5" font-family="Georgia,serif" font-size="24" font-weight="600">NOS — Architecture Map</text><text x="32" y="70" fill="#808080" font-family="ui-monospace,monospace" font-size="12">orchestration substrate · point-in-time</text><rect x="60" y="100" width="180" height="62" rx="10" fill="url(#node)" stroke="#3b82f6" stroke-width="1.5"/><text x="150" y="135" fill="#e5e5e5" font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">Operator</text><rect x="520" y="100" width="180" height="62" rx="10" fill="url(#node)" stroke="#3b82f6" stroke-width="1.5"/><text x="610" y="135" fill="#e5e5e5" font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">Orchestrator</text><rect x="180" y="220" width="400" height="56" rx="10" fill="#15202e" stroke="#eab308" stroke-width="1.5"/><text x="380" y="252" fill="#e5e5e5" font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">dispatch-seam</text><rect x="60" y="430" width="640" height="56" rx="10" fill="#15202e" stroke="#22c55e" stroke-width="1.5"/><text x="380" y="462" fill="#e5e5e5" font-family="ui-monospace,monospace" font-size="13" text-anchor="middle">verdict &amp; ship</text></svg>`;
const SNAPSHOT_B64 = Buffer.from(SNAPSHOT_SVG, "utf8").toString("base64");
const SNAPSHOT_HASH = createHash("sha256").update(Buffer.from(SNAPSHOT_B64, "base64")).digest("hex").slice(0, 16);

// A visible (64×40) PNG for the plain-image session (normal image-inline
// path). Big enough that Playwright's `toBeVisible()` geometry check passes —
// a 1×1 pixel renders but is treated as effectively invisible.
const PLAIN_PNG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="10" fill="#1b2330"/><circle cx="80" cy="50" r="26" fill="#3b82f6"/><text x="80" y="56" fill="#fff" font-family="monospace" font-size="14" text-anchor="middle">logo</text></svg>`;
const TINY_PNG = `data:image/svg+xml;base64,${Buffer.from(PLAIN_PNG_SVG, "utf8").toString("base64")}`;

/** Remove any prior fixture files for a session id (idempotency). */
function clearPrior(id) {
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (f.includes(id)) {
      try { unlinkSync(`${SESSIONS_DIR}/${f}`); } catch { /* ignore */ }
    }
  }
}

function writeSession(id, name, firstMessage, assistantText, source, extraMeta = {}) {
  clearPrior(id);
  const startMs = NOW - 60_000;
  const base = baseName(startMs, id);
  const lines = [
    { type: "session", version: 3, id, timestamp: iso(startMs), cwd: "/home/pi/dev/my-project" },
    { type: "model_change", id: "m", parentId: null, timestamp: iso(startMs + 100), provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
    { type: "message", id: "u", parentId: "m", timestamp: iso(startMs + 10_000), message: { role: "user", content: [{ type: "text", text: firstMessage }], timestamp: startMs + 10_000 } },
    { type: "message", id: "a", parentId: "u", timestamp: iso(NOW), message: { role: "assistant", content: [{ type: "text", text: assistantText }], provider: "anthropic", model: "claude-sonnet-4-20250514", usage: { input: 20, output: 20, totalTokens: 40, cost: { total: 0.001 } }, stopReason: "endTurn", timestamp: NOW } },
  ];
  writeFileSync(`${SESSIONS_DIR}/${base}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const meta = {
    cwd: "/home/pi/dev/my-project", firstMessage, name,
    startedAt: startMs, endedAt: NOW, status: "ended",
    model: "anthropic/claude-sonnet-4-20250514", thinkingLevel: "high",
    tokensIn: 20, tokensOut: 20, cost: 0.001, contextTokens: 40, contextWindow: 200000,
    source, cachedAt: NOW, ...extraMeta,
  };
  writeFileSync(`${SESSIONS_DIR}/${base}.meta.json`, JSON.stringify(meta));
}

// 1. Snapshot-unfurl session (pi source, pi-asset provenance + highlights).
const href = "https://100.126.219.9:9090/nos-architecture-map.html";
const directive = JSON.stringify({
  ts: "12:47",
  desc: "Snapshot with 2 areas highlighted for you. Quick-check fullscreen, here — or open the live diagram.",
  caption: "Cartographer flagged 2 areas for your eyes",
  highlights: [
    { top: 42, left: 22, width: 56, height: 12, label: "the dispatch-seam — your --via decision lives here" },
    { top: 82, left: 7, width: 86, height: 12, label: "verdict & ship — where it reaches you to ratify" },
  ],
});
const unfurlText = [
  "Map's ready. I've **flagged 2 spots** I want your eyes on before we talk — tap **View inline** to check them here, or open the source for the full interactive version.",
  "",
  href,
  "",
  `[![NOS — Architecture Map](pi-asset:${SNAPSHOT_HASH})](${href} 'snapshot:${directive}')`,
].join("\n");

// Seed the session files (only when not in --inject-only mode). The server
// scans sessions ONCE at startup, so this must run BEFORE the dashboard starts.
if (MODE !== "inject") {
  writeSession(UNFURL_SESSION, "arch-diagram-driver", "draw me the architecture — then walk me through it.", unfurlText, "dashboard");

  // 2. Plain-image session (normal image-inline; ImageLightbox-unchanged proof).
  const plainText = ["Here's the logo you asked for:", "", `![project logo](${TINY_PNG})`].join("\n");
  writeSession(PLAIN_IMAGE_SESSION, "plain-image-session", "show me the logo", plainText, "dashboard");

  // 3. Claude-code-source session (transcript render for the cc source path).
  const ccText = ["This is a **claude-code transcript** rendering through the same markdown pipeline.", "", "- bullet one", "- bullet two"].join("\n");
  writeSession(CC_SOURCE_SESSION, "cc-transcript", "render a claude-code transcript", ccText, "claude-code");
}

// Inject the snapshot asset bytes via the pi-gateway so `pi-asset:<hash>`
// resolves at render time (replay-only instances have no live bridge).
function injectAsset() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PI_PORT}`);
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(ok); } };
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "asset_register", sessionId: UNFURL_SESSION, hash: SNAPSHOT_HASH, mimeType: "image/svg+xml", data: SNAPSHOT_B64 }));
      setTimeout(() => done(true), 600);
    });
    ws.on("error", (e) => { console.error("asset inject ws error:", e.message); done(false); });
    setTimeout(() => done(false), 4000);
  });
}

const injected = MODE === "seed" ? "skipped (--seed-only)" : await injectAsset();
console.log(JSON.stringify({
  ok: true,
  mode: MODE,
  sessionsDir: SESSIONS_DIR,
  unfurlSession: UNFURL_SESSION,
  plainImageSession: PLAIN_IMAGE_SESSION,
  ccSourceSession: CC_SOURCE_SESSION,
  snapshotHash: SNAPSHOT_HASH,
  assetInjected: injected,
}, null, 2));
if (MODE !== "seed" && !injected) {
  console.error("WARN: asset injection failed — is the dashboard pi-gateway up on port " + PI_PORT + "? The unfurl card will fall back to the plain link until the asset is registered.");
}
