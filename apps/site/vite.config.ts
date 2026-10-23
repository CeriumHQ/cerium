import { join } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// Cerium's website: the home page, /downloads/ and /privacy/, static, built to dist/. Its own port keeps
// it clear of the UI's dev server.
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
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
