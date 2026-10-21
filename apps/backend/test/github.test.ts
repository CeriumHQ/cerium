import { describe, expect, it } from "@effect/vitest";

import {
  chooseRemotes,
  ghFailure,
  loginPrompt,
  parseAuthStatus,
  parseAuthText,
  parseRemotes,
  parseRemoteUrl,
  parseResolved,
  repositoryOf,
} from "../src/github.ts";
import { parseConversation } from "../src/githubConversation.ts";

describe("remotes", () => {
  it("reads every way git spells a GitHub address", () => {
    const repository = { host: "github.com", owner: "nonlooped", name: "cerium" };
    for (const address of [
      "https://github.com/nonlooped/cerium.git",
      "https://github.com/nonlooped/cerium",
      "https://github.com/nonlooped/cerium/",
      "git@github.com:nonlooped/cerium.git",
      "github.com:nonlooped/cerium",
      "ssh://git@github.com/nonlooped/cerium.git",
      "ssh://git@ssh.github.com:443/nonlooped/cerium.git",
      "git://github.com/nonlooped/cerium.git",
      "https://user@github.com/nonlooped/cerium.git",
    ]) {
      expect([address, parseRemoteUrl(address)]).toEqual([address, repository]);
    }
    expect(parseRemoteUrl("git@github.example.com:team/app.git")).toEqual({
      host: "github.example.com",
      owner: "team",
      name: "app",
    });
  });

  it("refuses an address that names no owner and repository", () => {
    for (const address of [
      "/srv/git/app.git",
      "C:\\repos\\app",
      "https://github.com/nonlooped",
      "file:///x/y",
    ]) {
      expect([address, parseRemoteUrl(address)]).toEqual([address, undefined]);
    }
  });

  it("lists GitHub remotes once each, by where they fetch from", () => {
    const remotes = parseRemotes(
      [
        "origin\tgit@github.com:me/app.git (fetch)",
        "origin\tgit@github.com:me/app.git (push)",
        "upstream\thttps://github.com/team/app.git (fetch)",
        "upstream\tDISABLED (push)",
        "gitlab\thttps://gitlab.com/me/app.git (fetch)",
      ].join("\n"),
    );
    expect(remotes.map((remote) => [remote.name, remote.repository.owner])).toEqual([
      ["origin", "me"],
      ["upstream", "team"],
    ]);
  });

  it("works on upstream and pushes to origin, unless gh was told otherwise", () => {
    const remotes = parseRemotes(
      "origin\tgit@github.com:me/app.git (fetch)\nupstream\thttps://github.com/team/app.git (fetch)",
    );
    const plain = chooseRemotes(remotes, new Map());
    expect([plain?.base.name, plain?.push.name, plain?.chosen]).toEqual(["upstream", "origin", false]);
    const resolved = chooseRemotes(remotes, parseResolved("remote.origin.gh-resolved base\n"));
    expect([resolved?.base.name, resolved?.chosen]).toEqual(["origin", true]);
    const named = chooseRemotes(remotes, parseResolved("remote.origin.gh-resolved other/fork"));
    expect(named?.base.repository).toEqual({ host: "github.com", owner: "other", name: "fork" });
    expect(chooseRemotes([], new Map())).toBeUndefined();
  });
});

describe("gh's output", () => {
  it("reads the accounts gh auth status lists, never a token", () => {
    const accounts = parseAuthStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            { state: "success", active: true, host: "github.com", login: "me", tokenSource: "keyring" },
            { state: "error", active: false, host: "github.com", login: "old", token: "gho_secret" },
          ],
        },
      }),
    );
    expect(accounts).toEqual([
      { host: "github.com", login: "me", active: true },
      { host: "github.com", login: "old", active: false, failing: true },
    ]);
    expect(JSON.stringify(accounts)).not.toContain("gho_");
    expect(parseAuthStatus("not json")).toEqual([]);
  });

  it("reads an older gh's words", () => {
    expect(
      parseAuthText(
        "github.com\n  ✓ Logged in to github.com account me (keyring)\n  - Active account: true\nghe.io\n  X Failed to log in to ghe.io account you (default)",
      ),
    ).toEqual([
      { host: "github.com", login: "me", active: true },
      { host: "ghe.io", login: "you", active: true, failing: true },
    ]);
  });

  it("finds the one-time code and page of a web sign-in, in old and new words", () => {
    expect(
      loginPrompt(
        "\n! One-time code (1E9E-FDED) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
      ),
    ).toEqual({ code: "1E9E-FDED", url: "https://github.com/login/device" });
    expect(
      loginPrompt(
        "! First copy your one-time code: AB12-CD34\nPress Enter to open https://github.com/login/device",
      ),
    ).toEqual({ code: "AB12-CD34", url: "https://github.com/login/device" });
    expect(loginPrompt("! First copy your one-time code: AB12-CD34\n")).toBeUndefined();
  });

  it("says what went wrong in words the user can act on", () => {
    expect(ghFailure("To get started with GitHub CLI, please run:  gh auth login").reason).toBe("signedOut");
    expect(ghFailure("gh: Bad credentials (HTTP 401)").reason).toBe("signedOut");
    expect(ghFailure("gh: API rate limit exceeded for user ID 1. (HTTP 403)").reason).toBe("rateLimited");
    expect(
      ghFailure("", JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] })).reason,
    ).toBe("rateLimited");
    expect(ghFailure("error connecting to api.github.com\ncheck your internet connection").reason).toBe(
      "offline",
    );
    expect(ghFailure("gh: Not Found (HTTP 404)").reason).toBe("notFound");
    const refused = ghFailure(
      "gh: Validation Failed (HTTP 422)",
      JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "A pull request already exists for me:x." }],
      }),
    );
    expect(refused).toMatchObject({
      reason: "failed",
      message: "Validation Failed: A pull request already exists for me:x.",
    });
    expect(ghFailure("gh: something odd").message).toBe("something odd");
  });

  it("reads a repository's merge methods and the account's permission", () => {
    const repository = repositoryOf(
      "github.com",
      {
        owner: { login: "team" },
        name: "app",
        url: "https://github.com/team/app",
        isPrivate: true,
        viewerPermission: "WRITE",
        defaultBranchRef: { name: "trunk" },
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        deleteBranchOnMerge: true,
        hasIssuesEnabled: false,
      },
      "me",
    );
    expect(repository).toEqual({
      host: "github.com",
      owner: "team",
      name: "app",
      url: "https://github.com/team/app",
      defaultBranch: "trunk",
      viewer: "me",
      permission: "write",
      mergeMethods: ["squash", "rebase"],
      deleteBranchOnMerge: true,
      hasIssues: false,
      private: true,
    });
    expect(repositoryOf("github.com", null, "me")).toBeUndefined();
  });
});

