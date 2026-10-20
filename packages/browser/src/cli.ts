// `bun run ui`: see and use a web UI like a user, from any shell. `open` starts a headless Edge or
// Chrome (or attaches to an app's debugging port) that stays up between calls; `act` runs a batch of
// steps and saves one screenshot at the end; `shot` and `inspect` look without acting. Every call
// prints one line of JSON, with the path of any screenshot it saved, and exits 1 when a step failed.
// A session nobody used for an hour is closed by the next call.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeBrowser,
  debuggerOrigin,
  findBrowser,
  launchBrowser,
  pickPage,
  type BrowserHandle,
  type BrowserKind,
} from "./browser.ts";
import { Page, type Target } from "./page.ts";
import { parseStep, parseTarget, runStep, type Step } from "./steps.ts";

const HELP = `bun run ui <command> [options]

  open [url]          open a page; again to navigate, keeping the browser
    --attach=9222       drive an app already listening for a debugger instead (bun run dev's shell: 9222)
    --match=text        with --attach, the page whose URL contains this
    --width=1280 --height=800 --scale=1 --mobile
    --dark | --light    the colour scheme the page sees
    --visible           show the window; default headless
    --browser=edge|chrome
  act <step>...       run steps in order; the first that fails stops the rest
  shot                screenshot the page as it is
  inspect [--text]    the page's controls, headings, dialogs and console as JSON
  close               close the page and the browser opened for it

  Steps:  click=Send  rightClick=… doubleClick=… hover=…  wait=Saved  waitGone=Loading  (wait@Saved=10000 ms)
          type=hello (focused field)  type@Message=hello  fill@Message=hello (replaces)  press=Control+K
          scroll=400  scroll@css:.list=-400  drag@Card=Done  sleep=500  navigate=<url>  reload  back
          down=Card move=@600,400 shot up  (a drag in parts; shot saves the drop preview mid-drag)
          eval=<js>  viewport=390x844@3  upload@css:input[type=file]=a.png,b.png
          Drags work on pointer-event and native (HTML5) drag and drop alike.
          Targets: visible text or accessible name, css:<selector>, or @x,y; [n] after one picks the nth match.
          An action gives its target 5 s to show, and each step lets the page's animations finish.
          A JSON step works too: '{"action":"click","selector":"#go"}'.
  Screenshots (act, open, shot):  --no-shot  --full (whole page)  --crop=<target> (one element)
  --session=name      a page of your own beside other threads' (default: default)`;

// Arguments: `--name=value` and `--flag` options, the rest positional.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const options = new Map<string, string | true>();
const positional: Array<string> = [];
for (const arg of args) {
  const option = /^--([\w-]+)(?:=(.*))?$/s.exec(arg);
  if (option === null) positional.push(arg);
  else options.set(option[1]!, option[2] ?? true);
}
const text = (name: string) => {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
};
const number = (name: string) => (text(name) === undefined ? undefined : Number(text(name)));
const command = positional.shift();

const root = join(tmpdir(), "cerium-ui");
const name = text("session") ?? "default";
if (!/^[\w.-]+$/.test(name)) throw new Error("--session takes letters, digits, dots and dashes.");
const stateFile = (session: string) => join(root, `${session}.json`);
const IDLE_MS = 60 * 60_000;

/** What one session keeps between calls. */
interface Session {
  readonly origin: string;
  readonly targetId: string;
  readonly match?: string | undefined;
  /** Set when this tool launched the browser, which it then closes. */
  readonly browser?: BrowserHandle | undefined;
  readonly visible: boolean;
  readonly viewport?: { width: number; height: number; scale: number; mobile: boolean } | undefined;
  readonly colorScheme?: "light" | "dark" | undefined;
  readonly lastUsed: number;
  readonly shots: number;
}

const load = (session: string): Session | undefined => {
  try {
    return JSON.parse(readFileSync(stateFile(session), "utf8")) as Session;
  } catch {
    return undefined;
  }
};
const save = (session: Session) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(stateFile(name), JSON.stringify(session));
};
const forget = async (session: string, state: Session | undefined) => {
  rmSync(stateFile(session), { force: true });
  if (state?.browser !== undefined) await closeBrowser(state.browser).catch(() => undefined);
};

