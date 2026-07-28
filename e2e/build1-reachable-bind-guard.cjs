/**
 * Process-local reachable-bind guard for the Build-1 ask_user Playwright arm.
 *
 * Provenance: parameterized successor to the recovered dl-11979
 * `loopback-listen-guard.cjs` (sha256 66667802...), whose interception was
 * required because the frozen dashboard calls Fastify with host `0.0.0.0`.
 * The old loopback target is deliberately NOT inherited: this arm must be
 * reachable by the operator. The supplied host is validated at module load and
 * every wildcard/omitted TCP listen is rewritten to it. The two dashboard
 * ports additionally refuse any explicit host other than the supplied host.
 * Unix sockets and fd/handle listens remain untouched.
 */

"use strict";

const net = require("node:net");

const ALL_INTERFACES = new Set([
  "",
]);

const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addAddress("0.0.0.0", "ipv4");
UNSPECIFIED.addAddress("::", "ipv6");

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`[build1-bind-guard] ${name} is required`);
  return value;
}

function normalizedHost(value) {
  const host = String(value ?? "").trim().replace(/^\[|\]$/g, "");
  return host;
}

function blockListContains(blockList, host) {
  const family = net.isIP(host);
  return family !== 0 && blockList.check(host, family === 6 ? "ipv6" : "ipv4");
}

function validateBindHost(value) {
  const host = normalizedHost(value);
  if (net.isIP(host) === 0) {
    throw new Error(`[build1-bind-guard] BUILD1_BIND_HOST must be a literal IP address; received ${JSON.stringify(value)}`);
  }
  if (blockListContains(UNSPECIFIED, host) || blockListContains(LOOPBACK, host)) {
    throw new Error(`[build1-bind-guard] refusing wildcard or loopback BUILD1_BIND_HOST ${JSON.stringify(value)}`);
  }
  return host;
}

function urlPort(name, protocols) {
  const raw = requiredEnv(name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[build1-bind-guard] ${name} is not a valid URL`);
  }
  if (!protocols.has(parsed.protocol)) {
    throw new Error(`[build1-bind-guard] ${name} must use ${[...protocols].join(" or ")}`);
  }
  if (!parsed.port || !/^\d+$/.test(parsed.port)) {
    throw new Error(`[build1-bind-guard] ${name} must contain an explicit TCP port`);
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[build1-bind-guard] ${name} has an invalid TCP port`);
  }
  return { parsed, port };
}

const BIND_HOST = validateBindHost(requiredEnv("BUILD1_BIND_HOST"));
const dashboard = urlPort("BUILD1_DASHBOARD_URL", new Set(["http:", "https:"]));
const gateway = urlPort("BUILD1_GATEWAY_URL", new Set(["ws:", "wss:"]));
const gatewayHost = normalizedHost(gateway.parsed.hostname);
if (gatewayHost !== BIND_HOST) {
  throw new Error(
    `[build1-bind-guard] BUILD1_GATEWAY_URL hostname ${JSON.stringify(gatewayHost)} must equal BUILD1_BIND_HOST ${JSON.stringify(BIND_HOST)}`,
  );
}
const REQUIRED_PORTS = new Set([dashboard.port, gateway.port]);

function log(message) {
  process.stderr.write(`[build1-bind-guard] ${message}\n`);
}

function numericPort(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function needsRewrite(host) {
  const value = normalizedHost(host);
  return host === undefined || host === null || ALL_INTERFACES.has(value) || blockListContains(UNSPECIFIED, value);
}

function assertRequiredPortHost(port, host) {
  if (!REQUIRED_PORTS.has(port)) return;
  const actual = normalizedHost(host);
  if (actual !== BIND_HOST) {
    throw new Error(
      `[build1-bind-guard] refusing port ${port} bind to ${JSON.stringify(actual || "(omitted)")}; required ${BIND_HOST}`,
    );
  }
}

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function build1ReachableListen(...args) {
  const first = args[0];

  // listen(options[, callback]) — Fastify and ws both reach this form.
  if (first && typeof first === "object" && !Array.isArray(first) && typeof first.listen !== "function") {
    if (first.path !== undefined || first.fd !== undefined || first.handle !== undefined) {
      return originalListen.apply(this, args);
    }
    const port = numericPort(first.port);
    if (needsRewrite(first.host)) {
      args[0] = { ...first, host: BIND_HOST };
      log(`rewrote options-listen host ${String(first.host ?? "(omitted)")} -> ${BIND_HOST} (port ${String(first.port)})`);
    } else if (port !== undefined) {
      assertRequiredPortHost(port, first.host);
    }
    return originalListen.apply(this, args);
  }

  // listen(port[, host][, backlog][, callback]).
  const port = numericPort(first);
  if (port !== undefined) {
    const second = args[1];
    if (typeof second === "string") {
      if (needsRewrite(second)) {
        args[1] = BIND_HOST;
        log(`rewrote positional-listen host ${second || "(empty)"} -> ${BIND_HOST} (port ${port})`);
      } else {
        assertRequiredPortHost(port, second);
      }
    } else {
      args.splice(1, 0, BIND_HOST);
      log(`inserted host ${BIND_HOST} for omitted positional host (port ${port})`);
    }
    return originalListen.apply(this, args);
  }

  // Unix path, fd, handle, and other non-TCP forms are not this guard's object.
  return originalListen.apply(this, args);
};

log(`installed pid=${process.pid} host=${BIND_HOST} requiredPorts=${[...REQUIRED_PORTS].join(",")}`);
