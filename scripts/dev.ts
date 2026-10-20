// Starts Cerium for development in one terminal: the backend (restarting when its code changes), the
// UI's dev server, the desktop shell once the UI answers, and the relay when its Clerk keys are set up
// (apps/relay/.dev.vars, written by apps/relay/scripts/setup-clerk.sh). Each line is labelled with its
// source. When any of them stops (closing the window, say) or on Ctrl+C, all of them stop.
//
// The UI is served on the first free port from 5173, whose URL is written to .cerium-dev/ui-url while
// it runs. When this checkout's dev servers already run, they are reused: `--browser` only says where,
// and the full command starts just the desktop shell against them.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { styleText } from "node:util";

const root = join(import.meta.dirname, "..");
const urlFile = join(root, ".cerium-dev", "ui-url");

const USAGE = `bun run dev [--browser]
  --browser  leaves out the desktop shell, for working on the UI in a browser`;

// Any other flag, --help included, prints the usage and starts nothing.
const flags = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = flags.filter((flag) => flag !== "--browser");
if (unknown.length > 0) {
  if (unknown.every((flag) => flag === "--help" || flag === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  console.error(`Unknown option ${unknown.join(" ")}.\n\n${USAGE}`);
  process.exit(1);
}
const browserOnly = flags.includes("--browser");

// T3 Code runs its agents with ELECTRON_RUN_AS_NODE set, which would start the desktop shell as plain Node.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;

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
  if (ownsUrlFile) rmSync(urlFile, { force: true });
  process.exit(code);
};

type Color = Parameters<typeof styleText>[0];

/** Runs one of the root package's scripts, labelling its output. */
const run = (label: string, color: Color, script: string, args: ReadonlyArray<string> = []) => {
  const child = spawn("bun", ["run", script, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...inherited, FORCE_COLOR: "1" },
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

const uiAnswers = (url: string): Promise<boolean> =>
  fetch(url).then(
    (response) => response.ok,
    () => false,
  );

/** Resolves once the UI's dev server answers, so the shell's window doesn't load an empty page. */
const uiReady = async (url: string) => {
  for (const started = Date.now(); Date.now() - started < 60_000;) {
    if (await uiAnswers(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The UI's dev server didn't answer at ${url} within a minute.`);
};

const freeOn = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, host);
  });

/** Free on both loopbacks: Vite's `localhost` may be either, and another server may hold just one. */
const portFree = async (port: number) => (await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"));

/** The first free port from 5173: another checkout or app may hold the usual one. */
const freePort = async () => {
  for (let port = 5173; port < 5273; port++) if (await portFree(port)) return port;
  throw new Error("No free port for the UI's dev server between 5173 and 5272.");
};

/** Whether this process started the servers .cerium-dev/ui-url points at, and so removes it on stopping. */
let ownsUrlFile = false;

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

const earlier = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "";
if (earlier !== "" && (await uiAnswers(earlier))) {
  console.log(`Cerium's dev servers already run for this checkout, with the UI at ${earlier}`);
  if (browserOnly) process.exit(0);
  run("desktop", "yellow", "dev:desktop", [`--dev-url=${earlier}`]);
} else {
  const port = await freePort();
  const uiUrl = `http://localhost:${port}`;
  run("backend", "cyan", "dev:backend");
  run("ui", "magenta", "dev:ui", [`--port=${port}`]);
  if (existsSync(join(root, "apps", "relay", ".dev.vars"))) {
    run("relay", "green", "dev:relay");
  } else {
    console.log(
      `${styleText("green", "relay".padEnd(8))}${styleText("dim", "not started: run bash apps/relay/scripts/setup-clerk.sh to sign in locally")}`,
    );
  }
  await uiReady(uiUrl);
  if (!stopping) {
    mkdirSync(join(root, ".cerium-dev"), { recursive: true });
    writeFileSync(urlFile, `${uiUrl}\n`);
    ownsUrlFile = true;
    console.log(`${styleText("magenta", "ui".padEnd(8))}${uiUrl} (also in .cerium-dev/ui-url)`);
    if (!browserOnly) run("desktop", "yellow", "dev:desktop", [`--dev-url=${uiUrl}`]);
  }
}
