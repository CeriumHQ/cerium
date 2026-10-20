import { defineConfig } from "vite-plus";

// Installed agent skills (.agents, .claude) are hash-locked by skills-lock.json; never rewrite them.
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
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    exclude: ignored,
    // Test files share their worker's modules instead of each importing Effect and the packages again,
    // which took most of the suite's time. Nothing in the tests mocks modules or changes global state,
    // so sharing them can't leak one file's setup into another.
    isolate: false,
  },
});
