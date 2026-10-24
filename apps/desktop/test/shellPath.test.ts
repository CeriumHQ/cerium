import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mergePaths,
  pathBetweenMarks,
  rememberedPath,
  rememberPath,
  withoutAppImage,
  withShellPath,
} from "../src/shellPath.ts";

describe("pathBetweenMarks", () => {
  it("reads the PATH between the marks, whatever the profile printed around it", () => {
    const output = "Welcome!\n__CERIUM_PATH__/home/me/.local/bin:/usr/bin__CERIUM_PATH__\nbye";
    expect(pathBetweenMarks(output)).toBe("/home/me/.local/bin:/usr/bin");
  });

  it("gives up without both marks or with nothing between them", () => {
    expect(pathBetweenMarks("/usr/bin")).toBeUndefined();
    expect(pathBetweenMarks("__CERIUM_PATH__/usr/bin")).toBeUndefined();
    expect(pathBetweenMarks("__CERIUM_PATH____CERIUM_PATH__")).toBeUndefined();
  });
});

describe("mergePaths", () => {
  it("keeps the first PATH's order, then adds what only the second has", () => {
    expect(mergePaths("/home/me/.local/bin:/usr/bin", "/usr/bin:/bin::/usr/bin")).toBe(
      "/home/me/.local/bin:/usr/bin:/bin",
    );
  });
});

describe("withoutAppImage", () => {
  const appDir = "/tmp/.mount_CeriumAbc";

  it("takes the AppImage's folders off the lists its runtime prepends to", () => {
    const env = withoutAppImage(
      {
        PATH: `${appDir}:${appDir}/usr/sbin:/usr/bin`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib`,
        XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/local/share:/usr/share`,
        HOME: "/home/me",
      },
      appDir,
    );
    expect(env).toEqual({ PATH: "/usr/bin", XDG_DATA_DIRS: "/usr/local/share:/usr/share", HOME: "/home/me" });
  });

  it("leaves a folder that only starts like the AppImage's", () => {
    expect(withoutAppImage({ PATH: `${appDir}-other/bin` }, appDir)).toEqual({ PATH: `${appDir}-other/bin` });
  });
});

describe("withShellPath", () => {
  it("puts the shell's PATH ahead of the session's, and leaves the session's alone without one", () => {
    const env = { PATH: "/usr/bin:/bin", HOME: "/home/me" };
    expect(withShellPath(env, "/home/me/.local/bin:/usr/bin")).toEqual({
      PATH: "/home/me/.local/bin:/usr/bin:/bin",
      HOME: "/home/me",
    });
    expect(withShellPath(env, undefined)).toBe(env);
  });
});

describe("rememberedPath", () => {
  it("gives back the PATH kept last time, and none before one was kept", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cerium-shell-path-"));
    try {
      const file = join(folder, "shell-path.txt");
      expect(rememberedPath(file)).toBeUndefined();
      await rememberPath(file, "/home/me/.local/bin:/usr/bin");
      expect(rememberedPath(file)).toBe("/home/me/.local/bin:/usr/bin");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
