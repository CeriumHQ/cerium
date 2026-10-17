import { defineConfig } from "vite-plus";

export default defineConfig({
  // The main process runs as ESM; Electron's sandboxed preload must be CommonJS.
  pack: [
    // koffi is a native module and loads from node_modules at runtime.
    {
      entry: { main: "src/main.ts" },
      format: "esm",
      platform: "node",
      deps: { neverBundle: ["electron", "koffi"] },
      dts: false,
    },
    {
      entry: { preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      deps: { neverBundle: ["electron"] },
      dts: false,
    },
    // The backend the packaged app runs (src/backend.ts). Cerium's own packages are TypeScript, so
    // they are bundled; npm packages stay in node_modules, where some find their own files (the
    // Cursor SDK's ripgrep and sandbox). @effect/platform-node is bundled too: its index imports its
    // optional `redis` peer, which packaging rightly leaves out, and bundling shakes that away.
    {
      entry: { backend: "../backend/src/main.ts" },
      format: "esm",
      platform: "node",
      deps: {
        neverBundle: true,
        alwaysBundle: [/^@cerium\//, /^@effect\/platform-node/],
        onlyBundle: ["@effect/platform-node", "@effect/platform-node-shared"],
      },
      dts: false,
    },
  ],
});
