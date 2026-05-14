/**
 * PeerConnection — manages a single WebSocket-over-Tailscale connection from
 * THIS pi-dashboard server to a peer's /ws endpoint.
 *
 * Shape mirrors packages/extension/src/connection.ts ConnectionManager:
 *   - exponential backoff (1s → 2 → 4 → … → 30s max) reset on successful open
 *   - liveness watchdog (60s default) forces reconnect on silence
 *   - auth handshake via Cookie header (loopback-trusted-networks bypass OR shared-secret JWT per Schema 7 §9.3)
 *
 * Each PeerConnection runs the federation plugin's "robot browser" against
 * the peer dashboard: subscribes to all known sessions, forwards every event
 * back to the local server which re-broadcasts to local browsers (with the
 * peer's machineId prefix so cross-machine collisions are impossible).
 *
 * Per Schema 7 §3.5 + investigator #1 §6.3 federation-hook sketch.
 */

import WebSocket, { type RawData } from "ws";
import crypto from "node:crypto";
import type { PluginLogger } from "./types.js";

export interface PeerConfig {
  host: string;
  port: number;
  machineId: string;
  label?: string;
}

export interface PeerConnectionOpts {
  /** Log prefix for this peer. */
  logger: PluginLogger;
  /** Initial reconnect delay (ms). */
  reconnectInitialMs: number;
  /** Max reconnect delay cap (ms). */
  reconnectMaxMs: number;
  /** Watchdog idle window (ms). */
  watchdogTimeoutMs: number;
  /** Auth handshake: when set, presented as `pi_dash_token=<jwt>` cookie. */
  jwtCookieValue?: string;
  /**
   * Called when the peer reports a session add/update/remove or any other
   * event. Receiver re-broadcasts to local browsers with peer.machineId
   * prefix on session ids.
   */
  onMessage: (peer: PeerConfig, msg: PeerMessage) => void;
  /** Called when connection state changes (for /api/federation/peers UI). */
  onStateChange: (peer: PeerConfig, state: PeerState) => void;
}

export type PeerState =
  | "idle"           // before first open
  | "connecting"     // WS handshake in progress
  | "open"           // connected + auth-pass
  | "closed"         // intentionally closed (shutdown)
  | "reconnecting";  // backoff window between attempts

/**
 * Shape of messages received over the federation WebSocket.
 * The pi-agent-dashboard browser-protocol's ServerToBrowserMessage union has
 * 50+ variants; we treat each one as opaque + carry-through, only inspecting
 * `type` and `sessionId`/`session` fields where relevant for prefixing.
 */
