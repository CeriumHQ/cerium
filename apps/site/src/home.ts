import "./styles/home.css";
import "./styles/sections.css";
import "./styles/ui.css";

import { startArtifact } from "./artifact.ts";
import { startChrome } from "./chrome.ts";
import type { Prism } from "./prism.ts";
import { savedPalette, setPalette } from "./palette.ts";

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

startChrome({ appOnHandheld: true });

for (const root of document.querySelectorAll<HTMLElement>("[data-split]")) split(root);
// Start the entrance as soon as its display face is ready, independently of below-fold fonts.
const enter = () => document.documentElement.classList.add("ready");
void document.fonts.load('1em "Anybody Variable"').then(enter, enter);

const hero = document.querySelector<HTMLElement>(".hero")!;
const labels = [...hero.querySelectorAll<HTMLElement>("[data-band]")];
labels.forEach((label, i) => label.style.setProperty("--i", String(i)));
// The prism's scene loads on its own, so the headline never waits for three.js.
let prism: Prism | undefined;
/** What tints the prism's glass: the theme's accent, thinned, so the glass stays clear. */
const GLASS = "color-mix(in oklab, var(--accent) 45%, white)";

startArtifact(document.querySelector<HTMLElement>("[data-artifact]")!);

// The closing word is sized to span the page's column.
const word = document.querySelector<HTMLElement>("[data-fit]")!;
const fit = () => {
  word.style.setProperty("--fit", "100px");
  const inner = word.firstElementChild as HTMLElement;
  word.style.setProperty("--fit", `${(100 * word.clientWidth) / inner.offsetWidth}px`);
};
void document.fonts.load('300 1em "Anybody Variable"').then(fit, fit);
addEventListener("resize", fit);

// Picking a theme dresses the whole page in it: the hero's prism, and each picture of the app, which
// was taken in every theme (scripts/shoot.ts).
const pictures = import.meta.glob<string>("./media/app/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});
const shots = [...document.querySelectorAll<HTMLImageElement | HTMLSourceElement>("[data-shot]")];
const picks = [...document.querySelectorAll<HTMLButtonElement>("[data-pick]")];
const pick = (id: string) => {
  setPalette(id);
  for (const button of picks) {
    button.setAttribute("aria-checked", String(button.dataset.pick === id));
    button.tabIndex = button.dataset.pick === id ? 0 : -1;
  }
  const name = picks.find((button) => button.dataset.pick === id)?.textContent.trim() ?? id;
  for (const shot of shots) {
    const phone = shot.hasAttribute("data-phone") ? "-phone" : "";
    const url = pictures[`./media/app/${shot.dataset.shot}-${id}${phone}.webp`];
    if (url === undefined) continue;
    if (shot instanceof HTMLSourceElement) {
      shot.srcset = url;
      continue;
    }
    shot.src = url;
    // The one picture whose description names the theme it is in.
    if (shot.hasAttribute("data-shot-alt"))
      shot.alt = shot.alt.replace(/in the .+ theme/, `in the ${name} theme`);
  }
  prism?.tint(GLASS);
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
  prism.tint(GLASS);
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
