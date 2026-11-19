import "./styles/home.css";
import "./styles/sections.css";

import { startChrome } from "./chrome.ts";
import type { Prism } from "./prism.ts";
import { palettes, savedPalette, setPalette } from "./palette.ts";

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

for (const root of document.querySelectorAll<HTMLElement>("[data-split]")) split(root);
// Start the entrance as soon as its display face is ready, independently of below-fold fonts.
const enter = () => document.documentElement.classList.add("ready");
void document.fonts.load('1em "Anybody Variable"').then(enter, enter);

const hero = document.querySelector<HTMLElement>(".hero")!;
const labels = [...hero.querySelectorAll<HTMLElement>("[data-band]")];
labels.forEach((label, i) => label.style.setProperty("--i", String(i)));
// The prism's scene loads on its own, so the headline never waits for three.js.
let prism: Prism | undefined;

// The sections start below a full-height hero. Warm them on the first scroll, or immediately
// when opening an anchor or restoring a visit partway down the page.
const startSections = () => {
  void import("./scroll.ts").then(({ startScrollEffects }) => startScrollEffects(lenis));
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
  for (const video of document.querySelectorAll("[data-footage]")) footage.observe(video);
};
if (scrollY > 0 || location.hash) startSections();
else addEventListener("scroll", startSections, { passive: true, once: true });

// The glass picker tints the whole page, the hero's prism and the bench light with it.
const stage = document.querySelector<HTMLElement>("[data-shots]")!;
const previews = stage.querySelector("template")!;
const shots = [...previews.content.querySelectorAll<HTMLImageElement>("[data-shot]")];
const picks = [...document.querySelectorAll<HTMLButtonElement>("[data-pick]")];
// Keep the current screenshot on screen until the visitor's choice can crossfade in.
const warmShot = (id: string) => {
  const shot = shots.find((image) => image.dataset.shot === id)!;
  if (shot.parentElement !== stage) stage.append(shot);
  return shot;
};
const showShot = (shot: HTMLImageElement) => {
  if (shot.dataset.shot !== document.documentElement.dataset.palette) return;
  for (const image of shots) image.toggleAttribute("data-on", image === shot);
};
for (const shot of shots) shot.addEventListener("load", () => showShot(shot));

const pick = (id: string) => {
  setPalette(id);
  for (const button of picks) {
    button.setAttribute("aria-checked", String(button.dataset.pick === id));
    button.tabIndex = button.dataset.pick === id ? 0 : -1;
  }
  const shot = warmShot(id);
  if ((shot.complete && shot.naturalWidth > 0) || !shots.some((image) => image.hasAttribute("data-on"))) {
    showShot(shot);
  }
  prism?.tint(palettes[id] ?? "#ffffff");
};
for (const button of picks) {
  const id = button.dataset.pick!;
  button.addEventListener("pointerenter", () => warmShot(id), { once: true });
  button.addEventListener("focus", () => warmShot(id), { once: true });
  button.addEventListener("click", () => pick(id));
}
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

// A restored scroll position or a link to a lower section can skip the scene entirely.
const canvas = hero.querySelector<HTMLCanvasElement>("[data-scene]")!;
let inView = false;
let loading = false;
const startScene = async () => {
  if (loading || !inView || document.hidden || document.readyState !== "complete") return;
  loading = true;
  const { mountPrism } = await import("./prism.ts");
  if (!inView || document.hidden) {
    loading = false;
    return;
  }
  seen.disconnect();
  document.removeEventListener("visibilitychange", startScene);
  prism = mountPrism(
    canvas,
    labels.map((label) => ({ label, color: getComputedStyle(label).getPropertyValue("--band").trim() })),
  );
  if (prism === undefined) {
    hero.toggleAttribute("data-no-webgl", true);
    hero.toggleAttribute("data-lit", true);
    return;
  }
  prism.tint(palettes[savedPalette()] ?? "#ffffff");
  prism.play();
  // The labels land as their bands reach them.
  setTimeout(() => hero.toggleAttribute("data-lit", true), 1700);
};
const seen = new IntersectionObserver(
  ([entry]) => {
    inView = entry!.intersectionRatio >= 0.001;
    void startScene();
  },
  { threshold: 0.001 },
);
seen.observe(hero);
addEventListener("load", startScene, { once: true });
document.addEventListener("visibilitychange", startScene);
