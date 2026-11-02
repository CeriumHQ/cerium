/**
 * Identify Cerium's Claude processes, including when the parent inherited an SDK entrypoint.
 * Custom labels work around the five-hour quota difference reported in anthropics/claude-code#97074.
 */
export const claudeEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  CLAUDE_CODE_ENTRYPOINT: "cerium",
});
