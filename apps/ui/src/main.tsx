import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.tsx";

// Electron's preload exposes `window.cerium`; anywhere else this is the browser preview.
document.documentElement.dataset["shell"] = "cerium" in window ? "electron" : "browser";
document.documentElement.dataset["theme"] ??= "dark";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