describe("conversations", () => {
  const actor = { login: "me", avatarUrl: "https://avatars/me" };
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
  const commit = (oid: string, minute: number) => ({
    __typename: "PullRequestCommit",
    commit: {
      oid,
      messageHeadline: `commit ${oid}`,
      committedDate: at(minute),
      url: `https://github.com/team/app/commit/${oid}`,
      author: { name: "Me", user: actor },
    },
  });

  it("gathers commits pushed one after another, and labels changed in one go", () => {
    const items = parseConversation(
      [
        commit("a", 0),
        commit("b", 1),
        { __typename: "LabeledEvent", createdAt: at(2), actor, label: { name: "bug", color: "d73a4a" } },
        { __typename: "LabeledEvent", createdAt: at(2), actor, label: { name: "ui", color: "0e8a16" } },
        { __typename: "UnlabeledEvent", createdAt: at(2), actor, label: { name: "ui", color: "0e8a16" } },
        commit("c", 40),
      ],
      "team/app",
    );
    expect(items.map((item) => item._tag)).toEqual(["Commits", "Labels", "Commits"]);
    expect(items[0]?._tag === "Commits" ? items[0].commits.map((each) => each.oid) : []).toEqual(["a", "b"]);
    expect(items[1]).toMatchObject({ added: [{ name: "bug" }], removed: [] });
  });

  it("reads a pull request's own events and reviews", () => {
    const items = parseConversation(
      [
        {
          __typename: "PullRequestReview",
          id: "R1",
          body: "Looks good",
          createdAt: at(0),
          submittedAt: at(5),
          state: "APPROVED",
          authorAssociation: "MEMBER",
          author: actor,
          reactionGroups: [{ content: "HEART", viewerHasReacted: true, reactors: { totalCount: 2 } }],
        },
        // A review still being written has no submission time, and isn't shown.
        {
          __typename: "PullRequestReview",
          id: "R2",
          body: "",
          createdAt: at(6),
          state: "PENDING",
          author: actor,
        },
        {
          __typename: "ReviewRequestedEvent",
          createdAt: at(7),
          actor,
          requestedReviewer: { __typename: "Team", name: "core" },
        },
        {
          __typename: "MergedEvent",
          createdAt: at(8),
          actor,
          mergeRefName: "main",
          commit: { oid: "abc", url: "u" },
        },
        { __typename: "ReadyForReviewEvent", createdAt: at(9), actor },
        { __typename: "HeadRefDeletedEvent", createdAt: at(10), actor },
        { __typename: "SomethingNew", createdAt: at(11), actor },
      ],
      "team/app",
    );
    expect(items).toEqual([
      {
        _tag: "Review",
        id: "R1",
        author: actor,
        body: "Looks good",
        at: Date.parse(at(5)),
        association: "member",
        reactions: [{ kind: "heart", count: 2, mine: true }],
        state: "approved",
      },
      { _tag: "ReviewRequested", at: Date.parse(at(7)), actor, reviewer: "core", removed: false },
      { _tag: "Merged", at: Date.parse(at(8)), actor, oid: "abc", base: "main", url: "u" },
      { _tag: "Draft", at: Date.parse(at(9)), actor, draft: false },
      { _tag: "Branch", at: Date.parse(at(10)), actor, deleted: true },
    ]);
  });
});
