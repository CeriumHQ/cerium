import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite-plus";

/** Written by `bun run dev:backend`: where the development backend listens and its launch token. */
const connectionFile = fileURLToPath(new URL("../../.cerium-dev/connection.json", import.meta.url));

/**
 * Hands the development backend's connection to the page (browser preview or Electron in dev). Only
 * same-origin requests get it, so other sites can't read the token from the dev server.
 */
const devBackendConnection = (): Plugin => ({
  name: "cerium-dev-backend-connection",
  configureServer(server) {
    server.middlewares.use("/__cerium/connection", (request, response) => {
      const site = request.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin") {
        response.statusCode = 403;
        return response.end();
      }
      readFile(connectionFile).then(
        (contents) => {
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(contents);
        },
        () => {
          response.statusCode = 503;
          response.end("The development backend isn't running. Start it with `bun run dev:backend`.");
        },
      );
    });
  },
});

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), devBackendConnection()],
  server: { port: 5173, strictPort: true },
});
