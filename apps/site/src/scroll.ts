import type Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

export const startScrollEffects = async (lenis: Lenis | undefined) => {
  lenis?.on("scroll", () => ScrollTrigger.update());
  gsap.registerPlugin(ScrollTrigger);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  // Each roster line widens and lights as it crosses the middle of the screen, then dims as it leaves,
  // widening only as far as the page has room for it.
  const roster = [...document.querySelectorAll<HTMLElement>("[data-stretch]")];
  const widest = new Map<HTMLElement, number>();
  const measure = () => {
    const previous = roster.map((line) => line.style.getPropertyValue("--stretch"));
    for (const line of roster) line.style.setProperty("--stretch", "100%");
    for (const line of roster) {
      const words = line.querySelector("span")!;
      const room = (line.clientWidth - words.offsetLeft) / words.offsetWidth;
      widest.set(line, Math.max(70, Math.min(120, room * 90)));
    }
    roster.forEach((line, index) => {
      line.style.setProperty("--stretch", reduced ? `${widest.get(line)}%` : previous[index]!);
    });
  };
  await document.fonts.ready;
  measure();
  addEventListener("resize", measure);
  for (const line of roster) {
    if (reduced) {
      line.style.setProperty("--lit", "1");
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
};
