import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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

/**
 * A page target at `origin`: the one with id `id` if it is still there, else one whose URL contains
 * `match`, else the first. DevTools' own pages never count.
 */
export const pickPage = async (origin: string, match?: string, id?: string): Promise<PageTarget> => {
  const pages = (await listTargets(origin)).filter(
    (target) => target.type === "page" && !target.url.startsWith("devtools://"),
  );
  const page =
    pages.find((target) => target.id === id) ??
    (match === undefined ? undefined : pages.find((target) => target.url.includes(match))) ??
    pages[0];
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
  /** What `closeBrowser` needs to close it from another process. */
  readonly handle: BrowserHandle;
  /**
   * Closes the browser, settling once it has been told to or killed, and never rejecting. Its
   * profile goes a moment later, which this doesn't wait for.
   */
  close(): Promise<void>;
}

/** The browser's own debugging socket and its profile folder. */
export interface BrowserHandle {
  readonly socket: string | undefined;
  readonly profile: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a command to its end, however that goes. Never synchronously: the backend previews artifacts
 * in its own process, where a wait would hold up every agent and request it serves, and PowerShell
 * alone takes a second or more to start.
 */
const run = (command: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve) => {
    execFile(command, args, { windowsHide: true }, () => resolve());
  });

/** Stops a process and everything it started; browsers spawn helper processes of their own. */
const killTree = async (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  } else {
    child.kill("SIGKILL");
  }
};

/** Stops every process still running on `profile`, for a browser that ignored `Browser.close`. */
const killProfile = (profile: string) => {
  if (process.platform === "win32") {
    const filter = `$_.CommandLine -like '*${profile.replaceAll("'", "''")}*'`;
    return run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { ${filter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ]);
  }
  return run("pkill", ["-9", "-f", profile]);
};

/**
 * Tells a browser `launchBrowser` started to close, through its own debugging endpoint; only when
 * that fails, kills whatever still runs on its profile, and `child`, the process that started it,
 * when this process has it. A browser told to close goes by itself, even if this process exits first.
 */
const shut = async (handle: BrowserHandle, child?: ChildProcess) => {
  const closed =
    handle.socket !== undefined &&
    (await Cdp.connect(handle.socket, 3_000).then(
      // A browser that goes before it answers ends the connection, which may say closed or failed.
      (cdp) =>
        cdp.send("Browser.close", {}, 3_000).then(
          () => true,
          () => cdp.closed,
        ),
      () => false,
    ));
  if (!closed) {
    if (child !== undefined) await killTree(child);
    await killProfile(handle.profile);
  }
};

/** Removes a closed browser's profile, which stays locked for a moment after the browser goes. */
const removeProfile = async (profile: string) => {
  await sleep(1_000);
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
};

/**
 * Closes a browser `launchBrowser` started, through its own debugging endpoint, then whatever still
 * runs on its profile, and removes the profile.
 */
export const closeBrowser = async (handle: BrowserHandle): Promise<void> => {
  await shut(handle);
  await removeProfile(handle.profile);
};

/**
 * Starts a browser on Windows that outlives this process, through PowerShell's `Start-Process`.
 * Node puts its children in a job that dies with it, and hands them every inheritable handle, so a
 * browser it spawned directly either dies with the call or, detached, holds the caller's stdout
 * pipe open and hangs `bun run ui … | tail`. A shell-executed process gets neither. The returned
 * process is PowerShell's, which exits once the browser is started.
 */
const startOutside = (executable: string, flags: ReadonlyArray<string>): ChildProcess => {
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const list = flags.map((flag) => quote(`"${flag}"`)).join(",");
  return spawn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${quote(executable)} -ArgumentList ${list}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
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
  /** Leave the browser running when this process exits, for a later one to drive and close. */
  readonly outlive?: boolean | undefined;
}): Promise<LaunchedBrowser> => {
  const profile = mkdtempSync(join(tmpdir(), "cerium-ui-profile-"));
  // With CERIUM_BROWSER_LOGS naming a folder (CI sets it for the tests), the browser logs to stderr,
  // and everything it prints goes to a file there named after its profile.
  const logs = process.env["CERIUM_BROWSER_LOGS"] || undefined;
  const flags = [
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
    ...(logs === undefined ? [] : ["--enable-logging=stderr"]),
    "about:blank",
  ];
  const child =
    options.outlive === true && process.platform === "win32"
      ? startOutside(options.executable, flags)
      : spawn(options.executable, flags, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  // The tail of what the browser printed, to say why it failed to start. The pipe keeps draining
  // afterwards so a chatty browser never blocks on a full buffer.
  let output = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    output = (output + chunk).slice(-2_000);
  });
  if (logs !== undefined) {
    mkdirSync(logs, { recursive: true });
    child.stderr?.pipe(createWriteStream(join(logs, `${basename(profile)}.log`)));
  }
  // The process started may only hand off to the real browser and exit (Edge on Windows does), so
  // closing goes through the browser's own debugging endpoint, then whatever still runs on the profile.
  // A browser asked first closes cleanly, sparing the kills, which on Windows take seconds.
  let browserSocket: string | undefined;
  const close = async () => {
    await shut({ socket: browserSocket, profile }, child).catch(() => undefined);
    void removeProfile(profile).catch(() => undefined);
  };
  const portFile = join(profile, "DevToolsActivePort");
  // Edge's first start on a loaded two-core CI runner takes up to 20 s, so the wait leaves room.
  for (let waited = 0; waited < 60_000; waited += 100) {
    if (child.exitCode !== null && child.exitCode !== 0) break;
    // Windows keeps the file locked while the browser writes it; a busy read retries next round.
    const written = existsSync(portFile) ? readPortFile(portFile) : undefined;
    if (written !== undefined) {
      const [port, path] = written.split("\n").map((line) => line.trim());
      if (port) {
        browserSocket = path ? `ws://127.0.0.1:${port}${path}` : undefined;
        if (options.outlive === true) {
          child.stderr?.destroy();
          child.unref();
        }
        return {
          origin: `http://127.0.0.1:${port}`,
          process: child,
          handle: { socket: browserSocket, profile },
          close,
        };
      }
    }
    await sleep(100);
  }
  // Waited for, so a caller that exits on the error leaves no browser behind.
  await close();
  const said = output.trim();
  throw new Error(`${options.executable} did not start a debugging port.${said === "" ? "" : `\n${said}`}`);
};
