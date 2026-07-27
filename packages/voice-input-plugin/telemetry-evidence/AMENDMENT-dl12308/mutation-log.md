# Mutation evidence (Pete B) — per-property red-then-green-on-revert

Green means something only if breaking the implementation turns the guarding test
RED. Each row: mutate the REAL source, run, observe the specific test fail, revert,
observe green. Run own-hand this session.

| # | Property | Mutation (real source) | Result under mutation | On revert |
|---|---|---|---|---|
| D1 | Health-gate attempt observable | `PushToTalkButton.tsx` onClick gate → old silent `if(!sidecarHealthy)return;` (no emit) | RED — "records a sidecar_unhealthy_gate no_post AND issues NO transcribe POST" FAILS (1 failed, 9 pass) | GREEN 10/10 |
| D2a | Drain re-read+merge | `telemetry.ts` drainOnce `readState(ls)` after await → `const after = before` (stale snapshot) | RED — "RE-READ+MERGE: record emitted during in-flight drain NOT stale-overwritten" FAILS | GREEN |
| D2b | Serialised drains | `telemetry.ts` drain → `return drainOnce(endpoint)` (no chain) | RED — "SERIALISED DRAINS: two concurrent drains do not double-POST" FAILS | GREEN |
| D2c | Sticky degraded | `telemetry.ts` writeState final catch → remove `stickyDegraded = true` | RED — "STICKY DEGRADED: degraded never reverts" FAILS | GREEN |
| D2d | Beacon fall-through | `telemetry.ts` beaconUnload → `return true` after beacon (skip fetch fallback) | RED — "sendBeacon=false FALLS THROUGH to keepalive fetch" FAILS | GREEN |

Note (honest): an initial single-site mutation of the sticky flag in `readState` did NOT turn the sticky test red — stickiness is enforced defence-in-depth in more than one place. The recorded D2c mutation targets the actual SET site (writeState catch), which does turn it red. Disclosed so the evidence reflects where the property truly lives.
| D3a | Re-sanitise on the WIRE (client) | `telemetry.ts` toWire → strip-`delivered`-only (no sanitize) | RED — "POISONED STORAGE: tampered entry does NOT put transcript/audio on the DRAIN wire" FAILS | GREEN |
| D3b | Token validation (client) | `telemetry.ts` sanitize request_id → `slice(0,128)` truncate-only | RED — "CONTENT-SMUGGLING via request_id DROPPED not truncated" FAILS | GREEN |
| D3c | Token validation (dashboard sink) | `telemetry-sink.ts` sanitizeRecord request_id → truncate-only | RED — "CONTENT-SMUGGLING: transcript in request_id DROPPED, un-ackable" FAILS | GREEN |
| D3d | Field validation (sidecar) | `_telemetry.py` _sanitize → keep string fields WITHOUT validating | RED — "sanitize drops smuggled content in string fields" FAILS | GREEN |
| D3e | Header validation (sidecar) | `_telemetry.py` resolve_request_id → accept-any truncate-only | RED — "poisoned request_id header rejected and minted" FAILS | GREEN |

D3 note: found + fixed a self-inflicted MEASUREMENT trap in my own test — the sentinel contained a non-ASCII `ΩΩ`, and `to_json` uses `ensure_ascii=True`, so a real leak would serialise as `ΩΩ` and the literal-substring assertion could PASS despite a leak (false green). Changed the sentinel to ASCII-only so leak detection is honest in both escaping modes. This is the "a measurement means what it records, not what its label suggests" discipline applied to my own suite.
| D4 | Real assembled chain (ack-body) | `telemetry.ts` drainOnce → `acked = new Set()` (ignore server ack body) | RED — assembled E2E `pass:false`: real_client_drain_confirmed_two=false, buffer_cleared_on_ack=false (records retained). Proves the E2E exercises the REAL acknowledged-drain path — a synthesized POST could not detect this. | GREEN (pass:true) |
| D4b | Receipt scoping load-bearing | `_serve.py` `is_health_poll = False` (scope disabled) | RED — "health_poll_emits_NO_receipt_but_transcribe_does" FAILS (5 polls flood the receipt log) | GREEN |
