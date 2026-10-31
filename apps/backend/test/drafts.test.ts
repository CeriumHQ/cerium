import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { CatalogEntry } from "@cerium/orchestrator";

import {
  capped,
  draftModels,
  Drafts,
  guidanceOn,
  parseDraft,
  QuickWriter,
} from "../src/drafts.ts";
import { Git } from "../src/git.ts";
import { madeOnce } from "./repositories.ts";

const entry = (provider: CatalogEntry["provider"], model: string): CatalogEntry => ({
  alias: model,
  provider,
  model,
  description: "",
});

/** Runs git in `cwd` as the test's own user, away from the machine's git configuration. */
const run = Effect.fn("git")(function* (cwd: string, ...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args],
      { cwd },
    ),
  );
});

/** The repository each test copies: one commit, "first", on `main`. */
const first = madeOnce(
  Effect.fn("first")(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* run(root, "init", "-q", "-b", "main");
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", ".git/hooks"],
    ] as const)
      yield* run(root, "config", key, value);
    yield* fs.makeDirectory(path.join(root, "src"));
    yield* fs.writeFileString(
      path.join(root, "src", "app.ts"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    yield* fs.writeFileString(path.join(root, "README.md"), "# Title\n");
    yield* run(root, "add", "-A");
    yield* run(root, "commit", "-q", "-m", "first");
  }),
);

/** A repository with one commit, "first", on `main`. */
const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  const git = (...args: Array<string>) => run(root, ...args);
  yield* first(root);
  return { root, write, git };
});

describe("draft models", () => {
  it("asks the user's pick alone, else Cerium's quick models on offer, else the first model there is", () => {
    const picked = { provider: "muse", model: "muse-spark-1.3" } as const;
    expect(draftModels({ enabled: true, model: picked }, [])).toEqual([picked]);
    expect(draftModels({ enabled: false }, [entry("claude", "opus"), entry("claude", "haiku")])).toEqual([
      { provider: "claude", model: "haiku" },
    ]);
    expect(draftModels({ enabled: true }, [entry("claude", "opus")])).toEqual([
      { provider: "claude", model: "opus" },
    ]);
    expect(draftModels({ enabled: true }, [])).toEqual([]);
  });
});

describe("guidance", () => {
  const guide = [
    "# Project",
    "",
    "- Tests run with `bun test`.",
    "- Commit messages are a single Conventional Commits subject line: no body,",
    "  no trailers.",
    "",
    "## Pull requests",
    "",
    "Keep them small.",
    "",
    "- Link the issue they close.",
    "",
    "## Releases",
    "",
    "Tag them by hand.",
  ].join("\n");

  it("finds the passages about a topic, and every one under a heading about it", () => {
    expect(guidanceOn(guide, /commit messages?/i)).toEqual([
      "- Commit messages are a single Conventional Commits subject line: no body,\n  no trailers.",
    ]);
    expect(guidanceOn(guide, /pull requests?/i)).toEqual([
      "Keep them small.",
      "- Link the issue they close.",
    ]);
    expect(guidanceOn(guide, /issues? templates?/i)).toEqual([]);
  });

  it("cuts long text at a line", () => {
    expect(capped("one\ntwo\nthree", 9)).toBe("one\ntwo\n… (cut here)");
    expect(capped("short", 9)).toBe("short");
  });
});

describe("replies", () => {
  it("reads a title and the text under it, without fences, labels or quotes", () => {
    expect(parseDraft("feat(ui): add a button")).toEqual({ title: "feat(ui): add a button", body: "" });
    expect(parseDraft('```\nTitle: "Fix the crash"\n\nBody: It crashed.\nNow it doesn\'t.\n```')).toEqual({
      title: "Fix the crash",
      body: "It crashed.\nNow it doesn't.",
    });
    expect(parseDraft("## **Title:** Speed up search\n\n## Summary\n- Faster")).toEqual({
      title: "Speed up search",
      body: "## Summary\n- Faster",
    });
    expect(parseDraft("  \n ")).toBeUndefined();
    // Quotes inside the title aren't the title's own.
    expect(parseDraft('Search misses "README" for "readme"')?.title).toBe(
      'Search misses "README" for "readme"',
    );
    expect(parseDraft("fix: match *.md and *.txt")?.title).toBe("fix: match *.md and *.txt");
    expect(parseDraft("**`Add a cache`**")?.title).toBe("Add a cache");
  });
});

/** A quick model that answers `reply`, keeping what it was asked. */
const fakeWriter = (reply: string | undefined) => {
  const asked: Array<string> = [];
  const layer = Layer.succeed(
    QuickWriter,
    QuickWriter.of({
      write: (_instructions, prompt) =>
        Effect.sync(() => {
          asked.push(prompt);
          return Option.fromNullishOr(reply);
        }),
    }),
  );
  return { asked, layer };
};

const testLayer = (writer: Layer.Layer<QuickWriter>) =>
  Drafts.layer.pipe(Layer.provide(writer), Layer.provide(Git.layer), Layer.provideMerge(NodeServices.layer));

