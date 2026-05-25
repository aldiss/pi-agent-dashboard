import { useState } from "react";
import { useInstallPrompt } from "../hooks/useInstallPrompt.js";

const STORAGE_KEY = "pi-dashboard-ios-install-coach-dismissed";

/**
 * W6: iOS install coaching modal (RedHawk §2 item 6; UNLOCKS Web Push on iPhone PWA).
 *
 * Renders ONCE on first iOS Safari visit when:
 * - User is on iOS Safari (UA-detect via useInstallPrompt.isIOS)
 * - PWA is NOT already installed (display-mode != standalone via useInstallPrompt.isInstalled)
 * - Modal has NOT been previously dismissed (localStorage flag)
 *
 * On dismiss: writes localStorage flag → suppresses re-show on subsequent visits.
 * Backdrop click does NOT dismiss (would cause accidental dismiss losing coaching opportunity);
 * only the explicit "Got it" button dismisses + sets the localStorage flag.
 *
 * Composes with W2/W3 safe-area + keyboard infrastructure: dialog respects safe-area-inset-bottom
 * for notched iPhones; modal uses bg-overlay (var) + dark theme tokens for visual coherence with
 * dashboard chrome.
 */
export function IOSInstallCoachModal() {
  const { isIOS, isInstalled } = useInstallPrompt();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return true; // SSR / privacy-mode fallback: don't show
    }
  });

  // Show only on iOS Safari, not when PWA-installed, and not previously dismissed.
  if (!isIOS || isInstalled || dismissed) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // privacy-mode: dismiss-this-session only; will re-show on next reload (acceptable degradation)
    }
    setDismissed(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ backgroundColor: "var(--bg-overlay)" }}
      aria-modal="true"
      role="dialog"
      aria-labelledby="ios-install-coach-title"
    >
      <div
        className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-2xl p-6 text-[var(--text-primary)] shadow-xl"
        style={{
          paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <h2 id="ios-install-coach-title" className="text-xl font-semibold mb-3">
          Add to Home Screen
        </h2>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          Install pi-dashboard as a Progressive Web App for full-screen launch, push notifications, and a native-feeling home-screen icon.
        </p>
        <ol className="text-sm text-[var(--text-secondary)] space-y-2 mb-6 list-decimal list-inside">
          <li>
            Tap the <strong className="text-[var(--text-primary)]">Share</strong> button (square with up-arrow).
          </li>
          <li>
            Scroll down and tap <strong className="text-[var(--text-primary)]">"Add to Home Screen"</strong>.
          </li>
          <li>
            Tap <strong className="text-[var(--text-primary)]">Add</strong> to confirm.
          </li>
          <li>Launch pi-dashboard from your home screen for the full PWA experience.</li>
        </ol>
        <button
          type="button"
          onClick={handleDismiss}
          className="w-full min-h-[44px] py-2 px-4 bg-[var(--accent-blue)] text-white rounded-lg hover:opacity-90 active:scale-95 transition-all font-medium"
          data-testid="ios-install-coach-dismiss"
        >
          Got it, don't show again
        </button>
      </div>
    </div>
  );
}
