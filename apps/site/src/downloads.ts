import "./styles/site.css";

import { armGuess, askProcessor, download } from "./platform.ts";

// Every build, with the one the browser says fits this machine marked, and its system's card first
// where the cards stack.
const mark = (arm: boolean) => {
  const path = download(arm);
  for (const card of document.querySelectorAll("[data-system]")) card.removeAttribute("data-yours");
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-build]")) {
    const yours = link.getAttribute("href") === path;
    link.toggleAttribute("data-yours", yours);
    if (yours) link.closest("[data-system]")?.toggleAttribute("data-yours", true);
  }
};

mark(armGuess);
askProcessor(mark);
