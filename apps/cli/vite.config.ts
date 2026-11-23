import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { cli: "src/cli.ts", backend: "../backend/src/main.ts" },
    format: "esm",
    platform: "node",
    deps: {
      neverBundle: true,
      alwaysBundle: [/^@cerium\//, /^@effect\/platform-node/],
      onlyBundle: ["@effect/platform-node", "@effect/platform-node-shared"],
    },
    dts: false,
  },
});
