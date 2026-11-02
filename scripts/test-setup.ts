// Runs in every test process before its test files (`setupFiles` in vite.config.ts). The tests make
// throwaway repositories and run `git config`, `commit`, `branch`, `tag` and `push` in them; with
// GIT_DIR or the like inherited, from a hook or a shell, git would run all of those on the repository
// those name instead. Without them, each git finds its repository from the folder it runs in.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { forgetGitRepository } from "../apps/backend/src/gitRepositoryVariables.ts";

forgetGitRepository(process.env);

// Each test sets up its own repositories. The machine's settings (such as push.autoSetupRemote,
// signing and hooks) must not change what they do or run the user's hooks in a throwaway repository,
// so git reads this file as its global settings and no system ones. The one thing it says is to trust
// every repository's owner: the tests' temporary folders can belong to another account than the one
// running git (on Windows CI, D:\a\_temp does), and git won't act in those otherwise. The machine's
// own settings usually allow that, CI's system ones among them, but they're left out.
const gitConfig = "[safe]\n\tdirectory = *\n";
const gitConfigFolder = join(import.meta.dirname, "..", "node_modules", ".cache", "test-git");
const gitConfigPath = join(gitConfigFolder, "gitconfig");

// Every test process runs this at once, so each writes its own copy and moves it into place: none
// reads a half-written file.
const current = existsSync(gitConfigPath) ? readFileSync(gitConfigPath, "utf8") : undefined;
if (current !== gitConfig) {
  mkdirSync(gitConfigFolder, { recursive: true });
  const written = `${gitConfigPath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(written, gitConfig);
  try {
    renameSync(written, gitConfigPath);
  } catch (error) {
    // On Windows another process's git may have the file open; it's then already in place.
    rmSync(written, { force: true });
    if (!existsSync(gitConfigPath)) throw error;
  }
}

process.env["GIT_CONFIG_GLOBAL"] = gitConfigPath;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
