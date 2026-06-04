import React from "react";
import ReactDOM from "react-dom/client";
import { Router } from "wouter";
import App from "./App.js";
import { ThemeProvider } from "./components/ThemeProvider.js";
import { MobileProvider } from "./hooks/useMobile.js";
import "./index.css";
// KaTeX styles for LaTeX math rendering in MarkdownContent.
// See change: chat-markdown-local-images-and-math.
import "katex/dist/katex.min.css";

// Register service worker for PWA installability.
//
// Auto-update discipline (operator-direct 2026-06-04 ~17:35 CEST, «надо его сбросить»):
// When a new SW version is deployed (CACHE_VERSION bump in public/sw.js), the
// old SW on iOS PWA continues serving stale precached HTML + bundles. Even after
// the new SW installs + skipWaiting + claims existing clients, the loaded page
// still references the OLD hashed bundle URLs from the stale HTML.
//
// The browser fires `controllerchange` exactly when a new SW takes over via
// clients.claim(). At that moment we force a one-time reload — the next
// navigation refetches HTML through the new SW, which pulls the fresh bundle
// hashes from its updated precache. Guard against reload-loop via a sessionStorage
// flag so we reload AT MOST ONCE per page-session per controller-change event.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      // Poll for SW updates every 15min while the page is open — catches the case
      // where operator keeps the PWA open all day and a new deploy lands mid-session.
      // Browser would otherwise only check on navigation; the explicit update()
      // call forces a byte-diff check against the server.
      setInterval(() => {
        reg.update().catch(() => {});
      }, 15 * 60 * 1000);
    })
    .catch(() => {});

  // Reload when a new SW takes control (e.g., after CACHE_VERSION bump activates).
  // sessionStorage flag prevents loops if anything else triggers controllerchange.
  let alreadyReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (alreadyReloaded) return;
    alreadyReloaded = true;
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <ThemeProvider>
        <MobileProvider>
          <App />
        </MobileProvider>
      </ThemeProvider>
    </Router>
  </React.StrictMode>
);
