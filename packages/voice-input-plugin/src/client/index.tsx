/**
 * Voice-input plugin client barrel.
 *
 * Re-exports the PushToTalkButton component for consumers (currently
 * packages/client CommandInput.tsx — see VOICE-INPUT-LOCAL-PATCH-START block).
 */
export { PushToTalkButton } from "./PushToTalkButton.js";
export type { PushToTalkButtonProps } from "./PushToTalkButton.js";
