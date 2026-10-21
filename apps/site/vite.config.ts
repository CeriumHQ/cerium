import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// Cerium's website: one static page, built to dist/. Its own port keeps it clear of the UI's dev server.
export default defineConfig({
  plugins: [tailwindcss()],
  server: { port: 5190 },
  preview: { port: 5191 },
});
