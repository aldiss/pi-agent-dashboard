/**
 * Deterministic pi-API spawn — INTENT routes (design:
 * deterministic-spawn-designpass-v0.md §3/§8 P0, §11).
 *
 * Two endpoints, both gated on `deterministicSpawnEnabled` (via the injected
 * `getEnabled`): when the flag is OFF every route returns 404, so the dashboard
 * has ZERO behavior-change when unused. Additive, off-default.
 *
 *   POST /api/spawn/intent   — mint a spawn token, record the directive keyed
 *                              BY TOKEN (the AMEND-2 sibling registry), arm the
 *                              spawn-register-watchdog on that token (a
 *                              no-register → `failed{register-timeout}`), and
 *                              return `{ spawnToken }`. The crew CLI then
 *                              launches tmux ONCE with
 *                              PI_DASHBOARD_SPAWN_TOKEN=<token> inline (P1).
 *   GET  /api/spawn/intent/:token — the CLI's poll: return the intent's
 *                              `{ status, sessionId?, reason? }`, or 404 when
 *                              the token is unknown/expired.
 *
 * Readiness is the `session_register` protocol event (no screen-scrape);
 * delivery is one `send_prompt` (the deliver-on-register hook in
 * event-wiring.ts). This route file never touches a tmux pane.
 *
 * See change: deterministic-spawn.
 */
import type { FastifyInstance } from "fastify";
import type { NetworkGuard } from "./route-deps.js";
import type {
  PendingSpawnIntentRegistry,
  SpawnFlavor,
  SpawnDirective,
} from "../pending-spawn-intent-registry.js";
import { mintSpawnToken } from "../spawn-token.js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** The three legal flavors (design §4). Validated at the route boundary. */
const VALID_FLAVORS: readonly SpawnFlavor[] = ["new", "context-rotation", "crash-respawn"];

function isValidFlavor(v: unknown): v is SpawnFlavor {
  return typeof v === "string" && (VALID_FLAVORS as readonly string[]).includes(v);
}

/** Parse + validate the `directive` sub-object. Returns null when malformed. */
function parseDirective(raw: unknown): SpawnDirective | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { text?: unknown; images?: unknown };
  if (typeof d.text !== "string" || d.text.length === 0) return null;
  const directive: SpawnDirective = { text: d.text };
  if (Array.isArray(d.images)) directive.images = d.images as ImageContent[];
  return directive;
}

interface SpawnIntentRequestBody {
  name?: unknown;
  cwd?: unknown;
  flavor?: unknown;
  sessionUuid?: unknown;
  directive?: unknown;
}

export function registerSpawnIntentRoutes(
  fastify: FastifyInstance,
  deps: {
    pendingSpawnIntent: PendingSpawnIntentRegistry;
    networkGuard: NetworkGuard;
    /** Live read of the `deterministicSpawnEnabled` flag. False → routes 404. */
    getEnabled: () => boolean;
    /**
     * Arm the spawn-register-watchdog on the minted token so a no-register
     * times out into the `failed{register-timeout}` terminal (design §6). The
     * watchdog's `onTimeout` → `pendingSpawnIntent.fail(token,…)` wiring lives
     * in server.ts (where the singleton + config live); this route just calls it.
     */
    armWatchdogOnToken: (token: string, cwd: string) => void;
    /** Injectable token mint (tests). Defaults to `mintSpawnToken`. */
    mintToken?: () => string;
  },
) {
  const { pendingSpawnIntent, networkGuard, getEnabled, armWatchdogOnToken } = deps;
  const mint = deps.mintToken ?? mintSpawnToken;

  // POST /api/spawn/intent — record an intent + arm the watchdog, return token.
  fastify.post<{ Body: SpawnIntentRequestBody }>(
    "/api/spawn/intent",
    { preHandler: networkGuard },
    async (request, reply) => {
      // Flag gate: OFF → 404 (route disabled, zero behavior-change).
      if (!getEnabled()) {
        reply.code(404);
        return { error: "deterministic spawn disabled" };
      }

      const body = (request.body ?? {}) as SpawnIntentRequestBody;
      const name = typeof body.name === "string" ? body.name : undefined;
      const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!name || !cwd) {
        reply.code(400);
        return { error: "name and cwd are required strings" };
      }
      if (!isValidFlavor(body.flavor)) {
        reply.code(400);
        return { error: `flavor must be one of ${VALID_FLAVORS.join(", ")}` };
      }
      const directive = parseDirective(body.directive);
      if (!directive) {
        reply.code(400);
        return { error: "directive.text is required" };
      }

      const token = mint();
      pendingSpawnIntent.record({
        spawnToken: token,
        name,
        cwd,
        flavor: body.flavor,
        directive,
      });
      // Arm the register-watchdog so a boot-but-never-register resolves to the
      // deterministic `failed{register-timeout}` terminal (Step 4 / design §6).
      armWatchdogOnToken(token, cwd);

      return { spawnToken: token };
    },
  );

  // GET /api/spawn/intent/:token — the CLI's status poll.
  fastify.get<{ Params: { token: string } }>(
    "/api/spawn/intent/:token",
    { preHandler: networkGuard },
    async (request, reply) => {
      if (!getEnabled()) {
        reply.code(404);
        return { error: "deterministic spawn disabled" };
      }
      const view = pendingSpawnIntent.get(request.params.token);
      if (!view) {
        reply.code(404);
        return { error: "spawn intent not found" };
      }
      return {
        status: view.status,
        ...(view.sessionId ? { sessionId: view.sessionId } : {}),
        ...(view.reason ? { reason: view.reason } : {}),
      };
    },
  );
}
