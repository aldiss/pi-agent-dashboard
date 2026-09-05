import fs from "node:fs";
import path from "node:path";
import { createServer } from "../packages/server/src/server.js";

const home = process.env.HOME;
if (!home || !home.startsWith("/tmp/codex-runtime-browser-")) throw new Error("Acceptance server requires its isolated /tmp HOME");
if (!process.send) throw new Error("Acceptance server requires an owned IPC parent");

const raw = JSON.parse(fs.readFileSync(path.join(home, ".pi", "dashboard", "config.json"), "utf8"));
const server = await createServer({
  port: Number(process.argv[2] ?? 0), piPort: Number(process.argv[3] ?? 0), piHost: "127.0.0.1",
  dev: false, fixtureMode: true, autoShutdown: false, shutdownIdleSeconds: 999,
  resurrectionSweepMs: 0, pingInterval: 0, tunnel: false,
  editor: { idleTimeoutMinutes: 10, maxInstances: 1 },
  authConfig: raw.auth, runtimes: raw.runtimes, bridge: { requireToken: false },
  resolvedTrustedNetworks: [],
});

let stopping: Promise<void> | undefined;
function stop() {
  stopping ??= server.stop();
  void stopping.then(() => process.exit(0), () => process.exit(1));
}
process.on("message", (message: unknown) => {
  if ((message as { type?: string })?.type === "stop") stop();
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);

await server.start();
process.send({ type: "ready", pid: process.pid, httpPort: server.httpPort(), piPort: server.piPort() });
