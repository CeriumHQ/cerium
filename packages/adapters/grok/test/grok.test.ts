import { execFile } from "node:child_process";
import { copyFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "@effect/vitest";

const run = promisify(execFile);
const fixture = new URL("./fixtures/grok.mjs", import.meta.url);
const driver = fileURLToPath(new URL("./e2e-driver.ts", import.meta.url));

it.skipIf(process.platform === "win32")("drives the Grok adapter through a local ACP process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cerium-grok-test-"));
  try {
    const executable = join(cwd, "grok");
    await copyFile(fixture, executable);
    await chmod(executable, 0o700);
    const env = {
      ...process.env,
      PATH: [cwd, process.env.PATH].join(delimiter),
      CERIUM_GROK_HUB_TEST_SECRET: "fixture-secret",
    };

    const { stdout } = await run(process.execPath, [driver], { cwd, env });
    expect(stdout.trim().split("\n")).toEqual([
      "PASS install, provider auth, and model catalog",
      "PASS native Grok config, skill discovery, toggles and blank MCP copies",
      "PASS session imports, turn-boundary forks and side questions",
      "PASS ACP streaming, images, MCP injection, approval and token usage",
      "PASS one-time approvals never select persistent ACP options",
      "PASS model switch and cancellation while awaiting permission",
      "PASS explicit compaction and background task lifecycle",
      "PASS cold resume, read-only denial, and process exit",
    ]);
    const loggedOut = await run(process.execPath, [driver], { cwd, env: { ...env, GROK_TEST_LOGOUT: "1" } });
    expect(loggedOut.stdout.trim()).toBe("PASS provider-local login required");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
