import { defineConfig } from "vite-plus";

// Local agent skills (.agents, .claude) are hash-locked by skills-lock.json; never rewrite them.
const ignored = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-web/**",
  "**/.tsbuild/**",
  "vendor/**",
  ".agents/**",
  ".claude/**",
  "skills-lock.json",
];

/** Tests that drive a real Edge or Chrome, which can take most of a minute to start on a busy machine. */
const browserTests = [
  "packages/browser/test/page.test.ts",
  "packages/browser/test/shutdown.test.ts",
  "packages/artifacts/test/preview.test.ts",
  "apps/ui/test/qol.interactions.test.ts",
];

// Restarting a listener must reacquire its previous port. A released ephemeral port is available
// to every other socket on the machine, so run this fixture after the parallel projects finish.
const loopbackTests = ["apps/backend/test/linkHandoff.test.ts"];

/** GitHub Actions sets CI. */
const ci = process.env["CI"] === "true";

export default defineConfig({
  lint: {
    ignorePatterns: ignored,
    plugins: ["typescript"],
    rules: {
      "block-scoped-var": "error",
      "no-extend-native": "error",
      "no-extra-bind": "error",
      "no-implied-eval": "error",
      "no-new": "error",
      "no-unexpected-multiline": "error",
      "no-unneeded-ternary": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-constructor": "error",
      "preserve-caught-error": "error",
      "typescript/no-confusing-non-null-assertion": "error",
      "typescript/no-extraneous-class": "error",
      "typescript/no-generated-empty-object-type": "error",
      "typescript/no-unnecessary-template-expression": "error",
      "typescript/no-unnecessary-type-constraint": "error",
    },
    options: {
      // Type-aware rules include Effect's diagnostics (patched in by `effect-tsgo patch`).
      // `tsc -b` remains the authoritative type gate.
      typeAware: true,
      // A warning fails the check like an error, so `bun run verify` passing means no new ones.
      denyWarnings: true,
    },
    overrides: [
      {
        files: ["**/test/**", "**/*.test.ts"],
        plugins: ["vitest"],
      },
      {
        files: ["apps/ui/**"],
        plugins: ["react", "jsx-a11y"],
      },
    ],
  },
  fmt: {
    ignorePatterns: ignored,
    printWidth: 110,
  },
  test: {
    exclude: ignored,
    // No test inherits a repository for git to act on: scripts/test-setup.ts.
    setupFiles: ["scripts/test-setup.ts"],
    // Reuse worker threads but give each file its own VM context and module registry.
    pool: "vmThreads",
    isolate: true,
    sequence: { shuffle: { files: true } },
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // CI's log keeps what a failing test printed and leaves out the rest.
    silent: ci ? "passed-only" : false,
    // A test's time limit only catches one that hangs, so a hang names its test instead of running out
    // the CI job. It isn't a speed check: a slow machine or a busy runner never fails a test.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/**/test/**/*.test.ts",
            "apps/**/test/**/*.test.{ts,tsx}",
            "scripts/test/**/*.test.ts",
          ],
          exclude: [...ignored, ...browserTests, ...loopbackTests],
          maxWorkers: "100%",
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: browserTests,
          // Run after the unit project with a real browser dedicated to each file.
          sequence: { groupOrder: 1 },
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "loopback",
          include: loopbackTests,
          sequence: { groupOrder: 2 },
          maxWorkers: 1,
        },
      },
    ],
  },
});
