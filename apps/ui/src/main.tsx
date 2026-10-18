import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.tsx";
import { WEB } from "./backend/target.ts";
import { followVisualViewport } from "./web/viewport.ts";

// Electron's preload exposes `window.cerium`; anywhere else this is the browser preview.
document.documentElement.dataset["shell"] = "cerium" in window ? "electron" : "browser";
document.documentElement.dataset["theme"] ??= "dark";
// The web client (docs/architecture.md §14.10) runs on phones too, with their keyboards and touch.
if (WEB) {
  document.documentElement.dataset["target"] = "web";
  followVisualViewport();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
