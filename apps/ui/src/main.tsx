import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.tsx";
import { WEB } from "./backend/target.ts";
import { CrashGuard } from "./features/crash/CrashGuard.tsx";
import { AppCrash } from "./features/crash/CrashViews.tsx";
import { renderErrorHandlers, reportUnhandled } from "./features/crash/report.ts";
import { registerServiceWorker } from "./web/push.ts";
import { followThemeColor } from "./web/statusBar.ts";
import { followKeyboard, followVisualViewport } from "./web/viewport.ts";

// Electron's preload exposes `window.cerium`; anywhere else this is the browser preview.
document.documentElement.dataset["shell"] = "cerium" in window ? "electron" : "browser";
// The desktop app's system, which lays out the titlebar around its caption buttons and spells the
// shortcuts (lib/keys.ts). The browser preview takes `?platform=darwin` to stand in for a Mac's.
const platform =
  window.cerium?.platform ??
  (import.meta.env.DEV ? new URLSearchParams(location.search).get("platform") : null);
if (platform) document.documentElement.dataset["platform"] = platform;
// Windows puts Acrylic behind the window and macOS Vibrancy; elsewhere the page paints its own backdrop.
if (window.cerium?.platform === "win32" || window.cerium?.platform === "darwin") {
  document.documentElement.dataset["acrylic"] = "";
}
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

// The desktop shell reports what threw, anonymously and as the user allows (features/crash/report.ts).
reportUnhandled();

createRoot(
  document.getElementById("root")!,
  renderErrorHandlers((boundary) => boundary instanceof CrashGuard && boundary.props.fallback === AppCrash),
).render(
  <StrictMode>
    {/* A view that throws while drawing takes its pane down at most (App's own guards), else the window. */}
    <CrashGuard fallback={AppCrash}>
      <App />
    </CrashGuard>
  </StrictMode>,
);
