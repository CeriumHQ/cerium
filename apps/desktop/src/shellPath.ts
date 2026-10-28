import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";

// The environment the packaged app's backend, and every harness and terminal it starts, runs with.
// Started from a desktop launcher, a Linux app gets the session's environment, which lacks what the
// user's shell profile adds to PATH (~/.local/bin, a Node version manager, Bun), where harness CLIs
// install; a Mac app started from the Dock or Finder gets launchd's bare one, without Homebrew's
// /opt/homebrew/bin either. So the user's shell runs once, as a terminal starts it, and its PATH comes first. An
// AppImage's runtime also puts its own folders on PATH and the library and data paths, which would
// reach every program the backend starts; they are taken off again. Windows keeps PATH in the
// registry, so every app has it already. A profile can take seconds to load, so the PATH it gave is
// kept for the next start, which starts the backend on it while the shell is asked again.

/** Printed around the PATH, so what the shell's profile prints itself is left out. */
const MARK = "__CERIUM_PATH__";
/** A profile that takes longer than this is left alone, and the session's PATH used. */
const SHELL_TIMEOUT_MS = 5_000;

/** The variables an AppImage's runtime prepends its own folders to. */
const APPIMAGE_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

/** The PATH between the marks in a shell's `output`; undefined when it isn't there. */
export const pathBetweenMarks = (output: string): string | undefined => {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start === -1 || end <= start) return undefined;
  return output.slice(start + MARK.length, end) || undefined;
};

/** `first`'s folders, then those of `second` that `first` lacks. */
export const mergePaths = (first: string, second: string): string =>
  [...new Set([...first.split(":"), ...second.split(":")].filter((entry) => entry !== ""))].join(":");

/** `env` without the folders inside `appDir` an AppImage's runtime added to it. */
export const withoutAppImage = (env: NodeJS.ProcessEnv, appDir: string): NodeJS.ProcessEnv => {
  const inside = (entry: string) => entry === appDir || entry.startsWith(`${appDir}/`);
  const cleaned = { ...env };
  for (const key of APPIMAGE_LISTS) {
    const list = cleaned[key];
    if (list === undefined) continue;
    const kept = list.split(":").filter((entry) => entry !== "" && !inside(entry.replace(/\/+$/, "")));
    if (kept.length > 0) cleaned[key] = kept.join(":");
    else delete cleaned[key];
  }
  return cleaned;
};

/** The PATH the user's login shell sets up, with its interactive profile; undefined if it can't say. */
export const loginShellPath = (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const shell = env["SHELL"] || userInfo().shell || "/bin/sh";
  return new Promise((resolve) => {
    execFile(
      shell,
      // The quotes end the variable's name before the mark, in POSIX shells and fish alike.
      ["-ilc", `printf '%s' ${MARK}"$PATH"${MARK}`],
      { env, encoding: "utf8", timeout: SHELL_TIMEOUT_MS },
      (_error, stdout) => resolve(pathBetweenMarks(stdout ?? "")),
    );
  });
};

/** The backend's environment before the shell's PATH joins it: Cerium's own, less an AppImage's folders. */
export const sessionEnvironment = (): NodeJS.ProcessEnv => {
  const appDir = process.env["APPDIR"];
  return appDir ? withoutAppImage(process.env, appDir) : { ...process.env };
};

/**
 * `env` with a UTF-8 locale when it names none, as a Mac app's has: launchd starts it without LANG,
 * so the terminals' shells and every program they and the harnesses run would be in the C locale,
 * printing accented letters and emoji as escapes. The system's language and region, when macOS has
 * that locale (`hasLocale`), else US English, as Terminal.app falls back to.
 */
export const withLocale = (
  env: NodeJS.ProcessEnv,
  systemLocale: string,
  hasLocale: (name: string) => boolean,
): NodeJS.ProcessEnv => {
  if (env["LANG"] || env["LC_ALL"] || env["LC_CTYPE"]) return env;
  // "en-GB", or "zh-Hans-CN" with its script between.
  const parts = systemLocale.split(/[-_]/);
  const language = parts[0]?.toLowerCase() ?? "";
  const region = parts.length > 1 ? parts.at(-1)?.toUpperCase() : undefined;
  const named =
    /^[a-z]{2,3}$/.test(language) && region !== undefined && /^[A-Z]{2}$/.test(region)
      ? `${language}_${region}.UTF-8`
      : undefined;
  return { ...env, LANG: named !== undefined && hasLocale(named) ? named : "en_US.UTF-8" };
};

/** `env` with the shell's `path` ahead of its own PATH; `env` itself without one. */
export const withShellPath = (env: NodeJS.ProcessEnv, path: string | undefined): NodeJS.ProcessEnv =>
  path === undefined ? env : { ...env, PATH: mergePaths(path, env["PATH"] ?? "") };

/** The shell's PATH as it was kept in `file` last time; undefined when none was. */
export const rememberedPath = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8") || undefined;
  } catch {
    return undefined;
  }
};

/** Keeps the shell's PATH in `file` for the next start; one that can't be kept is asked for again then. */
export const rememberPath = (file: string, path: string): Promise<void> =>
  writeFile(file, path, "utf8").catch(() => undefined);
