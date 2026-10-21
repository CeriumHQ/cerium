import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `--smoke-test[=<folder>]` checks that a packaged build runs: the release workflows start each one
// with it after packaging (.github/actions/package). Cerium starts as it would for a user, on a
// user-data folder of its own (the one given, else a new temporary one), and waits for the backend to
// listen and the window to paint the UI's launch screen. It reports what it saw on stdout and in
// smoke-test.log in that folder, beside the backend's log, then exits 0, or 1 when the UI fails to
// load, its renderer goes, or the two aren't both up in time.

const FLAG = "--smoke-test";

/** How long a cold start on a busy CI runner gets. */
const DEADLINE_MS = 120_000;
/** How much of the backend's log a failure prints. */
const LOG_TAIL_LINES = 60;

/**
 * The smoke test's user-data folder when Cerium was started with the flag, else undefined. Moves the
 * user data and logs there before anything reads them, which also keeps the test clear of a running
 * Cerium's single-instance lock.
 */
export const prepareSmokeTest = (): string | undefined => {
  const given = process.argv.find((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
  if (given === undefined) return undefined;
  const folder =
    given === FLAG ? mkdtempSync(join(tmpdir(), "cerium-smoke-")) : resolve(given.slice(FLAG.length + 1));
  mkdirSync(folder, { recursive: true });
  app.setPath("userData", folder);
  app.setAppLogsPath(join(folder, "logs"));
  return folder;
};

const tail = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return undefined;
  }
};

/** Watches the started app until its backend listens and its window paints, then exits. */
export const runSmokeTest = (options: {
  readonly folder: string;
  readonly window: BrowserWindow;
  /** Where the backend listens; rejects while it hasn't started. */
  readonly connection: () => Promise<{ readonly url: string }>;
  readonly stop: () => Promise<void>;
}) => {
  const started = Date.now();
  const report = (line: string) => {
    console.log(line);
    appendFileSync(join(options.folder, "smoke-test.log"), `${line}\n`);
  };
  const seconds = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;

  let finished = false;
  let listening: string | undefined;
  let painted = false;
  let lastError: string | undefined;

  const finish = async (passed: boolean, message: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    report(`Smoke test ${passed ? "passed" : "failed"} after ${seconds()}: ${message}`);
    if (!passed) {
      const backendLog = tail(join(app.getPath("logs"), "backend.log"));
      report(
        backendLog === undefined ? "The backend wrote no log." : `The backend's log ends:\n${backendLog}`,
      );
    }
    await options.stop().catch(() => undefined);
    app.exit(passed ? 0 : 1);
  };
  const check = () => {
    if (listening !== undefined && painted) {
      void finish(true, `the backend listens on ${listening} and the UI painted its launch screen.`);
    }
  };

  const deadline = setTimeout(() => {
    const missing = [
      ...(listening === undefined ? [`the backend didn't listen${lastError ? ` (${lastError})` : ""}`] : []),
      ...(painted ? [] : ["the UI didn't paint its launch screen"]),
    ];
    void finish(false, `${missing.join(", and ")} within ${DEADLINE_MS / 1000} s.`);
  }, DEADLINE_MS);

  const { webContents } = options.window;
  ipcMain.on("cerium:window-ready", (event: IpcMainEvent) => {
    if (event.sender !== webContents) return;
    painted = true;
    report(`The UI painted its launch screen after ${seconds()}.`);
    check();
  });
  webContents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    if (mainFrame) void finish(false, `the UI didn't load ${url}: ${description} (${code}).`);
  });
  webContents.on("render-process-gone", (_event, details) => {
    void finish(false, `the UI's renderer went: ${details.reason} (exit code ${details.exitCode}).`);
  });
  webContents.on("preload-error", (_event, path, error) => {
    void finish(false, `the preload ${path} failed: ${error.message}`);
  });
  webContents.on("console-message", ({ level, message }) => {
    if (level === "error") report(`The UI logged an error: ${message}`);
  });

  // The connection waits a while for a starting backend, then gives up; ask again until the deadline.
  void (async () => {
    while (!finished) {
      try {
        listening = new URL((await options.connection()).url).host;
        report(`The backend listens on ${listening} after ${seconds()}.`);
        check();
        return;
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  })();
};
