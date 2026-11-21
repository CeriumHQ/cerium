import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { gatherPackages } from "../merge-update-files.ts";

describe("release artifact collection", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cerium-release-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (platform: string, file: string, content: string) => {
    const dir = join(root, "from", platform);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content);
  };
  it("keeps the original platform feeds byte for byte", () => {
    const feeds = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
    for (const feed of feeds) put(feed + "-runner", feed, "version: 1.2.3\n");
    gatherPackages(join(root, "from"), join(root, "out"));
    for (const feed of feeds) expect(readFileSync(join(root, "out", feed), "utf8")).toBe("version: 1.2.3\n");
  });
  it("rejects colliding feeds before moving files", () => {
    put("one", "latest.yml", "one");
    put("two", "latest.yml", "two");
    expect(() => gatherPackages(join(root, "from"), join(root, "out"))).toThrow("Multiple runners");
    expect(readFileSync(join(root, "from", "one", "latest.yml"), "utf8")).toBe("one");
  });
});
