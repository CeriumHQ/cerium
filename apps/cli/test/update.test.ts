import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRelease } from "../src/update.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cerium-host-update-"));
  temporary.push(root);
  await mkdir(join(root, "releases"));
  const work = await mkdtemp(join(root, "releases", ".candidate-"));
  const staged = join(work, "payload");
  await mkdir(staged);
  await writeFile(join(staged, "version"), "2.0.0");
  const pointer = join(root, "current-version");
  await writeFile(pointer, "older\n");
  return { root, work, staged, pointer };
}

it("switches to a verified release before restarting", async () => {
  const { root, work, staged, pointer } = await fixture();
  const restart = vi.fn<() => void>();
  await activateRelease(root, work, staged, "2.0.0", "older\n", restart);
  const current = (await readFile(pointer, "utf8")).trim();
  expect(await readFile(join(root, "releases", current, "version"), "utf8")).toBe("2.0.0");
  expect(restart).toHaveBeenCalledOnce();
});

it("restores the previous release when the service manager fails", async () => {
  const { root, work, staged, pointer } = await fixture();
  const restart = vi.fn<() => void>().mockImplementationOnce(() => {
    throw new Error("Could not restart");
  });
  await expect(activateRelease(root, work, staged, "2.0.0", "older\n", restart)).rejects.toThrow(
    "Could not restart",
  );
  expect(await readFile(pointer, "utf8")).toBe("older\n");
  expect(restart).toHaveBeenCalledTimes(2);
});

it("preserves a concurrently activated release", async () => {
  const { root, work, staged, pointer } = await fixture();
  await writeFile(pointer, "newer\n");
  const restart = vi.fn<() => void>();
  await expect(activateRelease(root, work, staged, "2.0.0", "older\n", restart)).rejects.toThrow(
    /Another host update/,
  );
  expect(await readFile(pointer, "utf8")).toBe("newer\n");
  expect(restart).not.toHaveBeenCalled();
});
