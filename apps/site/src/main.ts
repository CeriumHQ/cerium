import "./styles/site.css";

import { startLight } from "./light.ts";
import { startStory } from "./story.ts";
import { startThemes } from "./themes.ts";

const nav = document.querySelector<HTMLElement>("[data-nav]");
const onScroll = () => nav?.toggleAttribute("data-scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// The download buttons fetch Windows' x64 installer. A visitor on Linux gets the package their
// distribution installs when their browser names it (Ubuntu's and Fedora's Firefox do), else the
// AppImage; on an Arm64 processor, each one's Arm64 build. Chromium names the processor only when
// asked, and other browsers on Windows never do.
const userAgent = navigator.userAgent;
const linux = /Linux/.test(userAgent) && !/Android/.test(userAgent);
const hints = (
  navigator as Navigator & {
    readonly userAgentData?: {
      getHighEntropyValues(hints: ReadonlyArray<string>): Promise<{ readonly architecture?: string }>;
    };
  }
).userAgentData;

const download = (arm: boolean) => {
  if (!linux) return arm && /Windows/.test(userAgent) ? "/download/windows-arm64" : undefined;
  const kind = /Ubuntu|Debian|Mint/.test(userAgent)
    ? "deb"
    : /Fedora|Red Hat/.test(userAgent)
      ? "rpm"
      : "linux";
  return `/download/${kind}${arm ? "-arm64" : ""}`;
};

const pointDownloads = (arm: boolean) => {
  const href = download(arm);
  if (href === undefined) return;
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-download]")) {
    link.href = href;
    if (!linux) continue;
    link.querySelector("svg")?.classList.remove("windows");
    link.querySelector("use")?.setAttribute("href", "#mark-linux");
    const system = link.querySelector("[data-download-system]");
    if (system !== null) system.textContent = "Linux";
  }
};

pointDownloads(/aarch64|arm64/i.test(userAgent));
void hints
  ?.getHighEntropyValues(["architecture"])
  .then(({ architecture }) => {
    if (architecture === "arm") pointDownloads(true);
  })
  .catch(() => undefined);

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
