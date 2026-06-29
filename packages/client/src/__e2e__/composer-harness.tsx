// Test-only harness for the MobileComposer interaction e2e (qa/composer-interaction).
// Mounts MobileComposer in isolation — NO backend, NO real message sends — with spy
// handlers exposed on window.__e2e so the Playwright spec can assert real handler-fire +
// layout behavior (grow / 200px cap / pointer-events / Enter). Served only by the
// qa/composer-interaction Playwright webServer; never imported by the shipped app, so it
// stays out of the production bundle.
import { createRoot } from "react-dom/client";
import { MobileComposer } from "../components/MobileComposer/MobileComposer.js";
import "../index.css";

declare global {
  interface Window {
    __e2e: {
      sends: Array<{ text: string; imageCount: number }>;
      aborts: number;
      attachClicks: number;
    };
  }
}

window.__e2e = { sends: [], aborts: 0, attachClicks: 0 };

// editorial skin = production-default appearance the operator actually sees.
document.documentElement.setAttribute("data-skin", "editorial");

// The attach (+) button calls fileInputRef.click() on the hidden <input type="file">.
// Catch that click at the document (capture phase), count it, and preventDefault so no
// native picker dialog opens in headless — proves the attach handler fired.
document.addEventListener(
  "click",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest('[data-testid="mobile-composer-file-input"]')) {
      window.__e2e.attachClicks++;
      e.preventDefault();
    }
  },
  true,
);

function Harness() {
  return (
    <div
      id="composer-stage"
      style={{ position: "relative", width: "100%", height: 640, background: "var(--bg-primary, #0a0a0a)" }}
    >
      <MobileComposer
        onSend={(text, images) => {
          window.__e2e.sends.push({ text, imageCount: images?.length ?? 0 });
        }}
        isWorking={true}
        onAbort={() => {
          window.__e2e.aborts++;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
