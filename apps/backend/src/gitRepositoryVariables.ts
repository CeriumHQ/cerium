// Git finds the repository it acts on from the folder it runs in, unless its environment names one: a
// hook, `git rebase --exec` and `git bisect run` export GIT_DIR and the rest to the commands they start.
// From a linked worktree that GIT_DIR is absolute, so every git started under it, in whatever folder,
// acts on that one repository. Cerium runs git in the folders it's given, and the tests in throwaway
// ones, so neither keeps these. Nothing else here: the tests' setup imports this without the backend.

/**
 * The variables that name the repository git acts on, as `git rev-parse --local-env-vars` lists them
 * (git 2.56); a test checks the installed git lists no others.
 */
export const GIT_REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

/** Removes the variables that name git's repository from `env`, so git finds it from its folder. */
export const forgetGitRepository = (env: NodeJS.ProcessEnv): void => {
  for (const name of GIT_REPOSITORY_VARIABLES) Reflect.deleteProperty(env, name);
};