/** Closes other sessions nobody used for an hour, whose browsers would otherwise run on. */
const reapIdle = async () => {
  let files: Array<string> = [];
  try {
    files = readdirSync(root).filter((file) => file.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const session = file.slice(0, -".json".length);
    const state = load(session);
    if (session !== name && state !== undefined && Date.now() - state.lastUsed > IDLE_MS) {
      await forget(session, state);
    }
  }
};

/** Connects to the session's page and puts back the emulation a new connection starts without. */
const connect = async (state: Session): Promise<Page> => {
  const target = await pickPage(state.origin, state.match, state.targetId).catch(() => undefined);
  if (target === undefined) {
    await forget(name, state);
    throw new Error("The page is gone. Run `bun run ui open <url>` again.");
  }
  const page = await Page.open(target.webSocketDebuggerUrl, { front: state.browser !== undefined });
  // A new connection is sent the page's earlier console messages again; earlier calls reported them.
  page.drainConsole();
  if (state.viewport !== undefined) await page.viewport(state.viewport);
  if (state.colorScheme !== undefined) await page.colorScheme(state.colorScheme);
  return page;
};

/** Fails at once on a page off screen, whose every step and screenshot would take seconds. */
const ensureShown = async (page: Page) => {
  if (!(await page.shown())) {
    page.close();
    throw new Error(
      "The page's window is minimized or hidden, which stalls every step. Restore it, then try again.",
    );
  }
};

const location = (page: Page) =>
  page
    .evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")
    .catch(() => ({ url: "", title: "" }));

/** Saves a screenshot unless --no-shot, returning its path for the report. */
const shoot = async (
  page: Page,
  state: Session,
): Promise<{ screenshot?: string; screenshotError?: string }> => {
  if (options.has("no-shot")) return {};
  try {
    const crop = text("crop");
    const of: Target | undefined = crop === undefined ? undefined : parseTarget(crop);
    const png = await page.screenshot({ fullPage: options.has("full"), of });
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `shot-${String(state.shots + 1).padStart(3, "0")}.png`);
    writeFileSync(path, png);
    save({ ...state, shots: state.shots + 1, lastUsed: Date.now() });
    return { screenshot: path };
  } catch (error) {
    return { screenshotError: message(error) };
  }
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The session's page, or a reason to run `open` first. */
const current = () => {
  const state = load(name);
  if (state === undefined) throw new Error("No page is open. Run `bun run ui open <url>` first.");
  return state;
};

const open = async (): Promise<Record<string, unknown>> => {
  const url = positional[0];
  const attach = text("attach");
  const visible = options.has("visible");
  const sized = ["width", "height", "scale", "mobile"].some((key) => options.has(key));
  const previous = load(name);
  const reusable =
    previous !== undefined &&
    attach === undefined &&
    previous.browser !== undefined &&
    previous.visible === visible;
  let state: Session;
  if (reusable) {
    state = previous;
  } else {
    if (previous !== undefined) await forget(name, previous);
    let origin: string;
    let browser: BrowserHandle | undefined;
    if (attach !== undefined) {
      origin = debuggerOrigin(attach);
    } else {
      const executable = findBrowser(text("browser") as BrowserKind | undefined);
      if (executable === undefined) {
        throw new Error(
          "No Edge or Chrome is installed. Install one, or --attach to an app's debugging port.",
        );
      }
      const launched = await launchBrowser({
        executable,
        visible,
        width: number("width") ?? 1280,
        height: number("height") ?? 800,
        outlive: true,
      });
      origin = launched.origin;
      browser = launched.handle;
    }
    const target = await pickPage(origin, text("match"));
    state = {
      origin,
      targetId: target.id,
      match: text("match"),
      browser,
      visible,
      lastUsed: Date.now(),
      shots: previous?.shots ?? 0,
    };
  }
  const viewport =
    sized || (state.browser !== undefined && state.viewport === undefined)
      ? {
          width: number("width") ?? state.viewport?.width ?? 1280,
          height: number("height") ?? state.viewport?.height ?? 800,
          scale: number("scale") ?? 1,
          mobile: options.has("mobile"),
        }
      : state.viewport;
  const colorScheme = options.has("dark") ? "dark" : options.has("light") ? "light" : state.colorScheme;
  state = { ...state, viewport, colorScheme, lastUsed: Date.now() };
  save(state);
  const page = await connect(state);
  try {
    if (url !== undefined) await page.navigate(url);
    else await page.settle();
    return { ...(await location(page)), ...(await shoot(page, state)), console: page.drainConsole() };
  } finally {
    page.close();
  }
};

const act = async (): Promise<Record<string, unknown>> => {
  if (positional.length === 0) throw new Error("act needs steps: bun run ui act click=Send wait=Sent");
  const steps: Array<Step> = positional.flatMap(parseStep);
  const state = current();
  const page = await connect(state);
  await ensureShown(page);
  try {
    const results: Array<Record<string, unknown>> = [];
    let failed: Record<string, unknown> | undefined;
    for (const [index, step] of steps.entries()) {
      try {
        if (step.action === "shot") {
          results.push({ step: index + 1, action: step.action, ...(await shoot(page, current())) });
          continue;
        }
        results.push({ step: index + 1, action: step.action, ...(await runStep(page, step)) });
        await page.settle();
      } catch (error) {
        failed = { step: index + 1, action: step.action, error: message(error) };
        break;
      }
    }
    save({ ...current(), lastUsed: Date.now() });
    const reported = results.filter((result) => Object.keys(result).length > 2);
    const report = {
      ok: failed === undefined,
      ran: results.length,
      ...(reported.length > 0 ? { results: reported } : {}),
      ...(failed === undefined ? {} : { failed }),
      ...(await location(page)),
      ...(await shoot(page, current())),
    };
    // A drag cannot span calls: the next one connects afresh, without the native drag's data.
    const released = page.holding && (await page.up().then(() => true));
    return {
      ...report,
      ...(released ? { released: "The button was still down; let go after the screenshot." } : {}),
      console: page.drainConsole(),
    };
  } finally {
    page.close();
  }
};

const look = async (what: "shot" | "inspect"): Promise<Record<string, unknown>> => {
  const state = current();
  const page = await connect(state);
  try {
    save({ ...state, lastUsed: Date.now() });
    if (what === "inspect") {
      return { ...((await page.inspect(options.has("text"))) as object), console: page.drainConsole() };
    }
    options.delete("no-shot");
    await ensureShown(page);
    return { ...(await location(page)), ...(await shoot(page, state)) };
  } finally {
    page.close();
  }
};

const run = async (): Promise<Record<string, unknown>> => {
  await reapIdle();
  switch (command) {
    case "open":
      return open();
    case "act":
      return act();
    case "shot":
      return look("shot");
    case "inspect":
      return look("inspect");
    case "close": {
      const state = load(name);
      await forget(name, state);
      return { closed: state !== undefined };
    }
    default:
      console.log(HELP);
      process.exit(command === undefined || command === "help" || options.has("help") ? 0 : 1);
  }
};

try {
  const result = await run();
  console.log(JSON.stringify(result));
  process.exit(result["ok"] === false ? 1 : 0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: message(error) }));
  process.exit(1);
}
