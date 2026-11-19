// What every page shares: smooth scrolling, the top bar hardening once the page moves under it, and
// download buttons that name the visitor's system and fetch its build.

import Lenis from "lenis";

import { armGuess, askProcessor, download, handheld, system } from "./platform.ts";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The primary download buttons fetch this machine's build directly; the bar's goes to the list. */
const pointDownloads = () => {
  const point = (arm: boolean) => {
    for (const text of document.querySelectorAll("[data-download-label]")) {
      text.closest("a")!.href = download(arm);
    }
  };
  for (const text of document.querySelectorAll("[data-download-label]")) {
    text.textContent = `Download for ${system?.name ?? "Windows"}`;
  }
  if (system !== undefined) {
    for (const use of document.querySelectorAll("[data-system-mark] use"))
      use.setAttribute("href", `/icons.svg${system.mark}`);
  }
  point(armGuess);
  askProcessor(point);
};

/** The primary download buttons open the web app instead, which drives the visitor's computer. */
const pointApp = () => {
  for (const text of document.querySelectorAll("[data-download-label]")) {
    text.textContent = "Open the web app";
    text.closest("a")!.href = "/app/";
  }
  for (const use of document.querySelectorAll("[data-system-mark] use"))
    use.setAttribute("href", "/icons.svg#mark-cerium");
};

const smoothScroll = () => {
  let frame = 0;
  const lenis = new Lenis({ lerp: 0.11, anchors: { onStart: wake } });
  function advance(time: number) {
    lenis.raf(time);
    frame = lenis.isScrolling === "smooth" ? requestAnimationFrame(advance) : 0;
  }
  function wake() {
    if (frame) return;
    // Start this gesture's clock at the current frame, excluding the time spent idle.
    lenis.time = Number(document.timeline.currentTime ?? performance.now());
    frame = requestAnimationFrame(advance);
  }
  lenis.on("virtual-scroll", wake);
  return lenis;
};

/** `appOnHandheld`: on a phone or tablet, which runs no build, the download buttons open the web app. */
export const startChrome = ({ appOnHandheld = false } = {}) => {
  const lenis = reduced ? undefined : smoothScroll();
  const bar = document.querySelector<HTMLElement>("[data-bar]");
  const onScroll = () => bar?.toggleAttribute("data-scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (appOnHandheld && handheld) pointApp();
  else pointDownloads();

  return lenis;
};
