// CC-r6 NEW-IDENTITY harness lib for the actual-surface arms. Isolated loopback
// 8153/8154, staged CANDIDATE build (build1-picker-cand-attr @ NEW commit).
// Loopback-only; every arm socket-proves zero :9999 / :8000. Chromium
// executablePath resolved from the ms-playwright cache at runtime (may be absent
// → browser arms skip, raw-ws arms still run).
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BASE = "http://127.0.0.1:8153";
const WS = "/tmp/build1-ccr6-cand-8153";
const MARKER = "build1-ccr6-cand-8153";
const SESS = path.join(WS, "state/.pi/agent/sessions");

// Best-effort chromium discovery (harness cache dir); null when absent.
function findChromium() {
  const base = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith("chromium-"));
    for (const d of dirs) {
      const p = path.join(base, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents/MacOS/Google Chrome for Testing");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

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
  const pids = execSync(`pgrep -f "${MARKER}" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  const nonLoop = out.split("\n").filter((l) => /\b(LISTEN|ESTABLISHED)\b/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l));
  fs.writeFileSync(path.join(outDir, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\nnon_loopback=${nonLoop.length}\n\n${out}`);
  return { has9999, has8000, nonLoop: nonLoop.length };
}

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

function jsonlHasUndefinedDecision(tag) {
  const log = sessLog(tag);
  if (!log) return false;
  return /User responded:\s*undefined/.test(fs.readFileSync(log, "utf8"));
}

function launchBrowser(playwright) {
  const exec = findChromium();
  if (!exec) throw new Error("no chromium binary in ms-playwright cache");
  return playwright.chromium.launch({ headless: true, executablePath: exec });
}

module.exports = { api, sleep, sessions, spawnSession, sessDir, sessLog, socketProof, readDetails, jsonlHasUndefinedDecision, launchBrowser, findChromium, BASE, WS, MARKER, SESS };
