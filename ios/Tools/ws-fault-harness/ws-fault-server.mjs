// Dependency-free WebSocket server that speaks enough of the pi-dashboard
// browser protocol to exercise the iOS client, plus deliberate fault injection.
//
// Modes:
//   stall   — after N seconds stop sending AND stop answering; TCP stays open.
//             (models a 5G NAT timeout / silent path loss: no FIN, no RST)
//   close   — after N seconds send a proper WS close frame
//   destroy — after N seconds destroy the TCP socket (FIN/RST)
//   alive   — never fault; answer app-level {"type":"ping"} with {"type":"pong"}
//
// Every frame received from the client is appended to --trace as JSONL so the
// test can assert on what the client actually sent (e.g. re-subscribe).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const MODE = args.mode ?? "alive";
const AFTER_MS = Number(args.after ?? 3) * 1000;
const PORT = Number(args.port ?? 8791);
const TRACE = args.trace ?? "/tmp/portico5/trace.jsonl";
const APP_PONG = args.pong !== "off";
const LATE_ECHO = args.lateEcho === "on";
const RESET_CYCLE = args.resetCycle === "on";
const PROMPT_CYCLE = args.promptCycle === "on";
const PROMPT_DUPLICATE = args.promptDuplicate === "on";
let connectionCount = 0;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2);
fs.writeFileSync(TRACE, "");
function trace(rec) {
  fs.appendFileSync(TRACE, JSON.stringify({ t: Number(el()), ...rec }) + "\n");
  console.error(`[srv ${el()}s]`, JSON.stringify(rec));
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// Minimal incremental frame parser (client frames are always masked).
function makeParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      onFrame(opcode, payload);
    }
  };
}

const snapshot = {
  type: "sessions_snapshot",
  sessions: [
    {
      id: "sess-probe-1",
      cwd: "/tmp/probe",
      status: "working",
      startedAt: Date.now(),
      lastActivity: Date.now(),
    },
  ],
  orders: { "/tmp/probe": ["sess-probe-1"] },
};

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "probe", mode: "production", uptime: 1, pid: process.pid }));
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket) => {
  const connectionNumber = ++connectionCount;
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  trace({ ev: "upgraded", path: req.url });

  let faulted = false;
  const send = (obj) => {
    if (faulted) return;
    socket.write(encodeFrame(JSON.stringify(obj)));
    trace({ ev: "sent", type: obj.type });
  };

  send(snapshot);

  const parser = makeParser((opcode, payload) => {
    if (opcode === 0x8) {
      trace({ ev: "client_close" });
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      // protocol-level ping from client
      trace({ ev: "rx_ws_ping" });
      if (!faulted) socket.write(encodeFrame(payload, 0xa));
      return;
    }
    if (opcode === 0xa) {
      trace({ ev: "rx_ws_pong" });
      return;
    }
    if (opcode !== 0x1) return;
    const text = payload.toString("utf8");
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      trace({ ev: "rx_unparsable", text });
      return;
    }
    trace({ ev: "rx", type: msg.type, sessionId: msg.sessionId });
    if (msg.type === "ping" && APP_PONG) send({ type: "pong" });
    if (msg.type === "prompt_response") {
      trace({ ev: "rx_prompt_response", promptId: msg.promptId,
              answer: msg.answer, cancelled: msg.cancelled, source: msg.source });
      send({ type: "prompt_dismiss", sessionId: msg.sessionId, promptId: msg.promptId });
    }
    if (msg.type === "subscribe") {
      if (RESET_CYCLE && connectionNumber === 1) {
        // Establish an old server sequence namespace at 100.
        send({
          type: "event", sessionId: msg.sessionId, seq: 100,
          event: { eventType: "message_start", timestamp: Date.now(),
            data: { message: { role: "user", content: "before reset" } } },
        });
      } else if (RESET_CYCLE) {
        // Rebuilt server starts at seq 1. Native must clear its old cursor and
        // accept both the replay and the following live event.
        send({ type: "session_state_reset", sessionId: msg.sessionId });
        send({ type: "event_replay", sessionId: msg.sessionId, isLast: true, events: [
          { seq: 1, event: { eventType: "message_start", timestamp: Date.now(),
            data: { message: { role: "user", content: "after reset replay" } } } },
        ] });
        send({ type: "event", sessionId: msg.sessionId, seq: 2,
          event: { eventType: "message_start", timestamp: Date.now(),
            data: { message: { role: "user", content: "after reset live" } } },
        });
      } else {
        send({ type: "event_replay", sessionId: msg.sessionId, events: [], isLast: true });
      }
      if (PROMPT_CYCLE && connectionNumber === 1) {
        const prompt = {
          type: "prompt_request",
          sessionId: msg.sessionId,
          promptId: "prompt-1",
          prompt: {
            question: "Choose target",
            type: "select",
            options: ["A", "B"],
            metadata: { message: "Round-trip probe" },
          },
          component: { type: "generic-dialog", props: {} },
          placement: "inline",
        };
        send(prompt);
        if (PROMPT_DUPLICATE) send({ ...prompt, promptId: "prompt-2" });
      }
      // After recovery, deliver the real server echo that the black-holed first
      // socket could not acknowledge. No queueNonce: this matches persisted replay.
      if (!RESET_CYCLE && LATE_ECHO && connectionNumber > 1) {
        send({
          type: "event",
          sessionId: msg.sessionId,
          seq: 1,
          event: {
            eventType: "message_start",
            timestamp: Date.now(),
            data: {
              message: {
                role: "user",
                content: '<speaker id="probe" name="Probe" nonce="late-secret">\nloss probe\n</speaker nonce="late-secret">',
              },
            },
          },
        });
      }
    }
  });

  socket.on("data", (c) => {
    if (faulted && MODE === "stall") {
      trace({ ev: "rx_dropped_while_stalled", bytes: c.length });
      return; // black hole: read it, answer nothing
    }
    parser(c);
  });
  socket.on("error", () => {});
  socket.on("close", () => trace({ ev: "socket_closed" }));

  if (MODE !== "alive") {
    setTimeout(() => {
      faulted = true;
      if (MODE === "stall") {
        trace({ ev: "FAULT_stall", note: "socket held open, all traffic ignored" });
      } else if (MODE === "close") {
        trace({ ev: "FAULT_close" });
        socket.write(encodeFrame(Buffer.from([0x03, 0xe8]), 0x8));
        setTimeout(() => socket.destroy(), 200);
      } else if (MODE === "destroy") {
        trace({ ev: "FAULT_destroy" });
        socket.destroy();
      }
    }, AFTER_MS);
  }

  // Heartbeat of real traffic so "alive" mode is distinguishable from stall.
  const beat = setInterval(() => {
    send({ type: "session_updated", sessionId: "sess-probe-1", updates: { lastActivity: Date.now() } });
  }, 5000);
  socket.on("close", () => clearInterval(beat));
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[srv] mode=${MODE} after=${AFTER_MS}ms appPong=${APP_PONG} on 127.0.0.1:${PORT}`);
});