describe("Drafts", () => {
  it.effect("writes a commit message from what's staged, in the style of the repository's commits", () => {
    const writer = fakeWriter("```\nfeat(app): count to eleven\n```");
    return Effect.gen(function* () {
      const drafts = yield* Drafts;
      const { root, write, git } = yield* repository;
      yield* write("AGENTS.md", "# Rules\n\n- Commit messages follow Conventional Commits.\n- Use tabs.\n");
      yield* write(
        "commitlint.config.js",
        "export default { extends: ['@commitlint/config-conventional'] };\n",
      );
      yield* git("add", "AGENTS.md", "commitlint.config.js");
      yield* git("commit", "-q", "-m", "chore: add the rules", "-m", "With a body.");
      yield* write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n");
      yield* write("notes.txt", "not staged\n");
      yield* git("add", "src/app.ts");

      const message = yield* drafts.commitMessage(root, { draft: "count further" });
      assert.strictEqual(message, "feat(app): count to eleven");
      const prompt = writer.asked[0] ?? "";
      assert.include(prompt, "- Commit messages follow Conventional Commits.");
      assert.notInclude(prompt, "Use tabs");
      assert.include(prompt, "config-conventional");
      assert.include(prompt, "1 of these 2 commits have a body");
      assert.include(prompt, "- chore: add the rules\n- first");
      assert.include(prompt, "count further");
      assert.include(prompt, "+eleven");
      // Only what's staged goes in.
      assert.notInclude(prompt, "notes.txt");
    }).pipe(Effect.scoped, Effect.provide(testLayer(writer.layer)));
  });

  it.effect("writes of everything changed, new files too, when nothing is staged", () => {
    const writer = fakeWriter("Add notes\n\nAnd change the title.");
    return Effect.gen(function* () {
      const drafts = yield* Drafts;
      const { root, write } = yield* repository;
      yield* write("README.md", "# Changed\n");
      yield* write("notes.txt", "remember the milk\n");
      // Far longer than what's read of it, in characters of two bytes each.
      yield* write("wide.txt", `${"ü".repeat(2_000_000)}\n`);

      assert.strictEqual(yield* drafts.commitMessage(root, {}), "Add notes\n\nAnd change the title.");
      const prompt = writer.asked[0] ?? "";
      assert.include(prompt, "+# Changed");
      assert.include(prompt, "New file notes.txt:\nremember the milk");
      assert.include(prompt, `New file wide.txt:\n${"ü".repeat(1_200)}\n… (cut here)`);
    }).pipe(Effect.scoped, Effect.provide(testLayer(writer.layer)));
  });

  it.effect("says when there's nothing to write about, or no model answered", () => {
    const writer = fakeWriter(undefined);
    return Effect.gen(function* () {
      const drafts = yield* Drafts;
      const { root, write } = yield* repository;
      assert.match((yield* Effect.flip(drafts.commitMessage(root, {}))).message, /Nothing to commit/);
      assert.lengthOf(writer.asked, 0);
      yield* write("README.md", "# Changed\n");
      assert.match((yield* Effect.flip(drafts.commitMessage(root, {}))).message, /No quick model answered/);
    }).pipe(Effect.scoped, Effect.provide(testLayer(writer.layer)));
  });

  it.effect("writes a pull request from the branch's commits, in the repository's template", () => {
    const writer = fakeWriter("Count to eleven\n\n## Summary\n- Adds eleven.");
    return Effect.gen(function* () {
      const drafts = yield* Drafts;
      const { root, write, git } = yield* repository;
      yield* write(".github/pull_request_template.md", "## Summary\n\n## Testing\n");
      yield* git("add", "-A");
      yield* git("commit", "-q", "-m", "Add a template");
      yield* git("checkout", "-q", "-b", "eleven");
      yield* write("src/app.ts", "eleven\n");
      yield* git("commit", "-q", "-am", "Count to eleven", "-m", "Ten wasn't enough.");

      const made = yield* drafts.pullRequest(root, "main", { title: "Eleven", body: "" });
      assert.deepStrictEqual(made, { title: "Count to eleven", body: "## Summary\n- Adds eleven." });
      const prompt = writer.asked[0] ?? "";
      assert.include(prompt, "merges the branch eleven into main");
      assert.include(prompt, "<template>\n## Summary\n\n## Testing");
      assert.include(prompt, "- Add a template\n- first");
      assert.include(prompt, "- Count to eleven\nTen wasn't enough.");
      assert.include(prompt, "Title: Eleven");
      assert.include(prompt, "+eleven");

      assert.match(
        (yield* Effect.flip(drafts.pullRequest(root, "nowhere", { title: "", body: "" }))).message,
        /no branch nowhere/,
      );
      yield* git("checkout", "-q", "main");
      assert.match(
        (yield* Effect.flip(drafts.pullRequest(root, "main", { title: "", body: "" }))).message,
        /no commits that aren't on main/,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer(writer.layer)));
  });

  it.effect("writes an issue up from the user's notes, with the repository's templates", () => {
    const writer = fakeWriter("Search is slow\n\n### What happened\nIt takes ten seconds.");
    return Effect.gen(function* () {
      const drafts = yield* Drafts;
      const { root, write } = yield* repository;
      yield* write(".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug\nlabels: bug\n---\n### What happened\n");
      yield* write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");

      assert.match((yield* Effect.flip(drafts.issue(root, { title: " ", body: "" }))).message, /Jot down/);
      const made = yield* drafts.issue(root, { title: "", body: "search takes 10s" });
      assert.deepStrictEqual(made, {
        title: "Search is slow",
        body: "### What happened\nIt takes ten seconds.",
      });
      const prompt = writer.asked[0] ?? "";
      assert.include(prompt, '<template name="bug.md">\n### What happened\n</template>');
      assert.notInclude(prompt, "blank_issues_enabled");
      assert.include(prompt, "<notes>\nsearch takes 10s\n</notes>");
    }).pipe(Effect.scoped, Effect.provide(testLayer(writer.layer)));
  });
});
