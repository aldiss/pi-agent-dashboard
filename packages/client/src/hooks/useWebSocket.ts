import { useEffect, useRef, useCallback, useState } from "react";
import type { ServerToBrowserMessage, BrowserToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import { getApiBase } from "../lib/api-context.js";

export type ConnectionStatus = "connected" | "connecting" | "offline" | "auth_required";

const OFFLINE_THRESHOLD = 3;

// Keep-alive ping interval. iOS Safari aggressively kills idle WebSocket
// connections after ~30-60 seconds of no traffic (especially when the PWA
// goes to background or screen locks); sending a ping every 25s keeps the
// socket alive at the TCP+protocol level. Server responds with `pong`;
// missing pongs are tracked as liveness signal for proactive reconnect.
// Sister-shape to pi-gateway.ts WS_PING_INTERVAL (cell→server tier).
const PING_INTERVAL_MS = 25_000;
// Max pongs missed before proactively closing the socket to trigger reconnect.
// (Without this, a half-dead socket from Safari's kill can take minutes to
// surface via onclose.)
const MAX_PONG_MISS = 2;

export function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const handlersRef = useRef<((msg: ServerToBrowserMessage) => void)[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(1000);
  const failCountRef = useRef(0);
  // Track the latest connect() closure so the visibilitychange handler at
  // module-tier can fire it after the React closure-binding cycle. Sister to
  // pingTimer closure capture in connect() itself.
  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let pongMissed = 0;

      ws.onopen = () => {
        setStatus("connected");
        backoffRef.current = 1000;
        failCountRef.current = 0;
        // Start keep-alive ping interval. Each tick: send ping, increment
        // pongMissed counter; reset to 0 on pong receipt (in onmessage).
        // If pongMissed >= MAX_PONG_MISS, proactively close to trigger reconnect.
        pongMissed = 0;
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (pongMissed >= MAX_PONG_MISS) {
            // Half-dead socket (Safari background-kill etc); proactively close
            // so onclose fires the reconnect path quickly.
            try { ws.close(); } catch { /* defensive */ }
            return;
          }
          try {
            ws.send(JSON.stringify({ type: "ping" }));
            pongMissed++;
          } catch {
            /* defensive: send may throw if socket transitioned mid-frame */
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ServerToBrowserMessage;
          // Intercept pong before forwarding to handlers: reset miss-counter,
          // do NOT pass to subscribers (no consumer needs it).
          if ((msg as any).type === "pong") {
            pongMissed = 0;
            return;
          }
          for (const handler of handlersRef.current) {
            handler(msg);
          }
        } catch {
          // Ignore malformed
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        failCountRef.current++;
        if (failCountRef.current >= OFFLINE_THRESHOLD) {
          // Check if it's an auth issue before marking as offline
          fetch(`${getApiBase()}/auth/status`)
            .then((res) => res.json())
            .then((data) => {
              if (data.authenticated === false) {
                setStatus("auth_required");
              } else {
                setStatus("offline");
              }
            })
            .catch(() => setStatus("offline"));
        } else {
          setStatus("connecting");
        }
        reconnectTimerRef.current = setTimeout(() => {
          backoffRef.current = Math.min(backoffRef.current * 2, 30000);
          connect();
        }, backoffRef.current);
      };

      ws.onerror = () => {
        // onclose will handle reconnection
      };
    } catch {
      failCountRef.current++;
      if (failCountRef.current >= OFFLINE_THRESHOLD) {
        setStatus("offline");
      } else {
        setStatus("connecting");
      }
    }
  }, [url]);

  useEffect(() => {
    connectRef.current = connect;
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      connectRef.current = null;
    };
  }, [connect]);

  // Visibility-change reconnect handler — addresses iOS Safari PWA stale-view
  // symptom per operator-direct empirical 2026-05-31 ~22:18 CEST verbatim
  // («вотъ онъ до сихъ поръ мнѣ рендеритъ собщеяни за пять минутъ назадъ») +
  // «ну я переубилъ pwa - всё равно медленно». The keepalive ping (25s) +
  // miss-counter mitigation per d03c6cc is necessary-but-insufficient because
  // iOS Safari throttles/pauses setInterval when the tab is backgrounded OR
  // the device is screen-locked; by the time the PWA is foregrounded the
  // socket is OS-killed but onclose may not have fired yet (or reconnect is
  // mid-backoff with stale state). On visibilitychange→visible, proactively:
  // (i) cancel any pending reconnect-backoff timer; (ii) if the socket is
  // not OPEN OR we've missed any pongs, close + reconnect immediately so
  // event stream resumes within ~1s instead of minutes. Sister-shape to
  // PushToTalkButton.tsx L411-422 visibility-handler discipline.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const ws = wsRef.current;
      const sockNotOpen = !ws || ws.readyState !== WebSocket.OPEN;
      if (!sockNotOpen) return; // Healthy socket; let keepalive cycle continue.
      // Cancel pending reconnect-backoff so we reconnect immediately.
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      // Reset backoff so the post-foreground reconnect doesn't inherit a long
      // backoff from prior failures (operator-foreground signal trumps backoff).
      backoffRef.current = 1000;
      if (ws) {
        ws.onclose = null; // Suppress duplicate reconnect from the explicit close.
        try { ws.close(); } catch { /* defensive */ }
      }
      const fn = connectRef.current;
      if (fn) fn();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const send = useCallback((msg: BrowserToServerMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const onMessage = useCallback((handler: (msg: ServerToBrowserMessage) => void) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  return { send, onMessage, status };
}
