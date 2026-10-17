import { defineConfig } from "vite-plus";

export default defineConfig({
  // The main process runs as ESM; Electron's sandboxed preload must be CommonJS.
  pack: [
    { entry: { main: "src/main.ts" }, format: "esm", platform: "node", external: ["electron"], dts: false },
    {
      entry: { preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      external: ["electron"],
      dts: false,
    },
  ],
});
