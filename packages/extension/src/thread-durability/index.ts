/**
 * Thread-durability bridge — injection + recovery (design v3.6 §C3.1/§C3.2).
 * Barrel export. Wires the B2 durable store to the real pi 0.80.3 executing
 * API + the F1 recovery-scan gate. The drain-to-holder loop that routes real
 * prompts is HELD (Joan A4/B3) — this ships the injection PRIMITIVE only.
 */
export * from "./recover-evidence.js";
export * from "./inject.js";
export * from "./delivery-state-channel.js";
export * from "./terminalize.js";
