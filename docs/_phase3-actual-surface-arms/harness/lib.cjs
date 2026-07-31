// Shared harness lib for the actual-surface arms (isolated loopback 8153/8154,
// staged build 1c0769b). Node Playwright, explicit chromium executablePath
// (cache 1228). Loopback-only; every arm socket-proves zero :9999 / :8000.
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://127.0.0.1:8153";
const WS = "/tmp/build1-p3-20260731-8153";
const SESS = path.join(WS, "state/.pi/agent/sessions");

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}, timeout: 25000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sessions() { const d = await api("GET", "/api/sessions"); return d.data || []; }

async function spawnSession(tag) {
  const cwd = path.join(WS, "probe-cwds", tag);
  fs.mkdirSync(cwd, { recursive: true });
  await api("POST", "/api/session/spawn", { cwd, label: tag });
  let sid = null;
  for (let t = 0; t < 30; t++) { await sleep(2000); const s = (await sessions()).find((x) => String(x.cwd || "").includes(tag)); if (s) { sid = s.id; break; } }
  if (!sid) return null;
  for (let t = 0; t < 15; t++) { if (sessLog(tag)) break; await sleep(2000); }
  return sid;
}

function sessDir(tag) { const h = execSync(`find "${SESS}" -maxdepth 1 -type d -path '*${tag}*' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function sessLog(tag) { const d = sessDir(tag); if (!d) return null; const h = execSync(`find "${d}" -name '*.jsonl' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }

function socketProof(tag, outDir) {
  let out = "";
  const pids = execSync(`pgrep -f "build1-p3-20260731-8153" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  const nonLoop = out.split("\n").filter((l) => /\b(LISTEN|ESTABLISHED)\b/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l));
  fs.writeFileSync(path.join(outDir, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\nnon_loopback=${nonLoop.length}\n\n${out}`);
  return { has9999, has8000, nonLoop: nonLoop.length };
}

// Read the last select/confirm/input/multiselect ask_user RESULT details from JSONL.
function readDetails(tag, method) {
  const log = sessLog(tag);
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const wants = method || null;
  const w = (o) => {
    if (o && typeof o === "object") {
      if (o.receipt && o.method && (!wants || o.method === wants)) found = o;
      for (const v of Object.values(o)) w(v);
    }
  };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}

// Grep the JSONL for any "User responded: undefined" leak (must never appear).
function jsonlHasUndefinedDecision(tag) {
  const log = sessLog(tag);
  if (!log) return false;
  return /User responded:\s*undefined/.test(fs.readFileSync(log, "utf8"));
}

function launchBrowser(playwright) { return playwright.chromium.launch({ headless: true, executablePath: EXEC }); }

module.exports = { api, sleep, sessions, spawnSession, sessDir, sessLog, socketProof, readDetails, jsonlHasUndefinedDecision, launchBrowser, BASE, WS, EXEC, SESS };
