import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initializeMiniApp, isMiniApp, telegramWebApp } from "./telegram.ts";
import "./style.css";

await initializeMiniApp();
const bridge = telegramWebApp();
if (isMiniApp()) {
  const html = document.documentElement;
  html.dataset.telegramMiniApp = "";
  const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewportMeta) viewportMeta.content += ", viewport-fit=cover";
  const viewport = window.visualViewport;
  if (viewport) {
    const resize = () => {
      html.style.setProperty("--cineclue-visual-height", `${viewport.height}px`);
      const input = document.activeElement;
      if (input instanceof HTMLInputElement && input.matches(".search-field input")) {
        const visibleBottom = viewport.offsetTop + viewport.height;
        if (input.getBoundingClientRect().bottom + 100 > visibleBottom) {
          input.scrollIntoView({ block: "start" });
        }
      }
    };
    viewport.addEventListener("resize", resize);
    resize();
  }
  bridge?.expand();
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
if (bridge) requestAnimationFrame(() => bridge.ready());
