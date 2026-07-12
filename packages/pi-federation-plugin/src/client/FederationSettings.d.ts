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
import React from "react";
export declare function FederationSettings(): React.ReactElement;
