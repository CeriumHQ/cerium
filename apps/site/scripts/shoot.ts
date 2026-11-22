// Takes the website's pictures of the app, in every theme, from the threads `stage.ts` staged: the
// app as it opens, the thread a lead hands work out in, a turn another lab reviewed, and an
// automation, as a desktop window and as a phone shows them. Run it again whenever the app's interface changes.
//
//   node apps/site/scripts/shoot.ts <dir> [palette...]
//
// `<dir>` is the staged folder, with a backend running over it (see stage.ts) and the UI's dev server
// up. Pictures go to src/media/app as <name>-<palette>.webp; with no palette named, every theme's.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { palettes } from "../src/palette.ts";

const [target, ...named] = process.argv.slice(2);
if (target === undefined) {
  console.error("shoot needs the folder stage.ts staged.");
  process.exit(1);
}
const dir = resolve(target);
const out = join(import.meta.dirname, "..", "src", "media", "app");
const capture = join(import.meta.dirname, "capture.ts");
// The moment the staged work ended, so every picture reads "now" and "1h" as the first did.
const clock = readFileSync(join(dir, "staged-at"), "utf8").trim();

const THREAD = "click=Add rate limiting to jobs";
const REVIEWED = "click=Add AbortSignal cancellation";
/** The pointer leaves what it clicked for an empty part of the sidebar, so nothing is drawn hovered. */
const REST = ["hover=@190,780", "sleep=1200"];
/** One element's picture: a JSON step, since a selector may hold an `=`. */
const crop = (selector: string, name: string) => JSON.stringify({ action: "shot", selector, value: name });
/** A turn's changed files with the review under them. */
const REVIEW = 'section:has(> section[aria-label^="Review by"])';

const DESKTOP = "1440x960";
const PHONE = "412x892";

const shots = (
  palette: string,
): ReadonlyArray<readonly [size: string, scale: number, ...steps: Array<string>]> => [
  [
    DESKTOP,
    2,
    `shot=home-${palette}`,
    THREAD,
    ...REST,
    `shot=thread-${palette}`,
    REVIEWED,
    ...REST,
    crop(REVIEW, `review-${palette}`),
  ],
  // A shorter window, so the automation's panel ends where what it holds does.
  [
    "1440x770",
    2,
    "click=Automations",
    "sleep=1200",
    "click=Fix failing CI",
    "hover=@500,600",
    "sleep=1200",
    crop("main aside", `automation-${palette}`),
  ],
  [PHONE, 3, `shot=home-${palette}-phone`, THREAD, "sleep=1500", `shot=thread-${palette}-phone`],
  // A taller phone, so the whole review shows below the thread's header.
  ["412x1200", 3, REVIEWED, "sleep=1500", crop(REVIEW, `review-${palette}-phone`)],
];

for (const palette of named.length > 0 ? named : palettes) {
  for (const [size, scale, ...steps] of shots(palette)) {
    execFileSync(
      process.execPath,
      [
        capture,
        `--connection=${join(dir, "connection.json")}`,
        `--out=${out}`,
        `--size=${size}`,
        `--scale=${scale}`,
        `--palette=${palette}`,
        `--clock=${clock}`,
        "--opaque",
        "--format=webp",
        "sleep=2500",
        ...steps,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  console.log(`Shot ${palette}.`);
}
