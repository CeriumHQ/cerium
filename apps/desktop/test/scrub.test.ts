import { describe, expect, it } from "@effect/vitest";
import type { ErrorEvent } from "@sentry/electron/main";

import { appPath, redact, scrubEvent } from "../src/scrub.ts";

describe("redact", () => {
  it("drops Windows paths, spaces and all", () => {
    expect(
      redact("Could not open C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Cerium\\cerium.db: locked"),
    ).toBe("Could not open <path>: locked");
    expect(redact("ENOENT: no such file or directory, open 'D:\\client work\\secret\\plan.md'")).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
    expect(redact("share \\\\server\\team\\notes.txt gone")).toBe("share <path> gone");
  });

  it("drops POSIX and home paths", () => {
    expect(redact("spawn /Users/ada/.local/bin/claude ENOENT")).toBe("spawn <path> ENOENT");
    expect(redact("cannot read ~/projects/acme/app.ts")).toBe("cannot read <path>");
    expect(redact("and/or either way")).toBe("and/or either way");
  });

  it("drops URLs, emails, addresses and ids", () => {
    expect(redact("fetch https://example.com/acme?token=abc failed")).toBe("fetch <url> failed");
    expect(redact("ws://127.0.0.1:64895/rpc closed")).toBe("<url> closed");
    expect(redact("signed in as ada@example.com")).toBe("signed in as <email>");
    expect(redact("connect ECONNREFUSED 10.0.0.12:443")).toBe("connect ECONNREFUSED <ip>:443");
    expect(redact("thread thr_01a17ede151f730dbdf7ad31038b7ed2 missing")).toBe("thread <id> missing");
    expect(redact("sk-ant-api03-AbCdEf0123456789xyz leaked")).toBe("<id> leaked");
  });

  it("keeps error codes and identifiers, but not quoted prose", () => {
    expect(redact("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")).toBe("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    expect(redact("Cannot read properties of undefined (reading 'input')")).toBe(
      "Cannot read properties of undefined (reading 'input')",
    );
    expect(redact(`Unexpected token 'h', "hello my secret plan" is not valid JSON`)).toBe(
      `Unexpected token 'h', "…" is not valid JSON`,
    );
  });

  it("cuts a long message short", () => {
    expect(redact("x ".repeat(400))).toHaveLength(300);
  });
});

describe("appPath", () => {
  it("keeps where in Cerium's install a frame ran", () => {
    expect(appPath("C:\\Users\\Ada\\AppData\\Local\\Programs\\Cerium\\resources\\app\\dist\\main.mjs")).toBe(
      "app:///dist/main.mjs",
    );
    expect(appPath("file:///C:/Program%20Files/Cerium/resources/ui/dist/assets/index-abc.js")).toBe(
      "app:///ui/dist/assets/index-abc.js",
    );
    expect(appPath("/Applications/Cerium.app/Contents/Resources/app/dist/backend.mjs")).toBe(
      "app:///dist/backend.mjs",
    );
    expect(appPath("/opt/Cerium/resources/app/node_modules/effect/dist/Effect.js")).toBe(
      "app:///node_modules/effect/dist/Effect.js",
    );
    expect(appPath("app:///dist/main.mjs")).toBe("app:///dist/main.mjs");
  });

  it("keeps only the name of a file outside it", () => {
    expect(appPath("/home/ada/scratch/thing.js")).toBe("thing.js");
  });
});

describe("scrubEvent", () => {
  const event = {
    type: undefined,
    event_id: "e1",
    release: "cerium@1.0.0",
    environment: "nightly",
    platform: "node",
    message: "see C:\\Users\\Ada\\notes.txt",
    server_name: "ADAS-LAPTOP",
    user: { id: "1", ip_address: "1.2.3.4", username: "ada" },
    request: { url: "https://example.com" },
    breadcrumbs: [{ message: "window title: Secret project" }],
    extra: { prompt: "my secret" },
    tags: {
      process: "backend",
      category: "harness",
      harness: "claude",
      project: "acme",
      "event.process": "browser",
    },
    contexts: {
      os: { name: "Windows", version: "10.0.26300", kernel_version: "x", machine: "ADAS-LAPTOP" },
      device: { arch: "x64", name: "ADAS-LAPTOP", memory_size: 1 },
      app: { app_version: "1.0.0", app_name: "Cerium", app_start_time: "t" },
      cerium: { harness: "codex", phase: "start", folder: "C:\\work" },
      culture: { locale: "tr-TR", timezone: "Europe/Istanbul" },
    },
    exception: {
      values: [
        {
          type: "HarnessFailure",
          value: "spawn /Users/ada/bin/codex ENOENT",
          mechanism: { type: "cerium.harness", handled: true, data: { secret: "x" } },
          stacktrace: {
            frames: [
              {
                filename:
                  "C:\\Users\\Ada\\AppData\\Local\\Programs\\Cerium\\resources\\app\\dist\\backend.mjs",
                abs_path: "C:\\Users\\Ada\\…",
                function: "start",
                lineno: 10,
                colno: 4,
                in_app: true,
                vars: { prompt: "my secret" },
                context_line: "const secret = 1",
              },
            ],
          },
        },
      ],
    },
  } as unknown as ErrorEvent;

  const scrubbed = scrubEvent(event);

  it("keeps the release, the system and versions, and the failure's own facts", () => {
    expect(scrubbed.release).toBe("cerium@1.0.0");
    expect(scrubbed.environment).toBe("nightly");
    expect(scrubbed.contexts).toEqual({
      os: { name: "Windows", version: "10.0.26300" },
      device: { arch: "x64" },
      app: { app_version: "1.0.0", app_name: "Cerium" },
      cerium: { harness: "codex", phase: "start" },
    });
    expect(scrubbed.tags).toEqual({
      process: "backend",
      category: "harness",
      harness: "claude",
      "event.process": "browser",
    });
  });

  it("drops the user, the machine, the request, breadcrumbs and extras", () => {
    for (const key of ["user", "server_name", "request", "breadcrumbs", "extra"]) {
      expect(scrubbed).not.toHaveProperty(key);
    }
    expect(scrubbed.message).toBe("see <path>");
  });

  it("redacts the exception and keeps only where its frames ran", () => {
    const [exception] = scrubbed.exception?.values ?? [];
    expect(exception?.value).toBe("spawn <path> ENOENT");
    expect(exception?.mechanism).toEqual({ type: "cerium.harness", handled: true });
    expect(exception?.stacktrace?.frames).toEqual([
      { filename: "app:///dist/backend.mjs", function: "start", lineno: 10, colno: 4, in_app: true },
    ]);
  });
});
