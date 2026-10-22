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
const browserTests = ["packages/browser/test/page.test.ts", "packages/artifacts/test/preview.test.ts"];

/** GitHub Actions sets CI. */
const ci = process.env["CI"] === "true";

export default defineConfig({
  lint: {
    ignorePatterns: ignored,
    plugins: ["typescript"],
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
    // Test files share their worker's modules instead of each importing Effect and the packages again,
    // which took most of the suite's time. Nothing in the tests mocks modules or changes global state,
    // so sharing them can't leak one file's setup into another.
    isolate: false,
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
            "apps/**/test/**/*.test.ts",
            "scripts/test/**/*.test.ts",
          ],
          exclude: [...ignored, ...browserTests],
          // Most tests wait on git, SQLite and the processes they start rather than on the CPU, so CI's
          // two-core runners run four files at once instead of the one Vitest gives two cores.
          ...(ci ? { maxWorkers: 4 } : {}),
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: browserTests,
          // After the rest, one file at a time, so no other test slows the browser's start. In CI a
          // failure gets a second try, and the job summary lists the tests that needed one.
          sequence: { groupOrder: 1 },
          maxWorkers: 1,
          retry: ci ? 1 : 0,
        },
      },
    ],
  },
});
