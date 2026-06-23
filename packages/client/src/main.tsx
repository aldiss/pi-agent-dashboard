import React from "react";
import ReactDOM from "react-dom/client";
import { Router } from "wouter";
import { LazyMotion, domAnimation } from "motion/react";
import App from "./App.js";
import { ThemeProvider } from "./components/ThemeProvider.js";
import { SkinProvider } from "./components/SkinProvider.js";
import { MobileProvider } from "./hooks/useMobile.js";
import "./index.css";
// KaTeX styles for LaTeX math rendering in MarkdownContent.
// See change: chat-markdown-local-images-and-math.
import "katex/dist/katex.min.css";

// Register service worker for PWA installability
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <ThemeProvider>
        <SkinProvider>
          <MobileProvider>
            {/* LazyMotion + domAnimation: load only the lighter motion feature
                bundle (animations + press/hover gestures) and resolve `m.*`
                components against it, so the motion system never drags the heavy
                feature set into the eager cold-load chunk. */}
            <LazyMotion features={domAnimation} strict>
              <App />
            </LazyMotion>
          </MobileProvider>
        </SkinProvider>
      </ThemeProvider>
    </Router>
  </React.StrictMode>
);
