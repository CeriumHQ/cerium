import { UserSettings } from "@cerium/orchestrator";
import {
  defaultSettings,
  hubInstructionStatus,
  type HubInstructionFile,
  type ProviderId,
} from "@cerium/protocol";
import type { HubInstructionSync } from "@cerium/rpc";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Stream } from "effect";

import { hubHandlers } from "../src/hub.ts";
import { AdaptersLive } from "../src/layers.ts";

const withAdapters = Effect.provide(AdaptersLive.pipe(Layer.provideMerge(NodeServices.layer)));
const AGENTS = "AGENTS.md";
const CLAUDE = "CLAUDE.md";
const COPILOT = ".github/copilot-instructions.md";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const handlers = yield* hubHandlers;
  const project = yield* fs.makeTempDirectoryScoped();
  return {
    project,
    fs,
    at: (file: string) => path.join(project, file),
    read: handlers.ReadHubInstructions,
    sync: handlers.SyncHubInstructions,
  };
});

const find = (files: ReadonlyArray<HubInstructionFile>, path: string) => {
  const file = files.find((item) => item.path === path);
  assert.isDefined(file, path);
  return file!;
};
const review = ({ path, revision }: HubInstructionFile) => ({ path, revision });

describe("Hub project instructions", () => {
  it.effect("discovers standard files and supplemental rules for all nine adapters", () =>
    Effect.gen(function* () {
      const { project, fs, at, read } = yield* fixture;
      yield* fs.makeDirectory(at(".cursor/rules/nested"), { recursive: true });
      yield* fs.makeDirectory(at(".github/instructions"), { recursive: true });
      yield* fs.makeDirectory(at(".claude/rules"), { recursive: true });
      yield* fs.makeDirectory(at(".agent/rules"), { recursive: true });
      yield* fs.writeFileString(at(AGENTS), "Common guidance\r\n");
      yield* fs.writeFileString(at("AGENTS.override.md"), "Codex override\n");
      yield* fs.writeFileString(at("GEMINI.md"), "Gemini guidance\n");
      yield* fs.writeFileString(at("CLAUDE.local.md"), "Local rules\n");
      yield* fs.writeFileString(at(".cursor/rules/nested/code.mdc"), "---\nalwaysApply: true\n---\nCursor\n");
      yield* fs.writeFileString(at(".cursor/rules/ignored.txt"), "Ignored");
      yield* fs.writeFileString(at(".github/instructions/src.instructions.md"), "GitHub");
      yield* fs.writeFileString(at(".claude/rules/code.md"), "Shared Claude-compatible rule");
      yield* fs.writeFileString(at(".agent/rules/legacy.md"), "Antigravity");
      const files = yield* read({ project });
      const canonical = find(files, AGENTS);
      assert.sameMembers(
        [...canonical.providers],
        ["antigravity", "claude", "codex", "copilot", "cursor", "devin", "grok", "muse", "opencode"],
      );
      assert.deepEqual(find(files, COPILOT).providers, ["copilot"]);
      assert.strictEqual(canonical.content, "Common guidance\r\n");
      assert.deepEqual(find(files, "AGENTS.override.md").providers, ["codex"]);
      assert.sameMembers([...find(files, "GEMINI.md").providers], ["antigravity", "copilot"]);
      assert.isTrue(find(files, ".cursor/rules/nested/code.mdc").supplemental);
      assert.isTrue(find(files, ".github/instructions/src.instructions.md").supplemental);
      assert.sameMembers([...find(files, ".claude/rules/code.md").providers], ["claude", "copilot", "grok"]);
      assert.isTrue(find(files, "CLAUDE.local.md").supplemental);
      assert.isTrue(find(files, ".agent/rules/legacy.md").supplemental);
      assert.isFalse(files.some((file) => file.path.endsWith("ignored.txt")));
      assert.strictEqual(hubInstructionStatus(find(files, CLAUDE), canonical), "missing");
      assert.strictEqual(hubInstructionStatus(find(files, "AGENTS.override.md"), canonical), "diverged");
    }).pipe(withAdapters),
  );

  it.effect("creates a canonical file and copies it, including missing parent directories", () =>
    Effect.gen(function* () {
      const { project, fs, at, read, sync } = yield* fixture;
      const files = yield* read({ project });
      const text = "\uFEFF# Instructions\r\nUse Effect.\r\n";
      const outcome = yield* sync({
        project,
        source: { ...review(find(files, AGENTS)), content: text },
        targets: [review(find(files, CLAUDE)), review(find(files, COPILOT))],
        mode: "copy",
      });
      assert.deepEqual(outcome, [
        { path: CLAUDE, result: "copied" },
        { path: COPILOT, result: "copied" },
      ]);
      assert.deepEqual(yield* fs.readFile(at(COPILOT)), new TextEncoder().encode(text));
      const current = yield* read({ project });
      const canonical = find(current, AGENTS);
      assert.strictEqual(canonical.content, text);
      assert.strictEqual(hubInstructionStatus(find(current, CLAUDE), canonical), "inSync");
      const retry = yield* sync({
        project,
        source: review(canonical),
        targets: [review(find(current, CLAUDE))],
        mode: "copy",
      });
      assert.deepEqual(retry, [{ path: CLAUDE, result: "unchanged" }]);
      assert.strictEqual(find(yield* read({ project }), CLAUDE).revision, find(current, CLAUDE).revision);
    }).pipe(withAdapters),
  );

  it.effect("requires per-file replacement and validates the entire batch before saving", () =>
    Effect.gen(function* () {
      const { project, fs, at, read, sync } = yield* fixture;
      yield* fs.writeFileString(at(AGENTS), "Shared v1");
      yield* fs.writeFileString(at(CLAUDE), "Independent");
      const listed = yield* read({ project });
      const source = { ...review(find(listed, AGENTS)), content: "Shared v2" };
      const targets = [review(find(listed, COPILOT)), review(find(listed, CLAUDE))];
      const request = { project, source, targets, mode: "copy" } satisfies HubInstructionSync;
      const refused = yield* Effect.flip(sync(request));
      assert.match(refused.message, /CLAUDE\.md differs/);
      assert.isFalse(yield* fs.exists(at(".github")));
      assert.strictEqual(yield* fs.readFileString(at(AGENTS)), "Shared v1");
      assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "Independent");
      yield* sync({ ...request, targets: [targets[0]!, { ...targets[1]!, replace: true }] });
      assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "Shared v2");
      assert.strictEqual(yield* fs.readFileString(at(COPILOT)), "Shared v2");

      const copied = yield* read({ project });
      yield* sync({
        ...request,
        source: { ...review(find(copied, AGENTS)), content: "Shared v3" },
        targets: [review(find(copied, CLAUDE))],
      });
      assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "Shared v3");
      const current = yield* read({ project });
      assert.strictEqual(hubInstructionStatus(find(current, COPILOT), find(current, AGENTS)), "diverged");
    }).pipe(withAdapters),
  );

  it.effect(
    "refuses stale sources, stale replacement approval, and destinations created since discovery",
    () =>
      Effect.gen(function* () {
        const { project, fs, at, read, sync } = yield* fixture;
        yield* fs.writeFileString(at(AGENTS), "Shared");
        yield* fs.writeFileString(at(CLAUDE), "Old divergence");
        const listed = yield* read({ project });
        const source = review(find(listed, AGENTS));
        const target = { ...review(find(listed, CLAUDE)), replace: true };
        yield* fs.writeFileString(at(CLAUDE), "New divergence");
        assert.match(
          (yield* Effect.flip(sync({ project, source, targets: [target], mode: "copy" }))).message,
          /changed/,
        );
        assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "New divergence");
        yield* fs.makeDirectory(at(".github"));
        yield* fs.writeFileString(at(COPILOT), "");
        const missing = review(find(listed, COPILOT));
        assert.match(
          (yield* Effect.flip(sync({ project, source, targets: [missing], mode: "copy" }))).message,
          /changed/,
        );
        assert.strictEqual(yield* fs.readFileString(at(COPILOT)), "");
        yield* fs.writeFileString(at(AGENTS), "External edit");
        assert.match(
          (yield* Effect.flip(
            sync({ project, source: { ...source, content: "Stale edit" }, targets: [], mode: "copy" }),
          )).message,
          /AGENTS\.md changed/,
        );
        assert.strictEqual(yield* fs.readFileString(at(AGENTS)), "External edit");
      }).pipe(withAdapters),
  );

  it.effect("serializes concurrent saves against the same revision", () =>
    Effect.gen(function* () {
      const { project, fs, at, read, sync } = yield* fixture;
      yield* fs.writeFileString(at(AGENTS), "Original");
      const source = review(find(yield* read({ project }), AGENTS));
      const results = yield* Effect.forEach(
        ["First", "Second"],
        (content) =>
          sync({ project, source: { ...source, content }, targets: [], mode: "copy" }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.lengthOf(results.filter(Result.isSuccess), 1);
      assert.lengthOf(results.filter(Result.isFailure), 1);
      assert.include(["First", "Second"], yield* fs.readFileString(at(AGENTS)));
    }).pipe(withAdapters),
  );

  it.effect("reports a per-file write failure and keeps successful copies available for retry", () =>
    Effect.gen(function* () {
      const { project, fs, at, read, sync } = yield* fixture;
      yield* fs.writeFileString(at("AGENTS.override.md"), "@docs/other.md\n");
      const files = yield* read({ project });
      const request = {
        project,
        source: review(find(files, "AGENTS.override.md")),
        targets: [review(find(files, CLAUDE)), review(find(files, AGENTS))],
        mode: "copy",
      } satisfies HubInstructionSync;
      const result = yield* sync(request);
      assert.deepEqual(result, [
        {
          path: CLAUDE,
          result: "skipped",
          problem: "This harness would interpret the copy as an import. Sync it as a link.",
        },
        { path: AGENTS, result: "copied" },
      ]);
      assert.isFalse(yield* fs.exists(at(CLAUDE)));
      assert.strictEqual(yield* fs.readFileString(at(AGENTS)), "@docs/other.md\n");
      const reloaded = yield* read({ project });
      assert.strictEqual(
        hubInstructionStatus(find(reloaded, AGENTS), find(reloaded, "AGENTS.override.md")),
        "inSync",
      );
    }).pipe(withAdapters),
  );

  it.effect(
    "follows native imports, exposes the referenced Markdown as a canonical source, and repairs a broken import",
    () =>
      Effect.gen(function* () {
        const { project, fs, at, read, sync } = yield* fixture;
        yield* fs.makeDirectory(at("docs"));
        yield* fs.writeFileString(at("docs/project guidance.md"), "Canonical guidance");
        yield* fs.writeFileString(at(CLAUDE), "@docs/project\\ guidance.md\n");
        let files = yield* read({ project });
        const guidance = find(files, "docs/project guidance.md");
        assert.isTrue(guidance.sourceOnly);
        assert.strictEqual(hubInstructionStatus(find(files, CLAUDE), guidance), "linked");
        yield* sync({
          project,
          source: { ...review(guidance), content: "Edited" },
          targets: [review(find(files, CLAUDE))],
          mode: "copy",
        });
        assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "@docs/project\\ guidance.md\n");
        assert.strictEqual(find(yield* read({ project }), CLAUDE).content, "Edited");

        yield* fs.writeFileString(at(AGENTS), "New source");
        yield* fs.remove(at("docs/project guidance.md"));
        files = yield* read({ project });
        const canonical = find(files, AGENTS);
        const broken = find(files, CLAUDE);
        assert.strictEqual(hubInstructionStatus(broken, canonical), "diverged");
        assert.match(broken.problem ?? "", /broken/);
        yield* sync({
          project,
          source: review(canonical),
          targets: [{ ...review(broken), replace: true }],
          mode: "link",
        });
        assert.strictEqual(yield* fs.readFileString(at(CLAUDE)), "@AGENTS.md\n");
        assert.strictEqual(hubInstructionStatus(find(yield* read({ project }), CLAUDE), canonical), "linked");
      }).pipe(withAdapters),
  );

  it.effect.skipIf(process.platform === "win32")(
    "links in nested locations with relative symlinks and keeps links when saving the source",
    () =>
      Effect.gen(function* () {
        const { project, fs, at, read, sync } = yield* fixture;
        yield* fs.writeFileString(at(AGENTS), "Original");
        const files = yield* read({ project });
        yield* sync({
          project,
          source: review(find(files, AGENTS)),
          targets: [review(find(files, COPILOT))],
          mode: "link",
        });
        assert.strictEqual(yield* fs.readLink(at(COPILOT)), "../AGENTS.md");
        const linked = yield* read({ project });
        const canonical = find(linked, AGENTS);
        assert.strictEqual(hubInstructionStatus(find(linked, COPILOT), canonical), "linked");
        const done = yield* sync({
          project,
          source: { ...review(canonical), content: "Edited" },
          targets: [review(find(linked, COPILOT))],
          mode: "copy",
        });
        assert.deepEqual(done, [{ path: COPILOT, result: "unchanged" }]);
        assert.strictEqual(yield* fs.readLink(at(COPILOT)), "../AGENTS.md");
        assert.strictEqual(yield* fs.readFileString(at(COPILOT)), "Edited");
      }).pipe(withAdapters),
  );

  it.effect.skipIf(process.platform === "win32")(
    "rejects external links and directories and refuses unregistered paths",
    () =>
      Effect.gen(function* () {
        const { project, fs, at, read, sync } = yield* fixture;
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${outside}/private.md`, "Outside");
        yield* fs.symlink(`${outside}/private.md`, at(CLAUDE));
        yield* fs.symlink(outside, at(".github"));
        yield* fs.writeFileString(at(AGENTS), "Safe");
        const listed = yield* read({ project });
        const canonical = find(listed, AGENTS);
        for (const path of [CLAUDE, COPILOT]) {
          const blocked = find(listed, path);
          assert.isUndefined(blocked.content);
          assert.strictEqual(hubInstructionStatus(blocked, canonical), "unavailable");
          const refused = yield* Effect.flip(
            sync({
              project,
              source: review(canonical),
              targets: [{ ...review(blocked), replace: true }],
              mode: "copy",
            }),
          );
          assert.match(refused.message, /outside the project|symlink/);
        }
        for (const path of ["README.md", "../private.md", "/tmp/private.md"]) {
          const refused = yield* Effect.flip(
            sync({
              project,
              source: review(canonical),
              targets: [{ path, revision: "missing" }],
              mode: "copy",
            }),
          );
          assert.match(refused.message, /not a shared project instruction path/);
        }
        const arbitrary = yield* Effect.flip(
          sync({
            project,
            source: { path: "README.md", revision: "missing", content: "New" },
            targets: [],
            mode: "copy",
          }),
        );
        assert.match(arbitrary.message, /not a shared project instruction path/);
        assert.strictEqual(yield* fs.readFileString(`${outside}/private.md`), "Outside");
      }).pipe(withAdapters),
  );

  it.effect(
    "reports invalid text and circular references without exposing them, and refuses supplemental writes",
    () =>
      Effect.gen(function* () {
        const { project, fs, at, read, sync } = yield* fixture;
        yield* fs.writeFile(at(AGENTS), new Uint8Array([0xff, 0x00]));
        yield* fs.writeFileString(at(CLAUDE), "@CLAUDE.md\n");
        yield* fs.writeFileString(at("CLAUDE.local.md"), "Local");
        const files = yield* read({ project });
        assert.match(find(files, AGENTS).problem ?? "", /UTF-8/);
        assert.match(find(files, CLAUDE).problem ?? "", /circular/);
        const refused = yield* Effect.flip(
          sync({
            project,
            source: { ...review(find(files, "CLAUDE.local.md")), content: "" },
            targets: [],
            mode: "copy",
          }),
        );
        assert.match(refused.message, /not a shared project instruction path/);
      }).pipe(withAdapters),
  );

  it.effect("omits disabled providers' instruction files, folders, and provider tags", () => {
    const disabled: ReadonlyArray<ProviderId> = ["copilot", "cursor"];
    const settingsLayer = Layer.succeed(UserSettings, {
      get: Effect.succeed({ ...defaultSettings, disabledProviders: disabled }),
      update: () => Effect.die("unused"),
      changes: Stream.empty,
    });
    return Effect.gen(function* () {
      const { project, fs, at, read } = yield* fixture;
      yield* fs.makeDirectory(at(".cursor/rules"), { recursive: true });
      yield* fs.makeDirectory(at(".github"), { recursive: true });
      yield* fs.writeFileString(at(AGENTS), "Shared\n");
      yield* fs.writeFileString(at(COPILOT), "Shared\n");
      yield* fs.writeFileString(at(".cursor/rules/code.mdc"), "Cursor\n");
      const files = yield* read({ project });
      assert.isFalse(files.some((file) => file.path === COPILOT));
      assert.isFalse(files.some((file) => file.path === ".cursor/rules/code.mdc"));
      const canonical = find(files, AGENTS);
      assert.isFalse(canonical.providers.includes("copilot"));
      assert.isFalse(canonical.providers.includes("cursor"));
      const claude = find(files, CLAUDE);
      assert.isFalse(claude.providers.includes("copilot"));
      assert.isFalse(claude.providers.includes("cursor"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AdaptersLive, settingsLayer).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });
});
