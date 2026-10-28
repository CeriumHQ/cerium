import "./styles/home.css";
import "./styles/sections.css";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { startChrome } from "./chrome.ts";
import type { Prism } from "./prism.ts";
import { palettes, savedPalette, setPalette } from "./palette.ts";

gsap.registerPlugin(ScrollTrigger);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Splits a headline's lines into letters the width animation can stretch one by one. */
const split = (root: HTMLElement) => {
  let i = 0;
  for (const line of root.children) {
    const words = (line.textContent ?? "").split(" ");
    line.textContent = "";
    line.setAttribute("aria-hidden", "true");
    words.forEach((word, w) => {
      const span = document.createElement("span");
      span.style.whiteSpace = "nowrap";
      for (const char of word) {
        const letter = document.createElement("span");
        letter.dataset.letter = "";
        letter.style.setProperty("--i", String(i++));
        letter.textContent = char;
        span.append(letter);
      }
      line.append(span);
      if (w < words.length - 1) line.append(" ");
    });
  }
  root.setAttribute("aria-label", [...root.children].map((line) => line.textContent).join(" "));
};

const lenis = startChrome({ appOnHandheld: true });
lenis?.on("scroll", () => ScrollTrigger.update());
for (const root of document.querySelectorAll<HTMLElement>("[data-split]")) split(root);

const hero = document.querySelector<HTMLElement>(".hero")!;
const labels = [...hero.querySelectorAll<HTMLElement>("[data-band]")];
labels.forEach((label, i) => label.style.setProperty("--i", String(i)));
// The prism's scene loads on its own, so the headline never waits for three.js.
let prism: Prism | undefined;

// The app window lies back on the bench and stands up as it scrolls in.
if (!reduced) {
  gsap.fromTo(
    "[data-tilt] .window",
    { rotateX: 32, scale: 0.84, y: -40 },
    {
      rotateX: 0,
      scale: 1,
      y: 0,
      ease: "none",
      scrollTrigger: { trigger: "[data-tilt]", start: "top 95%", end: "top 18%", scrub: 0.6 },
    },
  );
}

// The artifact close-up pulls back as it scrolls through.
if (!reduced) {
  gsap.fromTo(
    ".window-flat",
    { "--zoom": 1.55 },
    {
      "--zoom": 1.22,
      ease: "none",
      scrollTrigger: { trigger: ".window-flat", start: "top bottom", end: "bottom 30%", scrub: 0.6 },
    },
  );
}

// The footage plays only while it is on screen, so the artifact's clip loads when the page nears it.
const footage = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      const video = target as HTMLVideoElement;
      if (isIntersecting) void video.play().catch(() => {});
      else video.pause();
    }
  },
  { rootMargin: "50% 0px" },
);
for (const video of document.querySelectorAll<HTMLVideoElement>("[data-footage]")) footage.observe(video);

// Each roster line widens and lights as it crosses the middle of the screen, then dims as it leaves,
// widening only as far as the page has room for it.
const roster = [...document.querySelectorAll<HTMLElement>("[data-stretch]")];
const widest = new Map<HTMLElement, number>();
const measure = () => {
  for (const line of roster) {
    const was = line.style.getPropertyValue("--stretch");
    line.style.setProperty("--stretch", "100%");
    const words = line.querySelector("span")!;
    const room = (line.clientWidth - words.offsetLeft) / words.offsetWidth;
    line.style.setProperty("--stretch", was);
    widest.set(line, Math.max(70, Math.min(120, room * 90)));
  }
};
await document.fonts.ready;
measure();
addEventListener("resize", measure);
for (const line of roster) {
  if (reduced) {
    line.style.setProperty("--lit", "1");
    line.style.setProperty("--stretch", `${widest.get(line)}%`);
    continue;
  }
  ScrollTrigger.create({
    trigger: line,
    start: "top bottom",
    end: "bottom top",
    onUpdate: ({ progress }) => {
      // 0 at the bottom edge, 1 at the middle, 0 again at the top.
      const near = 1 - Math.min(1, Math.abs(progress - 0.5) / 0.32);
      const eased = near * near * (3 - 2 * near);
      line.style.setProperty("--lit", eased.toFixed(3));
      const wide = widest.get(line) ?? 110;
      line.style.setProperty("--stretch", `${(62 + eased * (wide - 62)).toFixed(1)}%`);
    },
  });
}

// The closing word is sized to span the page.
const word = document.querySelector<HTMLElement>("[data-fit]");
const fit = () => {
  if (word === null) return;
  word.style.setProperty("--fit", "100px");
  const inner = word.firstElementChild as HTMLElement;
  word.style.setProperty("--fit", `${(100 * word.clientWidth * 0.98) / inner.offsetWidth}px`);
};
fit();
addEventListener("resize", fit);

// The glass picker tints the whole page, the hero's prism and the bench light with it.
const shots = [...document.querySelectorAll<HTMLElement>("[data-shot]")];
const picks = [...document.querySelectorAll<HTMLButtonElement>("[data-pick]")];
const pick = (id: string) => {
  setPalette(id);
  for (const button of picks) {
    button.setAttribute("aria-checked", String(button.dataset.pick === id));
    button.tabIndex = button.dataset.pick === id ? 0 : -1;
  }
  for (const shot of shots) shot.toggleAttribute("data-on", shot.dataset.shot === id);
  prism?.tint(palettes[id] ?? "#ffffff");
};
for (const button of picks) button.addEventListener("click", () => pick(button.dataset.pick!));
// Arrow keys move the choice, as a radio group's do.
document.querySelector("[data-picker]")?.addEventListener("keydown", (event) => {
  const key = (event as KeyboardEvent).key;
  const step =
    key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const at = picks.findIndex((button) => button.getAttribute("aria-checked") === "true");
  const next = picks[(at + step + picks.length) % picks.length]!;
  pick(next.dataset.pick!);
  next.focus();
});
pick(savedPalette());

document.documentElement.classList.add("ready");
const { mountPrism } = await import("./prism.ts");
prism = mountPrism(
  hero.querySelector<HTMLCanvasElement>("[data-scene]")!,
  labels.map((label) => ({ label, color: getComputedStyle(label).getPropertyValue("--band").trim() })),
);
if (prism === undefined) {
  hero.toggleAttribute("data-no-webgl", true);
  hero.toggleAttribute("data-lit", true);
} else {
  prism.tint(palettes[savedPalette()] ?? "#ffffff");
  void prism.play();
  // The labels land as their bands reach them.
  setTimeout(() => hero.toggleAttribute("data-lit", true), 1700);
}
