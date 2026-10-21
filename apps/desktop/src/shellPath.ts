import { execFile } from "node:child_process";
import { userInfo } from "node:os";

// The environment the packaged app's backend, and every harness and terminal it starts, runs with.
// Started from a desktop launcher, a Linux app gets the session's environment, which lacks what the
// user's shell profile adds to PATH (~/.local/bin, a Node version manager, Bun), where harness CLIs
// install. So the user's shell runs once, as a terminal starts it, and its PATH comes first. An
// AppImage's runtime also puts its own folders on PATH and the library and data paths, which would
// reach every program the backend starts; they are taken off again. Windows keeps PATH in the
// registry, so every app has it already.

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
const loginShellPath = (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
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

/** The backend's environment: Cerium's own on Windows; elsewhere, as described above. */
export const backendEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
  if (process.platform === "win32") return process.env;
  const appDir = process.env["APPDIR"];
  const env = appDir ? withoutAppImage(process.env, appDir) : { ...process.env };
  const path = await loginShellPath(env);
  if (path !== undefined) env["PATH"] = mergePaths(path, env["PATH"] ?? "");
  return env;
};
