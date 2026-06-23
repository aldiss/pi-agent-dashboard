import React, { createContext, useContext, type ReactNode } from "react";
import { useSkin, type SkinState } from "../hooks/useSkin.js";
import { DEFAULT_SKIN } from "../hooks/useSkin.js";

// Default to a no-op state so consumers rendered outside a SkinProvider (e.g.
// in focused component tests that only wrap ThemeProvider) fall back to the
// default skin rather than throwing. At runtime SkinProvider always wraps the
// tree (main.tsx), so the real value is supplied. Mirrors MobileContext, which
// defaults to `false` rather than null.
const SkinContext = createContext<SkinState>({ skin: DEFAULT_SKIN, setSkin: () => {} });

export function SkinProvider({ children }: { children: ReactNode }) {
  const skin = useSkin();
  return <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>;
}

export function useSkinContext(): SkinState {
  return useContext(SkinContext);
}
