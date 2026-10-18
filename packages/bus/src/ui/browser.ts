import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cdp } from "./cdp.ts";

// Finding, starting and attaching to a Chromium browser for the UI driver. Cerium bundles no
// browser: it drives the user's Edge or Chrome, or attaches to an app already listening for a
// debugger (an Electron shell started with `--remote-debugging-port`).

export type BrowserKind = "edge" | "chrome";

const candidates = (kind: BrowserKind): ReadonlyArray<string> => {
  const env = process.env;
  if (process.platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env["PROGRAMFILES"], env["LOCALAPPDATA"]].filter(
      (root): root is string => root !== undefined,
    );
    const tail =
      kind === "edge"
        ? ["Microsoft", "Edge", "Application", "msedge.exe"]
        : ["Google", "Chrome", "Application", "chrome.exe"];
    return roots.map((root) => join(root, ...tail));
  }
  if (process.platform === "darwin") {
    return kind === "edge"
      ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  return kind === "edge"
    ? ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
};

/** The installed browser to drive: the one asked for, else Edge, else Chrome. */
export const findBrowser = (prefer?: BrowserKind): string | undefined => {
  const order: ReadonlyArray<BrowserKind> = prefer === "chrome" ? ["chrome", "edge"] : ["edge", "chrome"];
  for (const kind of order) {
    const found = candidates(kind).find((path) => existsSync(path));
    if (found !== undefined) return found;
  }
  return undefined;
};

export interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly webSocketDebuggerUrl: string;
}

const listTargets = async (origin: string): Promise<ReadonlyArray<PageTarget & { type: string }>> => {
  const response = await fetch(`${origin}/json/list`);
  if (!response.ok) throw new Error(`${origin} answered ${response.status}.`);
  return (await response.json()) as ReadonlyArray<PageTarget & { type: string }>;
};

/** A page target at `origin`, preferring one whose URL contains `match`; DevTools' own pages never count. */
export const pickPage = async (origin: string, match?: string): Promise<PageTarget> => {
  const pages = (await listTargets(origin)).filter(
    (target) => target.type === "page" && !target.url.startsWith("devtools://"),
  );
  const page =
    (match === undefined ? undefined : pages.find((target) => target.url.includes(match))) ?? pages[0];
  if (page === undefined) throw new Error(`${origin} has no page to drive.`);
  return page;
};

/** `9222`, `localhost:9222` or `http://127.0.0.1:9222` as an http origin. */
export const debuggerOrigin = (endpoint: string | number): string => {
  const text = String(endpoint).trim();
  if (/^\d+$/.test(text)) return `http://127.0.0.1:${text}`;
  if (/^https?:\/\//.test(text)) return text.replace(/\/+$/, "");
  return `http://${text.replace(/\/+$/, "")}`;
};

export interface LaunchedBrowser {
  readonly origin: string;
  readonly process: ChildProcess;
  close(): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops a process and everything it started; browsers spawn helper processes of their own. */
const killTree = (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
};

/** Stops every process still running on `profile`, for a browser that ignored `Browser.close`. */
const killProfile = (profile: string) => {
  if (process.platform === "win32") {
    const filter = `$_.CommandLine -like '*${profile.replaceAll("'", "''")}*'`;
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { ${filter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
  } else {
    spawnSync("pkill", ["-9", "-f", profile], { stdio: "ignore" });
  }
};

const readPortFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Starts the browser on a fresh profile with a debugging port the OS picks, and waits for it to say
 * which: Chromium writes the port to `DevToolsActivePort` in the profile once it listens.
 */
export const launchBrowser = async (options: {
  readonly executable: string;
  readonly visible: boolean;
  readonly width: number;
  readonly height: number;
}): Promise<LaunchedBrowser> => {
  const profile = mkdtempSync(join(tmpdir(), "cerium-ui-profile-"));
  const child = spawn(
    options.executable,
    [
      ...(options.visible ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${options.width},${options.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-features=Translate,msEdgeSidebarV2,msUndersideButton",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  // The tail of what the browser printed, to say why it failed to start. The pipe keeps draining
  // afterwards so a chatty browser never blocks on a full buffer.
  let output = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    output = (output + chunk).slice(-2_000);
  });
  // The process started may only hand off to the real browser and exit (Edge on Windows does), so
  // closing goes through the browser's own debugging endpoint, then whatever still runs on the profile.
  let browserSocket: string | undefined;
  const close = () => {
    killTree(child);
    void (async () => {
      const closed =
        browserSocket !== undefined &&
        (await Cdp.connect(browserSocket, 3_000)
          .then((cdp) => cdp.send("Browser.close", {}, 3_000).then(() => true))
          .catch((error: unknown) => error instanceof Error && /closed/.test(error.message)));
      if (!closed) killProfile(profile);
      // The profile stays locked for a moment after the browser goes.
      await sleep(1_000);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    })().catch(() => undefined);
  };
  const portFile = join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (child.exitCode !== null && child.exitCode !== 0) break;
    // Windows keeps the file locked while the browser writes it; a busy read retries next round.
    const written = existsSync(portFile) ? readPortFile(portFile) : undefined;
    if (written !== undefined) {
      const [port, path] = written.split("\n").map((line) => line.trim());
      if (port) {
        browserSocket = path ? `ws://127.0.0.1:${port}${path}` : undefined;
        return { origin: `http://127.0.0.1:${port}`, process: child, close };
      }
    }
    await sleep(100);
  }
  close();
  const said = output.trim();
  throw new Error(`${options.executable} did not start a debugging port.${said === "" ? "" : `\n${said}`}`);
};
