#!/usr/bin/env node
// capture-fixtures.mjs — read-only fixture-capture harness for the native iPhone
// pi-dashboard contract tests.
//
// Snapshots live-dashboard payloads into the PiDashboardKit test bundle so the
// Swift contract tests decode REAL server bytes (not hand-rolled shapes). Zero
// dependencies: Node 22's built-in global `fetch` + `WebSocket` (undici) only.
//
// ────────────────────────────────────────────────────────────────────────────
// SAFETY — READ-ONLY against a LIVE operator dashboard (brief §2):
//   • The ONLY WS messages this harness emits are `subscribe` / `unsubscribe`.
//   • A hard allowlist (SAFE_CLIENT_TYPES) gates `send()`; any other type throws
//     BEFORE hitting the socket. There is no code path that can emit
//     send_prompt / abort / shutdown / force_kill / session_view / any mutation.
//   • `subscribe` only asks the server to replay a session's event log to THIS
//     socket; it does not touch the session, the unread bit, or the operator UI.
// ────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   node capture-fixtures.mjs                 # capture event_replay (the gated fixture)
//   node capture-fixtures.mjs --all           # also refresh health/sessions/snapshot (*-live.json)
//   node capture-fixtures.mjs --host http://localhost:8000
//   node capture-fixtures.mjs --max-events 60 # cap the event_replay fixture size
//   node capture-fixtures.mjs --token <bearer>
//
// Default writes ONLY new files; the curated seed fixtures (sessions-sample.json,
// health.json, ws-snapshot-sample.json — asserted with hardcoded counts) are
// never overwritten unless you pass --all (which writes *-live.json siblings, not
// the seeds).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(
  __dirname,
  "../PiDashboardKit/Tests/PiDashboardKitTests/Fixtures",
);

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, fallback = false) {
  return argv.includes(`--${name}`) ? true : fallback;
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
const HOST = (opt("host", "http://localhost:8000")).replace(/\/+$/, "");
const TOKEN = opt("token", process.env.PI_DASHBOARD_TOKEN || "");
const MAX_EVENTS = Number(opt("max-events", "80"));
const CAPTURE_ALL = flag("all");
const GLOBAL_TIMEOUT_MS = Number(opt("timeout", "45000"));

// ── read-only guard ──────────────────────────────────────────────────────────
// The complete set of client→server message types this harness may EVER send.
// Anything outside this set is a mutation and is refused.
const SAFE_CLIENT_TYPES = new Set(["subscribe", "unsubscribe"]);

function wsURL(httpBase) {
  const u = new URL(httpBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (!u.pathname.endsWith("/ws")) {
    u.pathname = (u.pathname.replace(/\/+$/, "")) + "/ws";
  }
  return u.toString();
}

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

function writeFixture(name, value) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const path = join(FIXTURES_DIR, name);
  writeFileSync(path, JSON.stringify(value, null, 1) + "\n");
  return path;
}

function log(...a) {
  console.log("[capture]", ...a);
}

// ── REST captures (GET only) ─────────────────────────────────────────────────
async function captureHealth() {
  const res = await fetch(`${HOST}/api/health`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
  const json = await res.json();
  if (CAPTURE_ALL) {
    const p = writeFixture("health-live.json", json);
    log("wrote", p);
  }
  return json;
}

async function captureSessions() {
  const res = await fetch(`${HOST}/api/sessions`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/sessions → HTTP ${res.status}`);
  const json = await res.json();
  if (CAPTURE_ALL) {
    const p = writeFixture("sessions-live.json", json);
    log("wrote", p);
  }
  return json;
}

// ── WS capture: snapshot → pick a session → subscribe → event_replay ─────────
function captureViaWebSocket() {
  return new Promise((resolve, reject) => {
    const url = wsURL(HOST);
    log("connecting (read-only)", url);
    const ws = new WebSocket(url, TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined);

    let snapshot = null;
    const candidates = [];
    let candidateIdx = -1;
    let activeSub = null; // sessionId currently subscribed
    let collected = []; // accumulated SequencedEvent[] for the active sub
    let sawIsLast = false;
    let subTimer = null;
    const result = { snapshot: null, eventReplay: null, eventReplaySessionId: null };

    const globalTimer = setTimeout(() => {
      log("global timeout — finalizing with what we have");
      finalize();
    }, GLOBAL_TIMEOUT_MS);

    // Hard read-only send wrapper: refuses any non-allowlisted type.
    function safeSend(message) {
      if (!message || typeof message.type !== "string") {
        throw new Error("refusing to send a typeless message");
      }
      if (!SAFE_CLIENT_TYPES.has(message.type)) {
        throw new Error(
          `READ-ONLY GUARD: refusing to send '${message.type}' (allowed: ${[...SAFE_CLIENT_TYPES].join(", ")})`,
        );
      }
      ws.send(JSON.stringify(message));
    }

    function pickCandidates(sessions) {
      // Prefer sessions with the smallest event log (privacy + speed), but any
      // session works — we only need a real, decodable event_replay batch.
      return [...sessions]
        .map((s) => ({ id: s.id, n: s.lastEntryCount ?? 0, status: s.status }))
        .filter((s) => typeof s.id === "string")
        .sort((a, b) => a.n - b.n);
    }

    function trySubscribeNext() {
      candidateIdx += 1;
      if (candidateIdx >= candidates.length) {
        log("no candidate produced a non-empty event_replay");
        return finalize();
      }
      activeSub = candidates[candidateIdx].id;
      collected = [];
      sawIsLast = false;
      log(`subscribe (read-only) → ${activeSub} (lastEntryCount≈${candidates[candidateIdx].n})`);
      safeSend({ type: "subscribe", sessionId: activeSub });
      clearTimeout(subTimer);
      subTimer = setTimeout(() => {
        // Per-candidate window: finalize this sub if it produced events,
        // else release it and try the next.
        if (collected.length > 0) return finalizeReplay();
        log(`  ${activeSub}: no events in window, trying next`);
        try { safeSend({ type: "unsubscribe", sessionId: activeSub }); } catch {}
        trySubscribeNext();
      }, 6000);
    }

    function finalizeReplay() {
      clearTimeout(subTimer);
      const capped = collected.slice(0, MAX_EVENTS);
      const isLast = sawIsLast && capped.length === collected.length;
      result.eventReplay = {
        type: "event_replay",
        sessionId: activeSub,
        events: capped,
        isLast,
      };
      result.eventReplaySessionId = activeSub;
      log(`  captured ${capped.length} event(s) from ${activeSub} (isLast=${isLast}${capped.length < collected.length ? ", truncated" : ""})`);
      try { safeSend({ type: "unsubscribe", sessionId: activeSub }); } catch {}
      finalize();
    }

    function finalize() {
      clearTimeout(globalTimer);
      clearTimeout(subTimer);
      try { ws.close(); } catch {}
      resolve(result);
    }

    ws.addEventListener("open", () => log("ws open"));

    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString()); }
      catch { return; }

      switch (msg.type) {
        case "sessions_snapshot": {
          snapshot = msg;
          result.snapshot = msg;
          if (CAPTURE_ALL) {
            const p = writeFixture("ws-snapshot-live.json", msg);
            log("wrote", p);
          }
          const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
          log(`snapshot: ${sessions.length} session(s)`);
          candidates.push(...pickCandidates(sessions));
          trySubscribeNext();
          break;
        }
        case "event_replay": {
          if (msg.sessionId !== activeSub) break; // not ours
          const batch = Array.isArray(msg.events) ? msg.events : [];
          collected.push(...batch);
          if (msg.isLast) sawIsLast = true;
          log(`  event_replay batch: +${batch.length} (total ${collected.length}, isLast=${!!msg.isLast})`);
          if (collected.length >= MAX_EVENTS || msg.isLast) finalizeReplay();
          break;
        }
        // Live `event` frames may arrive for an active session; we ignore them —
        // the fixture is the historical replay, not a live tail.
        default:
          break;
      }
    });

    ws.addEventListener("error", (e) => {
      reject(new Error(`WebSocket error: ${e?.message ?? e}`));
    });
    ws.addEventListener("close", () => {
      // If the socket closes before finalize(), resolve with whatever we have.
      if (!result.eventReplay && collected.length > 0) {
        result.eventReplay = {
          type: "event_replay",
          sessionId: activeSub,
          events: collected.slice(0, MAX_EVENTS),
          isLast: false,
        };
        result.eventReplaySessionId = activeSub;
      }
    });
  });
}

function histogram(events) {
  const h = {};
  for (const e of events) {
    const t = e?.event?.eventType ?? "(unknown)";
    h[t] = (h[t] ?? 0) + 1;
  }
  return h;
}

async function main() {
  log(`host=${HOST} all=${CAPTURE_ALL} maxEvents=${MAX_EVENTS}`);

  // Pre-flight health (also confirms the URL is a live dashboard).
  let health;
  try {
    health = await captureHealth();
  } catch (e) {
    console.error(`\n✗ cannot reach a dashboard at ${HOST}: ${e.message}`);
    console.error("  start the dashboard (pi-dashboard) and retry, or pass --host.\n");
    process.exit(2);
  }
  log(`health ok=${health.ok} mode=${health.mode} active=${health.server?.activeSessions}`);

  if (CAPTURE_ALL) {
    try { await captureSessions(); } catch (e) { log("sessions capture skipped:", e.message); }
  }

  const { eventReplay, eventReplaySessionId } = await captureViaWebSocket();

  if (!eventReplay || !Array.isArray(eventReplay.events) || eventReplay.events.length === 0) {
    console.error("\n✗ failed to capture a non-empty event_replay from any session.");
    console.error("  (the dashboard may have only freshly-started sessions with no history)\n");
    process.exit(3);
  }

  const path = writeFixture("event-replay-sample.json", eventReplay);
  const hist = histogram(eventReplay.events);
  const manifest = {
    capturedAtMs: Date.now(),
    sourceHost: HOST,
    sessionId: eventReplaySessionId,
    eventCount: eventReplay.events.length,
    isLast: eventReplay.isLast,
    eventTypes: hist,
    note: "Read-only capture (subscribe-only). Refresh via qa-e2e/capture-fixtures.mjs.",
  };
  const manifestPath = writeFixture("event-replay-sample.manifest.json", manifest);

  log("wrote", path);
  log("wrote", manifestPath);
  log("event-type histogram:", JSON.stringify(hist));
  console.log(`\n✓ captured ${eventReplay.events.length} real event(s) → ${path}\n`);
}

main().catch((e) => {
  console.error("✗ capture failed:", e?.stack ?? e);
  process.exit(1);
});
