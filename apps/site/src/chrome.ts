// What every page shares: smooth scrolling, the top bar hardening once the page moves under it, and
// download buttons that name the visitor's system and fetch its build.

import Lenis from "lenis";

import { armGuess, askProcessor, download, system } from "./platform.ts";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const startChrome = () => {
  const lenis = reduced ? undefined : new Lenis({ lerp: 0.11, anchors: true });
  if (lenis !== undefined) {
    const raf = (time: number) => {
      lenis.raf(time);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }

  const bar = document.querySelector<HTMLElement>("[data-bar]");
  const onScroll = () => bar?.toggleAttribute("data-scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // The primary download buttons fetch this machine's build directly; the bar's goes to the list.
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

  return lenis;
};
