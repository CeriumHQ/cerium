import { describe, expect, it } from "@effect/vitest";

import { plainGitFailure, refuseCloneUrl, repositoryName } from "../src/clone.ts";

describe("refuseCloneUrl", () => {
  it("accepts web, git and SSH addresses", () => {
    for (const url of [
      "https://github.com/nonlooped/cerium.git",
      "http://example.com/team/app",
      "ssh://git@example.com/team/app.git",
      "git://example.com/app.git",
      "git@github.com:nonlooped/cerium.git",
    ]) {
      expect([url, refuseCloneUrl(url)]).toEqual([url, undefined]);
    }
  });

  it("refuses transports that run commands, read local files, or read as options", () => {
    for (const url of [
      "ext::sh -c touch /tmp/x",
      "ext::sh%20-c%20touch%20/tmp/x",
      "file:///etc",
      "C:\\Users\\me\\repo",
      "/home/me/repo",
      "-oProxyCommand=touch x",
      "ssh://-oProxyCommand=touch/x",
      "git@-oProxy:repo.git",
      "",
      "not a url",
    ]) {
      expect([url, refuseCloneUrl(url) !== undefined]).toEqual([url, true]);
    }
  });
});

describe("repositoryName", () => {
  it("names the clone after the repository, without .git", () => {
    expect(repositoryName("https://github.com/nonlooped/cerium.git")).toBe("cerium");
    expect(repositoryName("https://github.com/nonlooped/cerium/")).toBe("cerium");
    expect(repositoryName("git@github.com:nonlooped/cerium.git")).toBe("cerium");
    expect(repositoryName("ssh://git@example.com:2222/team/app.GIT")).toBe("app");
  });

  it("finds no usable name for an address that ends in nothing a folder can hold", () => {
    expect(repositoryName("https://example.com/")).toBeUndefined();
    expect(repositoryName("https://example.com/..")).toBeUndefined();
    expect(repositoryName("https://example.com/bad:name")).toBeUndefined();
  });
});

describe("plainGitFailure", () => {
  it("says the common failures in plain words", () => {
    expect(plainGitFailure("fatal: unable to access 'https://x/': Could not resolve host: x", "")).toMatch(
      /couldn't find that address/,
    );
    expect(
      plainGitFailure("remote: Repository not found.\nfatal: repository 'https://x/y/' not found", ""),
    ).toMatch(/private and Git isn't signed in/);
    expect(
      plainGitFailure(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "",
      ),
    ).toMatch(/needs a sign-in/);
    expect(
      plainGitFailure("fatal: destination path 'app' already exists and is not an empty directory.", ""),
    ).toMatch(/already holds something/);
  });

  it("falls back to git's own last fatal line, then to the given fallback", () => {
    expect(plainGitFailure("Cloning into 'x'...\nfatal: something odd happened\n", "fallback")).toBe(
      "something odd happened",
    );
    expect(plainGitFailure("", "The clone didn't finish.")).toBe("The clone didn't finish.");
  });
});
