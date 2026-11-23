import "./styles/downloads.css";

import { startChrome } from "./chrome.ts";
import { armGuess, askProcessor, download, handheld, linux, mac } from "./platform.ts";

startChrome();

// Every build, with the one the browser says fits this machine marked, and its system's slab first
// where the slabs stack.
const mark = (arm: boolean) => {
  const path = download(arm);
  for (const system of document.querySelectorAll("[data-system]")) system.removeAttribute("data-yours");
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-build]")) {
    const yours = link.getAttribute("href") === path;
    link.toggleAttribute("data-yours", yours);
    if (yours) link.closest("[data-system]")?.toggleAttribute("data-yours", true);
  }
};

mark(armGuess);
askProcessor(mark);

const hostOs =
  linux || mac ? "unix" : !handheld && /Windows/.test(navigator.userAgent) ? "windows" : undefined;
if (hostOs !== undefined) {
  document.querySelector(`[data-host-os="${hostOs}"]`)?.toggleAttribute("data-yours", true);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  let reset: number | undefined;
  button.addEventListener("click", () => {
    const text = button.dataset["copy"];
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        button.textContent = "Copied";
        button.dataset["copied"] = "true";
        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          button.textContent = "Copy";
          delete button.dataset["copied"];
        }, 1800);
      })
      .catch(() => undefined);
  });
}
