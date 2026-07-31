// Harness-only CJS→ESM shim for @mdi/react (raw tsx ESM interop doesn't surface
// the named `Icon` export the way Vite/vitest do). Not committed source.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mdi = require("@mdi/react");
export const Icon = mdi.Icon ?? mdi.default?.Icon ?? mdi.default;
export const Stack = mdi.Stack;
export default mdi.default ?? mdi;
