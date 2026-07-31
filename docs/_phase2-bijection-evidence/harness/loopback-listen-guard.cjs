/**
 * loopback-listen-guard.cjs — injected via NODE_OPTIONS --require into the
 * isolated Phase-2 dashboard. FORCES every TCP listen onto 127.0.0.1 at the
 * syscall boundary: an absent host (would default to 0.0.0.0 / all interfaces)
 * or an explicit 0.0.0.0 / :: is rewritten to loopback; a genuine LAN-IP bind
 * (anything non-loopback, non-wildcard) HARD-ABORTS the process.
 *
 * This is the strongest available "touches nothing but loopback" proof for the
 * staged build — it neutralizes the server's `host:"0.0.0.0"` and the pi
 * gateway's hostless `new WebSocketServer({port})` without editing any product
 * code (which is forbidden this phase). Every decision is appended to
 * $LOOPBACK_GUARD_LOG for the evidence bundle; combined with per-session lsof
 * proofs it demonstrates zero :9999 / :8000 reach.
 */
const net = require("net");
const fs = require("fs");

const LOG = process.env.LOOPBACK_GUARD_LOG || "/tmp/loopback-guard.log";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::", ""]);

function record(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
}

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  const a0 = args[0];

  // Unix-socket / handle listens carry no TCP host exposure — pass through.
  if (typeof a0 === "string" && a0.startsWith("/")) {
    record(`ALLOW unix-socket listen`);
    return origListen.apply(this, args);
  }

  // Options-object form: listen({ port, host, ... }[, cb])
  if (a0 && typeof a0 === "object") {
    if ("path" in a0 && a0.path) {
      record(`ALLOW handle/path listen`);
      return origListen.apply(this, args);
    }
    if ("fd" in a0 && a0.fd != null) {
      record(`ALLOW fd listen`);
      return origListen.apply(this, args);
    }
    const host = a0.host;
    if (host !== undefined && host !== null && !LOOPBACK.has(host) && !WILDCARD.has(host)) {
      record(`ABORT tcp listen host=${host} port=${a0.port} (non-loopback LAN bind)`);
      console.error(`[loopback-guard] REFUSED non-loopback bind host=${host}`);
      process.exit(97);
    }
    const forced = { ...a0, host: "127.0.0.1" };
    record(`FORCE tcp listen port=${a0.port} host=${host ?? "(absent)"} -> 127.0.0.1`);
    return origListen.call(this, forced, ...args.slice(1));
  }

  // Positional form: listen(port[, host][, backlog][, cb])
  const port = a0;
  const rest = args.slice(1);
  const hostIdx = rest.findIndex((x) => typeof x === "string");
  const host = hostIdx >= 0 ? rest[hostIdx] : undefined;
  if (host !== undefined && !LOOPBACK.has(host) && !WILDCARD.has(host)) {
    record(`ABORT tcp listen host=${host} port=${port} (non-loopback LAN bind)`);
    console.error(`[loopback-guard] REFUSED non-loopback bind host=${host}`);
    process.exit(97);
  }
  // Preserve any trailing callback; normalize to the explicit-loopback form.
  const cb = rest.find((x) => typeof x === "function");
  record(`FORCE tcp listen port=${port} host=${host ?? "(absent)"} -> 127.0.0.1`);
  if (cb) return origListen.call(this, { port, host: "127.0.0.1" }, cb);
  return origListen.call(this, { port, host: "127.0.0.1" });
};

record("loopback-listen-guard active");
