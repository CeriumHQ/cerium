// Starts Cerium for development in one terminal: the backend (restarting when its code changes), the
// UI's dev server, the desktop shell once the UI answers, and the relay when its Clerk keys are set up
// (apps/relay/.dev.vars, written by apps/relay/scripts/setup-clerk.sh). Each line is labelled with its
// source. When any of them stops (closing the window, say) or on Ctrl+C, all of them stop.
//
// Usage: bun run dev [--browser]
//   --browser  leaves out the desktop shell, for working on the UI at http://localhost:5173

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { styleText } from "node:util";

const root = join(import.meta.dirname, "..");
const uiUrl = "http://localhost:5173";
const browserOnly = process.argv.includes("--browser");

const running = new Set<ChildProcess>();
let stopping = false;

/** Stops every process, each with its whole tree: the dev servers start children of their own. */
const stopAll = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of running) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
};

type Color = Parameters<typeof styleText>[0];

/** Runs one of the root package's scripts, labelling its output. */
const run = (label: string, color: Color, script: string) => {
  const child = spawn("bun", ["run", script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  running.add(child);
  const prefix = styleText(color, label.padEnd(8));
  for (const output of [child.stdout, child.stderr]) {
    createInterface({ input: output }).on("line", (line) => console.log(`${prefix}${line}`));
  }
  child.on("exit", (code) => {
    running.delete(child);
    console.log(`${prefix}${styleText("dim", `stopped (${code ?? "killed"})`)}`);
    stopAll(code ?? 0);
  });
  return child;
};

const uiAnswers = (): Promise<boolean> =>
  fetch(uiUrl).then(
    (response) => response.ok,
    () => false,
  );

/** Resolves once the UI's dev server answers, so the shell's window doesn't load an empty page. */
const uiReady = async () => {
  for (const started = Date.now(); Date.now() - started < 60_000;) {
    if (await uiAnswers()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The UI's dev server didn't answer at ${uiUrl} within a minute.`);
};

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

run("backend", "cyan", "dev:backend");
run("ui", "magenta", "dev:ui");
if (existsSync(join(root, "apps", "relay", ".dev.vars"))) {
  run("relay", "green", "dev:relay");
} else {
  console.log(
    `${styleText("green", "relay".padEnd(8))}${styleText("dim", "not started: run bash apps/relay/scripts/setup-clerk.sh to sign in locally")}`,
  );
}
if (!browserOnly) {
  await uiReady();
  if (!stopping) run("desktop", "yellow", "dev:desktop");
}
