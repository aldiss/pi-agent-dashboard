/**
 * FederationSettings — settings-section panel for the federation plugin.
 *
 * Reads + writes plugin config via usePluginConfig + plugin_config_write.
 * Surfaces:
 *   - This machine's id (auto-fills from os.hostname() server-side if blank)
 *   - List of peers (host / port / machineId / label)
 *   - Add-peer + remove-peer affordances
 *   - mDNS LAN-shortcut toggle
 *   - Auth mode (loopback-trusted-networks vs shared-secret-jwt + secret)
 *   - Live peer connection status (polled from /api/federation/peers)
 *
 * Phase 4 minimal implementation per investigator #1 §6.3 + §7.1 #5
 * (write only to plugins.federation.* keyspace) + §7.1 #6 (treat
 * plugin_config_update broadcast as source of truth).
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  usePluginConfig,
  usePluginSend,
} from "@blackbelt-technology/dashboard-plugin-runtime/context";

interface FederationPeer {
  host: string;
  port: number;
  machineId: string;
  label?: string;
}

interface FederationConfig {
  machineId?: string;
  peers?: FederationPeer[];
  discoverLan?: boolean;
  authMode?: "loopback-trusted-networks" | "shared-secret-jwt";
  sharedAuthSecret?: string;
}

interface PeerStatus {
  host: string;
  effectiveHost: string;
  port: number;
  machineId: string;
  label?: string;
  state: string;
  knownSessionCount: number;
}

const DEFAULT_PORT = 8000;

export function FederationSettings(): React.ReactElement {
  const config = usePluginConfig<FederationConfig>();
  const send = usePluginSend();

  const [machineId, setMachineId] = useState<string>(config.machineId ?? "");
  const [peers, setPeers] = useState<FederationPeer[]>(config.peers ?? []);
  const [discoverLan, setDiscoverLan] = useState<boolean>(config.discoverLan ?? true);
  const [authMode, setAuthMode] = useState<"loopback-trusted-networks" | "shared-secret-jwt">(
    config.authMode ?? "loopback-trusted-networks",
  );
  const [sharedSecret, setSharedSecret] = useState<string>(config.sharedAuthSecret ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Add-peer form
  const [newHost, setNewHost] = useState("");
  const [newPort, setNewPort] = useState<number>(DEFAULT_PORT);
  const [newMachineId, setNewMachineId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  // Live peer status (polled)
  const [status, setStatus] = useState<PeerStatus[]>([]);

  useEffect(() => {
    let alive = true;
    const fetchStatus = async () => {
      try {
        const resp = await fetch("/api/federation/peers");
        if (!resp.ok) return;
        const json = (await resp.json()) as { success: boolean; data?: PeerStatus[] };
        if (alive && json.success && json.data) setStatus(json.data);
      } catch { /* network blip; next tick will retry */ }
    };
    void fetchStatus();
    const t = setInterval(fetchStatus, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const onAddPeer = useCallback(() => {
    if (!newHost.trim() || !newMachineId.trim()) return;
    const peer: FederationPeer = {
      host: newHost.trim(),
      port: Number(newPort) || DEFAULT_PORT,
      machineId: newMachineId.trim(),
      ...(newLabel.trim() ? { label: newLabel.trim() } : {}),
    };
    setPeers((prev) => {
      // Replace existing peer with same machineId
      const filtered = prev.filter((p) => p.machineId !== peer.machineId);
      return [...filtered, peer];
    });
    setNewHost("");
    setNewMachineId("");
    setNewLabel("");
  }, [newHost, newPort, newMachineId, newLabel]);

  const onRemovePeer = useCallback((machineId: string) => {
    setPeers((prev) => prev.filter((p) => p.machineId !== machineId));
  }, []);

  const onSave = useCallback(() => {
    send({
      type: "plugin_config_write" as never,
      id: "federation",
      config: {
        machineId,
        peers,
        discoverLan,
        authMode,
        sharedAuthSecret: sharedSecret,
      },
    });
    setSavedAt(Date.now());
  }, [machineId, peers, discoverLan, authMode, sharedSecret, send]);

  const stateColor = (st: string): string => {
    switch (st) {
      case "open": return "#4a9a4a";
      case "connecting":
      case "reconnecting": return "#daa520";
      case "closed": return "#888";
      default: return "#aa4a4a";
    }
  };

  return (
    <section
      className="border border-[var(--border-secondary)] rounded-lg p-4 space-y-3"
      data-testid="federation-plugin-settings"
    >
      <header>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Federation (cross-machine sessions)
        </h3>
        <p className="text-xs text-[var(--text-secondary)]">
          Aggregate sessions across pi-dashboard instances on your Tailnet.
          Per Schema 7 §3.5 (option E) — WebSocket-over-Tailscale + mDNS LAN-shortcut.
        </p>
      </header>

      <label className="block text-xs text-[var(--text-secondary)]">
        <span className="block mb-0.5">This machine&apos;s id (used as prefix when peers federate back)</span>
        <input
          type="text"
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
          placeholder="imac / macbook / win — auto-fills from hostname if blank"
          className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-full"
          data-testid="federation-machine-id"
        />
      </label>

      <div>
        <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-1">Peers</h4>
        {peers.length === 0 && (
          <p className="text-[10px] text-[var(--text-secondary)] italic">
            No peers configured. Add one below.
          </p>
        )}
        <ul className="space-y-1" data-testid="federation-peers">
          {peers.map((peer) => {
            const liveStatus = status.find((s) => s.machineId === peer.machineId);
            return (
              <li
                key={peer.machineId}
                className="flex items-center justify-between text-xs border border-[var(--border-secondary)] rounded px-2 py-1"
                data-testid={`federation-peer-${peer.machineId}`}
              >
                <span className="font-mono">
                  <span style={{ color: stateColor(liveStatus?.state ?? "idle") }}>●</span>{" "}
                  {peer.label ? <strong>{peer.label}</strong> : null}{" "}
                  <code>{peer.machineId}</code>{" "}
                  <span className="text-[var(--text-secondary)]">
                    {peer.host}:{peer.port}
                    {liveStatus && liveStatus.effectiveHost !== peer.host
                      ? ` (active: ${liveStatus.effectiveHost})`
                      : ""}
                  </span>
                  {liveStatus && (
                    <span className="text-[10px] text-[var(--text-secondary)] ml-2">
                      {liveStatus.state} · {liveStatus.knownSessionCount} session(s)
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePeer(peer.machineId)}
                  className="text-[10px] px-2 py-0.5 rounded border border-[var(--border-secondary)] hover:bg-[var(--bg-tertiary)]"
                  data-testid={`federation-remove-${peer.machineId}`}
                >
                  remove
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border border-dashed border-[var(--border-secondary)] rounded p-2 space-y-1">
        <h4 className="text-xs font-semibold text-[var(--text-primary)]">Add peer</h4>
        <div className="flex gap-1 items-center text-xs">
          <input
            type="text"
            placeholder="host or Tailscale IP"
            value={newHost}
            onChange={(e) => setNewHost(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono flex-1"
            data-testid="federation-add-host"
          />
          <input
            type="number"
            placeholder="port"
            value={newPort}
            onChange={(e) => setNewPort(Number(e.target.value) || DEFAULT_PORT)}
            className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-16"
            data-testid="federation-add-port"
          />
          <input
            type="text"
            placeholder="machineId"
            value={newMachineId}
            onChange={(e) => setNewMachineId(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-24"
            data-testid="federation-add-machineid"
          />
          <input
            type="text"
            placeholder="label (opt)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] w-24"
            data-testid="federation-add-label"
          />
          <button
            type="button"
            onClick={onAddPeer}
            disabled={!newHost.trim() || !newMachineId.trim()}
            className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40"
            data-testid="federation-add-button"
          >
            +
          </button>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={discoverLan}
          onChange={(e) => setDiscoverLan(e.target.checked)}
          data-testid="federation-discover-lan"
        />
        mDNS LAN-shortcut (prefer same-LAN address when discovered; lower latency vs Tailscale relay)
      </label>

      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">
          <span className="block mb-0.5">Auth mode</span>
          <select
            value={authMode}
            onChange={(e) =>
              setAuthMode(e.target.value as "loopback-trusted-networks" | "shared-secret-jwt")
            }
            className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)]"
            data-testid="federation-auth-mode"
          >
            <option value="loopback-trusted-networks">
              Trust Tailscale (default — relies on peer&apos;s trustedNetworks bypass)
            </option>
            <option value="shared-secret-jwt">
              Shared-secret JWT (machine-pair auth per Schema 7 §9.3)
            </option>
          </select>
        </label>
        {authMode === "shared-secret-jwt" && (
          <label className="block text-xs text-[var(--text-secondary)]">
            <span className="block mb-0.5">Shared HMAC secret (must match peer auth.secret)</span>
            <input
              type="password"
              value={sharedSecret}
              onChange={(e) => setSharedSecret(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-primary)] font-mono w-full"
              data-testid="federation-shared-secret"
            />
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          onClick={onSave}
          className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500"
          data-testid="federation-settings-save"
        >
          Save
        </button>
        {savedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            Saved at {new Date(savedAt).toLocaleTimeString()} · server restart may be required for new peers to connect
          </span>
        )}
      </div>
    </section>
  );
}
