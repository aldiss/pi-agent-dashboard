/**
 * Voice-input plugin barrel re-export.
 *
 * Top-level (".") export re-exports the client surface for convenience.
 * Consumers typically import from "./client" (UI) or "./server" (Fastify wiring) directly.
 */
export * from "./client/index.js";
