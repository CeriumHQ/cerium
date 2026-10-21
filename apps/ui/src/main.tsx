import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.tsx";
import { WEB } from "./backend/target.ts";
import { registerServiceWorker } from "./web/push.ts";
import { followThemeColor } from "./web/statusBar.ts";
import { followKeyboard, followVisualViewport } from "./web/viewport.ts";

// Electron's preload exposes `window.cerium`; anywhere else this is the browser preview.
document.documentElement.dataset["shell"] = "cerium" in window ? "electron" : "browser";
// Only Windows puts Acrylic behind the window; elsewhere the page paints its own backdrop.
if (window.cerium?.platform === "win32") document.documentElement.dataset["acrylic"] = "";
document.documentElement.dataset["theme"] ??= "dark";
// The web client runs on phones too, with their keyboards and touch.
if (WEB) {
  document.documentElement.dataset["target"] = "web";
  followVisualViewport();
  followThemeColor();
  // Shows push notifications and opens their threads.
  if ("serviceWorker" in navigator) void registerServiceWorker().catch(() => undefined);
}
// The browser preview stands in for the web client at phone size, keyboard included.
if (WEB || document.documentElement.dataset["shell"] === "browser") followKeyboard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