export interface PeerMessage {
  type: string;
  sessionId?: string;
  session?: { id?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Mint a JWT-style cookie value. Format mirrors packages/server/src/auth.ts
 * (`createToken(payload, secret)` → HMAC-SHA256 over base64url(header) + "." +
 * base64url(payload), then concatenated as base64url(header).base64url(payload).signature).
 *
 * For federation we mint with role="federation" and a 7-day exp. Peer's
 * auth-plugin.ts validateWsUpgrade() verifies the signature with its
 * auth.secret (shared via pi-config per Schema 7 §9.3).
 */
export function mintFederationJwt(secret: string, machineId: string, ttlSec = 7 * 24 * 60 * 60): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: `federation:${machineId}`,
    role: "federation",
    iat: now,
    exp: now + ttlSec,
  };
  const b64u = (obj: object): string =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const headerB64 = b64u(header);
  const payloadB64 = b64u(payload);
  const signing = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(signing)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${signing}.${sig}`;
}

export class PeerConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private currentBackoffMs: number;
  private state: PeerState = "idle";
  private shuttingDown = false;
  private subscribedSessions = new Set<string>();
  /** Peer's session list as last-known from list_sessions / sessions_discovered events. */
  private knownPeerSessions = new Map<string, unknown>();
  /** When the connection last received any frame; used by the watchdog. */
  private lastActivityAt = 0;
  /** Effective host — may be overridden by mDNS-LAN-shortcut. */
  private effectiveHost: string;

  constructor(
    public readonly peer: PeerConfig,
    private readonly opts: PeerConnectionOpts,
  ) {
    this.currentBackoffMs = opts.reconnectInitialMs;
    this.effectiveHost = peer.host;
  }

  /** Start (or restart) the connection lifecycle. */
  start(): void {
    if (this.shuttingDown) return;
    this.connect();
  }

  /**
   * Replace the effective host with an mDNS-discovered LAN address.
   * Triggers reconnect if currently open against a different host.
   * The peer's logical identity (machineId) is unchanged.
   */
  setEffectiveHost(host: string): void {
    if (host === this.effectiveHost) return;
    this.opts.logger.info(
      `[peer:${this.peer.machineId}] effective host change ${this.effectiveHost} → ${host} (mDNS LAN-shortcut)`,
    );
    this.effectiveHost = host;
    if (this.ws && this.state === "open") {
      // Soft-disconnect to trigger reconnect through the new host.
      try { this.ws.close(1000, "host-rebind"); } catch { /* ignore */ }
    }
  }

  getEffectiveHost(): string {
    return this.effectiveHost;
  }

  getState(): PeerState {
    return this.state;
  }

  getKnownSessions(): Map<string, unknown> {
    return this.knownPeerSessions;
  }

  /**
   * Forward a message FROM the local browser TO this peer (e.g. local user
   * clicked a federated session card → send_prompt for `imac:abc123` → strip
   * the `imac:` prefix and forward as send_prompt for `abc123` to imac).
   */
  send(msg: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        this.opts.logger.warn(
          `[peer:${this.peer.machineId}] send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
    return false;
  }

  /** Close + stop reconnecting. */
  shutdown(): void {
    this.shuttingDown = true;
    this.setState("closed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, "shutdown"); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private setState(next: PeerState): void {
    if (next !== this.state) {
      this.state = next;
      this.opts.onStateChange(this.peer, next);
    }
  }

  private connect(): void {
    if (this.shuttingDown) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    const url = `ws://${this.effectiveHost}:${this.peer.port}/ws`;
    const headers: Record<string, string> = {};
    if (this.opts.jwtCookieValue) {
      headers.Cookie = `pi_dash_token=${this.opts.jwtCookieValue}`;
    }

    this.opts.logger.info(
      `[peer:${this.peer.machineId}] connecting to ${url} (auth=${this.opts.jwtCookieValue ? "jwt" : "trusted-network-bypass"})`,
    );
    this.setState("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
    } catch (err) {
      this.opts.logger.warn(
        `[peer:${this.peer.machineId}] WebSocket constructor threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.opts.logger.info(`[peer:${this.peer.machineId}] connected`);
      this.setState("open");
      this.currentBackoffMs = this.opts.reconnectInitialMs; // reset backoff
      this.lastActivityAt = Date.now();
      this.startWatchdog();
      // The peer's browserGateway.onConnect sends an immediate `servers_discovered`
      // snapshot + we will receive `session_added` per active session via the
      // session-bootstrap path on the peer side. No explicit list needed for v0.1.
      // Subscribe-to-all is handled lazily as session_added events arrive.
    });

    ws.on("message", (raw: RawData) => {
      this.lastActivityAt = Date.now();
      let msg: PeerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.opts.logger.warn(
          `[peer:${this.peer.machineId}] bad JSON from peer: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      this.handlePeerMessage(msg);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "";
      this.opts.logger.info(
        `[peer:${this.peer.machineId}] closed (code=${code}, reason=${reasonStr})`,
      );
      this.stopWatchdog();
      this.subscribedSessions.clear();
      this.knownPeerSessions.clear();
      if (!this.shuttingDown) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.opts.logger.warn(`[peer:${this.peer.machineId}] WS error: ${err.message}`);
      // Don't schedule reconnect here — `close` always fires after `error`,
      // and our `close` handler does the scheduling.
    });

    ws.on("unexpected-response", (_req, res) => {
      this.opts.logger.warn(
        `[peer:${this.peer.machineId}] WS upgrade rejected with HTTP ${res.statusCode} ${res.statusMessage}` +
          ` — verify peer is up + trustedNetworks/auth covers this host`,
      );
    });
  }

  private handlePeerMessage(msg: PeerMessage): void {
    // Track peer's known sessions so /api/federation/sessions can serve a snapshot.
    if (msg.type === "session_added" && msg.session?.id) {
      this.knownPeerSessions.set(msg.session.id as string, msg.session);
      this.maybeSubscribe(msg.session.id as string);
    } else if (msg.type === "session_removed" && msg.sessionId) {
      this.knownPeerSessions.delete(msg.sessionId);
      this.subscribedSessions.delete(msg.sessionId);
    } else if (msg.type === "session_updated" && msg.sessionId) {
      const existing = this.knownPeerSessions.get(msg.sessionId);
      if (existing && typeof msg.updates === "object" && msg.updates !== null) {
        this.knownPeerSessions.set(msg.sessionId, { ...(existing as object), ...(msg.updates as object) });
      }
    }
    // Forward to the federation plugin's onMessage handler regardless of type.
    // The handler is responsible for prefixing session ids + re-broadcasting.
    this.opts.onMessage(this.peer, msg);
  }

  private maybeSubscribe(sessionId: string): void {
    if (this.subscribedSessions.has(sessionId)) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Subscribe so the peer streams events for this session over the WS.
    try {
      this.ws.send(JSON.stringify({ type: "subscribe", sessionId, lastSeq: 0 }));
      this.subscribedSessions.add(sessionId);
    } catch (err) {
      this.opts.logger.warn(
        `[peer:${this.peer.machineId}] subscribe(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return; // already scheduled
    this.setState("reconnecting");
    const delay = this.currentBackoffMs;
    this.opts.logger.info(`[peer:${this.peer.machineId}] reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.opts.reconnectMaxMs);
      this.connect();
    }, delay);
    // Don't keep node event loop alive solely on this timer.
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      const idle = Date.now() - this.lastActivityAt;
      if (idle > this.opts.watchdogTimeoutMs) {
        this.opts.logger.warn(
          `[peer:${this.peer.machineId}] watchdog timeout (idle ${idle}ms > ${this.opts.watchdogTimeoutMs}ms); forcing reconnect`,
        );
        if (this.ws) {
          try { this.ws.close(1001, "watchdog"); } catch { /* ignore */ }
        }
      }
    }, Math.max(5000, this.opts.watchdogTimeoutMs / 4));
    (this.watchdogTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
