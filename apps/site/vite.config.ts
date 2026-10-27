import { join } from "node:path";

import { defineConfig } from "vite-plus";

// Cerium's website: the home page, /downloads/ and /privacy/, static, built to dist/. Its own port keeps
// it clear of the UI's dev server.
export default defineConfig({
  build: {
    // The home page awaits its fonts at the top level.
    target: "es2022",
    // The hero's three.js scene is one chunk, loaded after the page is up.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      input: {
        home: join(import.meta.dirname, "index.html"),
        downloads: join(import.meta.dirname, "downloads", "index.html"),
        privacy: join(import.meta.dirname, "privacy", "index.html"),
      },
    },
  },
  server: { port: 5190 },
  preview: { port: 5191 },
});
