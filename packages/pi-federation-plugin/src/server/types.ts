/**
 * Local type declarations for the federation plugin server entry.
 *
 * Mirrors the shape of `ServerPluginContext` exposed by
 * `@blackbelt-technology/dashboard-plugin-runtime/server`. We declare a
 * narrow local copy so the plugin compiles even when the runtime's
 * exact path/typing changes between minor versions; the loader at
 * `packages/dashboard-plugin-runtime/src/server/loader.ts` only relies
 * on the runtime shape, not the precise type identity.
 */

import type { FastifyInstance } from "fastify";

export interface PluginLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface ServerPluginContext {
  fastify: FastifyInstance;
  sessionManager?: {
    listActive(): unknown[];
    listAll(): unknown[];
    getSession(id: string): unknown;
  };
  eventStore?: unknown;
  broadcastToSubscribers?: (msg: unknown) => void;
  registerPiHandler?: (type: string, handler: (msg: unknown) => void) => void;
  registerBrowserHandler?: (type: string, handler: (msg: unknown, ws: unknown) => void) => void;
  getPluginConfig<T = Record<string, unknown>>(): T;
  updatePluginConfig?<T = Record<string, unknown>>(partial: Partial<T>): Promise<void>;
  logger: PluginLogger;
}
