import "./styles/site.css";

import { startLight } from "./light.ts";
import { armGuess, askProcessor, download, mac, system } from "./platform.ts";
import { startStory } from "./story.ts";
import { startThemes } from "./themes.ts";

const nav = document.querySelector<HTMLElement>("[data-nav]");
const onScroll = () => nav?.toggleAttribute("data-scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// The download buttons fetch the build for the visitor's machine (platform.ts), and every Mac browser
// claims Intel, so the note under the button offers Intel's too. /downloads/ lists every build.
const pointDownloads = (arm: boolean) => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-download]")) {
    link.href = download(arm);
    if (system === undefined) continue;
    link.querySelector("svg")?.classList.remove("windows");
    link.querySelector("use")?.setAttribute("href", system.mark);
    const name = link.querySelector("[data-download-system]");
    if (name !== null) name.textContent = system.name;
  }
  // The note offers Intel's build while the button may still be Apple silicon's.
  for (const note of document.querySelectorAll<HTMLElement>("[data-mac-intel]")) {
    note.hidden = !(mac && arm);
  }
};

pointDownloads(armGuess);
askProcessor(pointDownloads);

const canvas = document.querySelector<HTMLCanvasElement>("[data-light]");
const hero = document.querySelector<HTMLElement>("[data-hero]");
const window_ = document.querySelector<HTMLElement>("[data-window]");

if (canvas !== null && hero !== null) {
  const light = startLight(canvas);
  canvas.toggleAttribute("data-fallback", light === null);
  // The beam meets the prism on the window's top edge, so the spectrum falls through the glass.
  const aim = () => {
    if (light === null || window_ === null) return;
    const frame = hero.getBoundingClientRect();
    const target = window_.getBoundingClientRect();
    light.aim(target.left - frame.left + target.width * 0.38, target.top - frame.top - 6);
  };
  aim();
  addEventListener("resize", aim);
}

const story = document.querySelector<HTMLElement>("[data-story]");
if (story !== null) startStory(story);

const themes = document.querySelector<HTMLElement>("[data-themes]");
if (themes !== null) startThemes(themes);

// A section's one moment plays once, when most of it has come into view.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.toggleAttribute("data-shown", true);
      reveal.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -30% 0px" },
);
for (const section of document.querySelectorAll("[data-reveal]")) reveal.observe(section);
