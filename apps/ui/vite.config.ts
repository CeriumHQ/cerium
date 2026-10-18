import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, transformWithOxc, type Plugin } from "vite-plus";

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

const artifactRuntimeFile = fileURLToPath(
  new URL("src/features/transcript/artifactRuntime.ts", import.meta.url),
);

/**
 * The one script an artifact's frame runs (src/features/transcript/artifactRuntime.ts), as a fixed
 * string, so the web client's policy can admit it by its hash.
 */
const artifactScript = async () => {
  const source = await readFile(artifactRuntimeFile, "utf8");
  const { code } = await transformWithOxc(source, artifactRuntimeFile, { lang: "ts" });
  return `(() => {\n${code.replace(/^export /gm, "").trim()}\nartifactRuntime(HEIGHT_MESSAGE);\n})();`;
};

const serviceWorkerFile = fileURLToPath(new URL("src/web/serviceWorker.ts", import.meta.url));

/** The web client's service worker (src/web/serviceWorker.ts) as one script, served at /sw.js. */
const serviceWorkerScript = async () => {
  const source = await readFile(serviceWorkerFile, "utf8");
  const { code } = await transformWithOxc(source, serviceWorkerFile, { lang: "ts" });
  return `${code.replace(/^export /gm, "").trim()}\nserviceWorker(self);\n`;
};

/**
 * The web client's Content-Security-Policy (docs/architecture.md §14.10): every script is the app's
 * own, or an artifact frame's runtime, which the frame inherits this policy for.
 */
const contentPolicy = (artifactScript: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'sha256-${createHash("sha256").update(artifactScript).digest("base64")}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/** Files only the web client ships: its manifest and Home Screen icons (apps/ui/web). */
const webFiles = [
  "manifest.webmanifest",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];
const webFolder = fileURLToPath(new URL("web/", import.meta.url));

/** What a Home Screen web app needs in its page; the theme colours match the window over its backdrop. */
const webHead = `
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Cerium" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151515" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#e8e8e8" />
    <meta name="referrer" content="no-referrer" />
`;

/**
 * The web client (`--mode web`): its page head, its files and service worker, and the relay's
 * `_headers` with the policy, which scripts/assets.ts in apps/relay merges with the relay's own.
 */
const webClient = (artifact: string): Plugin => ({
  name: "cerium-web-client",
  transformIndexHtml: (html) => html.replace("</head>", `${webHead}  </head>`),
  configureServer(server) {
    server.middlewares.use("/sw.js", (_request, response) => {
      void serviceWorkerScript().then((script) => {
        response.setHeader("content-type", "text/javascript");
        response.setHeader("cache-control", "no-cache");
        response.end(script);
      });
    });
  },
  async generateBundle() {
    for (const fileName of webFiles) {
      this.emitFile({ type: "asset", fileName, source: await readFile(`${webFolder}${fileName}`) });
    }
    this.emitFile({ type: "asset", fileName: "sw.js", source: await serviceWorkerScript() });
    const rules = [
      `Content-Security-Policy: ${contentPolicy(artifact)}`,
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: no-referrer",
      "Permissions-Policy: camera=(), microphone=(), geolocation=()",
    ];
    const headers = [
      ...["/", "/index.html"].map((path) => [path, ...rules.map((rule) => `  ${rule}`)].join("\n")),
      // Browsers check for a newer worker at each visit.
      "/sw.js\n  Cache-Control: no-cache",
    ];
    this.emitFile({ type: "asset", fileName: "_headers", source: `${headers.join("\n\n")}\n` });
  },
});

/** Where `bun run dev:web` finds the relay it proxies: the local one, unless told another. */
const relay = process.env["CERIUM_RELAY"] ?? "http://localhost:8787";

export default defineConfig(async ({ mode }) => {
  const web = mode === "web";
  const artifact = await artifactScript();
  return {
    // The packaged shell loads the built UI from a file, so asset URLs stay relative to index.html;
    // the relay serves the web client from its root.
    base: web ? "/" : "./",
    define: {
      __ARTIFACT_RUNTIME__: JSON.stringify(artifact),
      __CERIUM_VERSION__: JSON.stringify(process.env["CERIUM_VERSION"] ?? "dev"),
    },
    build: web ? { outDir: "dist-web" } : {},
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      web ? webClient(artifact) : devBackendConnection(),
    ],
    server: web
      ? {
          port: 5174,
          strictPort: true,
          // The relay's API, its live connection and its sign-in page, from the dev server's origin.
          proxy: {
            "/api": { target: relay, ws: true, changeOrigin: true },
            "^/(link|link\\.js|link\\.css|fonts/.*)$": { target: relay, changeOrigin: true },
          },
        }
      : { port: 5173, strictPort: true },
  };
});
