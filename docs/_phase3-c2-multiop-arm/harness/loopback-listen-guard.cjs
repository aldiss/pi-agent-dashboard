/**
 * loopback-listen-guard.cjs — injected via NODE_OPTIONS --require into the
 * isolated actual-surface-arm dashboard. FORCES every TCP listen onto
 * 127.0.0.1 at the syscall boundary: absent host (would default to 0.0.0.0)
 * or explicit 0.0.0.0 / :: is rewritten to loopback; a genuine LAN-IP bind
 * HARD-ABORTS. Neutralizes the server's host:"0.0.0.0" and the pi gateway's
 * hostless new WebSocketServer({port}) with no product-code edit. Appends every
 * decision to $LOOPBACK_GUARD_LOG for the evidence bundle.
 */
const net = require("net");
const fs = require("fs");
const LOG = process.env.LOOPBACK_GUARD_LOG || "/tmp/loopback-guard.log";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::", ""]);
function record(line) { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} }
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  const a0 = args[0];
  if (typeof a0 === "string" && a0.startsWith("/")) { record("ALLOW unix-socket"); return origListen.apply(this, args); }
  if (a0 && typeof a0 === "object") {
    if (("path" in a0 && a0.path) || ("fd" in a0 && a0.fd != null)) { record("ALLOW handle/fd"); return origListen.apply(this, args); }
    const host = a0.host;
    if (host !== undefined && host !== null && !LOOPBACK.has(host) && !WILDCARD.has(host)) {
      record(`ABORT host=${host} port=${a0.port}`); console.error(`[loopback-guard] REFUSED non-loopback ${host}`); process.exit(97);
    }
    record(`FORCE port=${a0.port} host=${host ?? "(absent)"} -> 127.0.0.1`);
    return origListen.call(this, { ...a0, host: "127.0.0.1" }, ...args.slice(1));
  }
  const port = a0; const rest = args.slice(1);
  const host = rest.find((x) => typeof x === "string");
  if (host !== undefined && !LOOPBACK.has(host) && !WILDCARD.has(host)) {
    record(`ABORT host=${host} port=${port}`); console.error(`[loopback-guard] REFUSED non-loopback ${host}`); process.exit(97);
  }
  const cb = rest.find((x) => typeof x === "function");
  record(`FORCE port=${port} host=${host ?? "(absent)"} -> 127.0.0.1`);
  return cb ? origListen.call(this, { port, host: "127.0.0.1" }, cb) : origListen.call(this, { port, host: "127.0.0.1" });
};
record("loopback-listen-guard active (p3 8153/8154)");
