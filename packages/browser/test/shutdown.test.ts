import { assert, describe, it, vi } from "@effect/vitest";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { closeBrowser, findBrowser, launchBrowser } from "../src/browser.ts";

const browser = findBrowser();
if (process.env["CI"] === "true" && browser === undefined) {
  throw new Error("The CI browser suite requires Edge or Chrome on this runner.");
}

/** Once `child` has exited. */
const exited = async (child: ChildProcess) => {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
};

describe.skipIf(browser === undefined)("closing a launched browser", () => {
  it("asks the browser to close rather than killing it, then removes its profile", async () => {
    const launched = await launchBrowser({ executable: browser!, visible: false, width: 800, height: 600 });
    await launched.close();
    await exited(launched.process);
    // A kill would have ended it on a signal; Windows has none to tell by.
    if (process.platform !== "win32") assert.isNull(launched.process.signalCode);
    await vi.waitFor(() => assert.isFalse(existsSync(launched.handle.profile)), { timeout: 10_000 });
  });

  it("kills the browser when its debugging socket can't close it, and still removes its profile", async () => {
    const launched = await launchBrowser({ executable: browser!, visible: false, width: 800, height: 600 });
    await closeBrowser({ socket: undefined, profile: launched.handle.profile });
    assert.isFalse(existsSync(launched.handle.profile));
    await exited(launched.process);
    if (process.platform !== "win32") assert.strictEqual(launched.process.signalCode, "SIGKILL");
  });
});
