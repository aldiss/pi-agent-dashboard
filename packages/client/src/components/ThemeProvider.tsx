import React, { createContext, useContext, type ReactNode } from "react";
import { useTheme, type ThemeState } from "../hooks/useTheme.js";

// Default to a no-op state so consumers rendered outside a ThemeProvider (e.g.
// focused component tests that don't wrap the full provider stack) fall back to
// sensible defaults rather than throwing. At runtime ThemeProvider always wraps
// the tree (main.tsx). Mirrors SkinContext / MobileContext (default, not null).
const DEFAULT_THEME_STATE: ThemeState = {
  preference: "system",
  resolved: "dark",
  themeName: "base",
  setPreference: () => {},
  setThemeName: () => {},
};

const ThemeContext = createContext<ThemeState>(DEFAULT_THEME_STATE);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useThemeContext(): ThemeState {
  return useContext(ThemeContext);
}
