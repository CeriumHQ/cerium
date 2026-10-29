import { statSync } from "node:fs";
import { resolve } from "node:path";

// What starting Cerium again, or following a `cerium://` link, asks of the running app: `cerium .`
// opens a folder, `cerium "fix login"` starts a thread in the folder the command ran in, and
// `cerium://thread/<id>` opens that thread. The shell turns the command line or link into a request,
// which the first instance runs, whether it was started by the command or was already open.

/** What the user asked Cerium to do. */
export type LaunchRequest =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "folder"; readonly folder: string }
  | { readonly kind: "prompt"; readonly folder: string; readonly text: string };

/** Cerium's link scheme. */
export const SCHEME = "cerium";

const THREAD_LINK = /^cerium:\/\/thread\/([\w-]{1,100})\/?$/i;

/** The most a prompt from the command line may hold, which is far past what a terminal passes. */
const MAX_PROMPT = 20_000;

/** The thread a `cerium://thread/<id>` link names. */
export const threadOfLink = (link: string): string | undefined => THREAD_LINK.exec(link.trim())?.[1];

/** Whether `path` names a folder that exists. */
export const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The arguments a start of Cerium was given, without the program and, in development, the app's
 * folder: `electron . <args>`. A second instance's own flags, Chromium's among them, may come before
 * that folder, so it is the first argument that is no flag.
 */
export const launchArguments = (argv: ReadonlyArray<string>, packaged: boolean): ReadonlyArray<string> => {
  const rest = argv.slice(1);
  if (packaged) return rest;
  const app = rest.findIndex((arg) => !arg.startsWith("--"));
  return app < 0 ? rest : rest.filter((_, index) => index !== app);
};

/**
 * What `args` ask for, from `cwd`: a link opens its thread; one folder that exists opens that folder;
 * any other words are a prompt for a thread in `cwd`. Flags, the shell's own and Chromium's, are no
 * part of it. Nothing asks for nothing, which only brings Cerium forward.
 */
export const parseLaunch = (
  args: ReadonlyArray<string>,
  cwd: string,
  folderExists: (path: string) => boolean = isFolder,
): LaunchRequest | undefined => {
  for (const arg of args) {
    const id = threadOfLink(arg);
    if (id !== undefined) return { kind: "thread", id };
  }
  const words = args.filter((arg) => !arg.startsWith("--") && !arg.toLowerCase().startsWith(`${SCHEME}:`));
  if (words.length === 0) return undefined;
  if (words.length === 1) {
    const folder = resolve(cwd, words[0]!);
    if (folderExists(folder)) return { kind: "folder", folder };
  }
  const text = words.join(" ").trim().slice(0, MAX_PROMPT);
  return text === "" ? undefined : { kind: "prompt", folder: cwd, text };
};
