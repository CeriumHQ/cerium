import { app, net, protocol } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dictationRuntime, runtimeManifest } from "./dictationRuntime.ts";

const scheme = "cerium-dictation";
const wasmUrl = `${scheme}://runtime/ort.wasm`;

/** Register before Electron is ready. The worker's first request starts the cache or download. */
export const serveDictationRuntime = (uiDirectory: string) => {
  protocol.registerSchemesAsPrivileged([
    { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);

  void app.whenReady().then(() => {
    let loadRuntime: ReturnType<typeof dictationRuntime> | undefined;
    protocol.handle(scheme, async (request) => {
      if (request.url !== wasmUrl || request.method !== "GET") return new Response(null, { status: 404 });
      const headers = { "Access-Control-Allow-Origin": "null", "Cache-Control": "no-store" };
      try {
        if (loadRuntime === undefined) {
          const metadata = await readFile(join(uiDirectory, "dictation-runtime.json"), "utf8");
          const manifest = runtimeManifest(JSON.parse(metadata), app.getVersion());
          if (manifest === undefined) throw new Error("Speech runtime metadata doesn't match this build.");
          loadRuntime ??= dictationRuntime(
            join(app.getPath("userData"), "dictation-runtime"),
            manifest,
            (url, options) => net.fetch(url, options),
          );
        }
        const bytes = await loadRuntime();
        return new Response(bytes, { headers: { ...headers, "Content-Type": "application/wasm" } });
      } catch (error) {
        console.warn("Could not load the speech runtime:", error);
        return new Response(null, { status: 503, headers });
      }
    });
  });
};
