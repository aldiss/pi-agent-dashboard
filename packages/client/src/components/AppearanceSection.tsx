import React from "react";
import { Icon } from "@mdi/react";
import { mdiWeatherSunny, mdiMonitor, mdiWeatherNight, mdiCheck } from "@mdi/js";
import { useSkinContext } from "./SkinProvider.js";
import { useThemeContext } from "./ThemeProvider.js";
import type { Skin } from "../hooks/useSkin.js";
import type { ThemePreference } from "../hooks/useTheme.js";

const SKIN_OPTIONS: { value: Skin; label: string; blurb: string }[] = [
  { value: "editorial", label: "Editorial Craft", blurb: "Warm, characterful — the slick default" },
  { value: "legacy", label: "Legacy", blurb: "The original flat-gray look" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "Light", icon: mdiWeatherSunny },
  { value: "system", label: "Auto", icon: mdiMonitor },
  { value: "dark", label: "Dark", icon: mdiWeatherNight },
];

/** Settings → General → Appearance.
 *  Skin (Editorial Craft | Legacy) sits beside the Light/Auto/Dark theme
 *  control. The two are independent axes; both live-apply and persist. */
export function AppearanceSection() {
  const { skin, setSkin } = useSkinContext();
  const { preference, setPreference } = useThemeContext();

  return (
    <div className="space-y-4" data-testid="appearance-section">
      {/* Skin selector — two large tappable cards */}
      <div>
        <label className="block text-sm text-[var(--text-secondary)] mb-2">Skin</label>
        <div className="grid grid-cols-2 gap-2" data-testid="skin-selector">
          {SKIN_OPTIONS.map((opt) => {
            const active = skin === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setSkin(opt.value)}
                className={`relative text-left px-3 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                  active
                    ? "border-[var(--accent-primary)] bg-[var(--accent-soft,var(--bg-tertiary))]"
                    : "border-[var(--border-secondary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
                data-testid={`skin-${opt.value}`}
                aria-pressed={active}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-semibold ${active ? "text-[var(--accent-primary)]" : "text-[var(--text-primary)]"}`}>
                    {opt.label}
                  </span>
                  {active && <Icon path={mdiCheck} size={0.6} className="text-[var(--accent-primary)] shrink-0" />}
                </span>
                <span className="block mt-0.5 text-[11px] text-[var(--text-tertiary)] leading-snug">
                  {opt.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Theme preference — Light / Auto / Dark segmented control */}
      <div>
        <label className="block text-sm text-[var(--text-secondary)] mb-2">Theme</label>
        <div
          className="inline-flex rounded-lg border border-[var(--border-secondary)] overflow-hidden"
          data-testid="appearance-theme-toggle"
        >
          {THEME_OPTIONS.map((opt) => {
            const active = preference === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setPreference(opt.value)}
                className={`flex items-center gap-1.5 px-3.5 py-2 text-sm min-h-[44px] transition-colors ${
                  active
                    ? "bg-[var(--accent-soft,var(--bg-tertiary))] text-[var(--accent-primary)] font-medium"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
                data-testid={`appearance-theme-${opt.value}`}
                aria-pressed={active}
              >
                <Icon path={opt.icon} size={0.6} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
