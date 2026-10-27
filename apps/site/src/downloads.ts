import "./styles/downloads.css";

import { startChrome } from "./chrome.ts";
import { armGuess, askProcessor, download } from "./platform.ts";

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
