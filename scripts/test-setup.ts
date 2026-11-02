// Runs in every test process before its test files (`setupFiles` in vite.config.ts). The tests make
// throwaway repositories and run `git config`, `commit`, `branch`, `tag` and `push` in them; with
// GIT_DIR or the like inherited, from a hook or a shell, git would run all of those on the repository
// those name instead. Without them, each git finds its repository from the folder it runs in.

import { devNull } from "node:os";

import { forgetGitRepository } from "../apps/backend/src/gitRepositoryVariables.ts";

forgetGitRepository(process.env);

// Each test sets up its own repositories. The machine's settings (such as push.autoSetupRemote,
// signing and hooks) must not change what they do or run the user's hooks in a throwaway repository.
process.env["GIT_CONFIG_GLOBAL"] = devNull;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
