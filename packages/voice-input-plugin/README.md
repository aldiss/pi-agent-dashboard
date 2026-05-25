# @blackbelt-technology/pi-dashboard-voice-input-plugin

Voice-input plugin for pi-dashboard. Provides a push-to-talk button (client) and a
transcription endpoint (server) that proxies to a local voice-input sidecar process
running the whisper-fallback + parakeet voice-recognition stack.

## Status

This package was extracted from the original voice-input cell-of-work
(`~/.pi/projects/_archived/voice-input/v1/substrate.md`) into a workspace package on
the pi-dashboard `worker/federation-websocket-plugin-mvp` branch by FastUnion
2026-05-15. The dashboard-side integration point lives at
`packages/client/src/components/CommandInput.tsx` between the
`VOICE-INPUT-LOCAL-PATCH-START` / `VOICE-INPUT-LOCAL-PATCH-END` markers, gated for
grep-discoverable v1.x migration to a `chat-input-augment` slot upstream PR.

## Architecture

- **Client (`src/client/PushToTalkButton.tsx`)** — React component with click-to-toggle
  UX (per operator-direct ratification 2026-05-14: *"so, on the voice input - can we
  switch to click?"*). State machine `idle | recording | uploading | error`; 60s
  safety-net auto-stop (`MAX_RECORDING_MS = 60_000`); sidecar health polling; race-fix
  for fast-double-click via `inFlightStartRef` + `pendingStopRef` queue.
- **Server (`src/server/index.ts`)** — Fastify route registrar that proxies
  `/api/plugins/voice-input/transcribe` POST + `/api/plugins/voice-input/health` GET
  to a local sidecar process. Per-request `connectionTimeout` raised above the
  dashboard server's default (10s) so transcription requests (~20-25s on iMac per
  voice-input substrate r1 § W3.5 § 8) complete cleanly.

## Imports

- Client: `import { PushToTalkButton } from "@blackbelt-technology/pi-dashboard-voice-input-plugin/client"`
- Server: `import { register as registerVoiceInputPlugin } from "@blackbelt-technology/pi-dashboard-voice-input-plugin/server"`

## Cross-language boundary

Communicates with the Python voice-input MODULE (`~/Copilot/pi-extensions/voice-input/`)
exclusively over HTTP at the sidecar boundary. No subprocess spawning. Per the
Bert tenure-3 W3 Q3 + foldback-exception assessment 2026-05-21, dashboard-side plugin
recovery and Python MODULE recovery split cleanly along this HTTP boundary; Python
MODULE recovery routes as a separate Joan-domain follow-up cell.
