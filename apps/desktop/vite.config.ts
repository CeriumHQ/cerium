import { defineConfig } from "vite-plus";

export default defineConfig({
  // The main process runs as ESM; Electron's sandboxed preload must be CommonJS.
  pack: [
    // koffi is a native module and loads from node_modules at runtime.
    {
      entry: { main: "src/main.ts" },
      format: "esm",
      platform: "node",
      external: ["electron", "koffi"],
      dts: false,
    },
    {
      entry: { preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      external: ["electron"],
      dts: false,
    },
  ],
});
