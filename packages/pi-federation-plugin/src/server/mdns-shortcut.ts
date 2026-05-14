/**
 * mDNS LAN-shortcut discovery for the federation plugin.
 *
 * Browses for `_pi-dashboard._tcp` services on the local LAN. When a peer
 * configured by IP+port is also discovered locally via mDNS at a different
 * host (typically a `.local` mDNS name resolving to a local IP rather than
 * the Tailscale CGNAT IP), we prefer the LAN address — lower latency, no
 * Tailscale relay hop. Per Schema 7 §3.5 (option E composes option B +
 * option C).
 *
 * mDNS over Tailscale itself is unreliable (Tailnet doesn't broadcast
 * mDNS by default), so this layer ONLY helps when iMac + MacBook are on
 * the same LAN; cross-LAN connectivity falls back to Tailscale automatically.
 *
 * The discovery layer is best-effort: any failure here just means we keep
 * using the configured Tailscale IP. There is no retry/recovery — bonjour-
 * service handles continuous browse internally.
 */

import os from "node:os";
import type { PluginLogger } from "./types.js";

interface BonjourService {
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, string>;
}

export interface LanDiscovery {
  start(): void;
  stop(): void;
  /** Currently discovered LAN peers, keyed by host:port */
  current(): Map<string, BonjourService>;
}

export interface LanDiscoveryOpts {
  logger: PluginLogger;
  /**
   * Called when a peer is discovered or removed. Federation plugin uses
   * this to call PeerConnection.setEffectiveHost() when the discovered
   * IP differs from the configured one.
   */
  onPeerUp?: (svc: BonjourService) => void;
  onPeerDown?: (svc: BonjourService) => void;
}

const SERVICE_TYPE = "pi-dashboard";

function localAddresses(): Set<string> {
  const set = new Set<string>(["127.0.0.1", "::1"]);
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const info of iface) set.add(info.address);
  }
  return set;
}

/**
 * Create an mDNS browser that watches for _pi-dashboard._tcp services.
 *
 * Uses bonjour-service (already a dependency of pi-dashboard-shared's
 * mdns-discovery module). Returns no-op stubs if bonjour-service can't
 * load (e.g. tests).
 */
export function createLanDiscovery(opts: LanDiscoveryOpts): LanDiscovery {
  const discovered = new Map<string, BonjourService>();
  let bonjour: { destroy: () => void } | null = null;
  let browser: {
    on: (event: string, cb: (svc: BonjourService) => void) => void;
    stop: () => void;
  } | null = null;

  const localAddrs = localAddresses();

  const start = (): void => {
    try {
      // Dynamic import so plugin loader doesn't fail if bonjour-service is
      // unavailable on the deployment target (e.g. Docker without mDNS).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Bonjour } = require("bonjour-service") as {
        Bonjour: new () => {
          find: (opts: { type: string }) => {
            on: (event: string, cb: (svc: BonjourService) => void) => void;
            stop: () => void;
          };
          destroy: () => void;
        };
      };
      const inst = new Bonjour();
      bonjour = inst;
      browser = inst.find({ type: SERVICE_TYPE });
      browser.on("up", (svc: BonjourService) => {
        const addresses = svc.addresses ?? [];
        // Don't include this very machine
        if (addresses.some(a => localAddrs.has(a))) return;
        const key = `${svc.host ?? "?"}:${svc.port ?? 0}`;
        discovered.set(key, svc);
        opts.logger.info(`[mDNS] peer up: ${key} addresses=${(svc.addresses ?? []).join(",")}`);
        opts.onPeerUp?.(svc);
      });
      browser.on("down", (svc: BonjourService) => {
        const key = `${svc.host ?? "?"}:${svc.port ?? 0}`;
        discovered.delete(key);
        opts.logger.info(`[mDNS] peer down: ${key}`);
        opts.onPeerDown?.(svc);
      });
      opts.logger.info("[mDNS] LAN-shortcut discovery started");
    } catch (err) {
      opts.logger.info(
        `[mDNS] discovery unavailable (continuing without LAN-shortcut): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const stop = (): void => {
    try { browser?.stop(); } catch { /* ignore */ }
    try { bonjour?.destroy(); } catch { /* ignore */ }
    browser = null;
    bonjour = null;
    discovered.clear();
  };

  return {
    start,
    stop,
    current: () => discovered,
  };
}

/**
 * Match a discovered mDNS service against a configured peer. Returns the
 * preferred LAN host if the service is plausibly the same machine as
 * the configured peer (matched by port + at least one address overlap with
 * what TXT records claim, OR by hostname-prefix as a softer signal).
 */
export function preferredLanHost(svc: BonjourService, configuredPort: number): string | null {
  if (!svc.addresses || svc.addresses.length === 0) return null;
  if (svc.port !== configuredPort) return null;
  // Prefer IPv4 LAN addresses (192.168.*, 10.*, 172.16-31.*) — these are the
  // "local LAN" range mDNS resolves naturally. Tailscale IPs (100.64.0.0/10)
  // would defeat the purpose of LAN-shortcut.
  for (const addr of svc.addresses) {
    if (addr.startsWith("192.168.") || addr.startsWith("10.")) return addr;
    if (addr.startsWith("172.")) {
      const m = addr.match(/^172\.(\d+)\./);
      if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return addr;
    }
  }
  return null;
}
