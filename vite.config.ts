import { defineConfig } from "vite-plus";

// Installed agent skills (.agents, .claude) are hash-locked by skills-lock.json; never rewrite them.
const ignored = [
  "**/node_modules/**",
  "**/dist/**",
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
  },
});
