// Runs in every test process before its test files (`setupFiles` in vite.config.ts). The tests make
// throwaway repositories and run `git config`, `commit`, `branch`, `tag` and `push` in them; with
// GIT_DIR or the like inherited, from a hook or a shell, git would run all of those on the repository
// those name instead. Without them, each git finds its repository from the folder it runs in.

import { forgetGitRepository } from "../apps/backend/src/gitRepositoryVariables.ts";

forgetGitRepository(process.env);
