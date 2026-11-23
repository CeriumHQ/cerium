import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pointer = join(root, "current-version");
process.env.CERIUM_HOST_INSTALL_ROOT = root;
const daemon = process.argv[2] === "run";
let child,
  stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
for (;;) {
  const selected = existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : undefined;
  if (
    selected !== undefined &&
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-nightly\.n?[0-9]+)?-[0-9a-f-]{36}$/.test(selected)
  )
    throw new Error("Invalid Cerium Host installation pointer.");
  const release = selected ? join(root, "releases", selected) : root;
  const node = join(release, "runtime", process.platform === "win32" ? "node.exe" : "bin/node");
  const args = [join(release, "dist", "cli.mjs"), ...process.argv.slice(2)];
  if (!daemon && process.platform !== "win32" && process.execve)
    process.execve(node, [node, ...args], process.env);
  child = spawn(node, args, { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  // EX_TEMPFAIL is reserved here for a verified remote upgrade. Relaunch the new runtime under
  // the same native service or foreground process, after the old backend has released its lock.
  if (!daemon || code !== 75 || stopping) {
    process.exitCode = code;
    break;
  }
}
