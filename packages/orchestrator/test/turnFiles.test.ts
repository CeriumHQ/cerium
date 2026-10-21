import type { AgentId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";

import { commandOf, FolderActivity, MAX_TURN_FILES, turnFiles, type TurnWork } from "../src/turnFiles.ts";

const a = "a" as AgentId;
const b = "b" as AgentId;

const work = (overrides: Partial<TurnWork>): TurnWork => ({
  named: new Set(),
  commands: [],
  namedByOthers: new Set(),
  shared: false,
  ...overrides,
});

describe("turn files", () => {
  it("takes the files the agent's edit tools named, with their lines", () => {
    const { files, more } = turnFiles(
      [
        { path: "src/b.ts", change: "modified" },
        { path: "src/a.ts", change: "added" },
        { path: "image.png", change: "modified" },
      ],
      [
        { path: "src/b.ts", added: 4, removed: 2 },
        { path: "src/a.ts", added: 10, removed: 0 },
        { path: "image.png" },
      ],
      work({ named: new Set(["src/b.ts", "src/a.ts", "image.png"]) }),
    );
    assert.strictEqual(more, 0);
    assert.deepStrictEqual(files, [
      { path: "image.png", change: "modified", via: "edit" },
      { path: "src/a.ts", change: "added", added: 10, removed: 0, via: "edit" },
      { path: "src/b.ts", change: "modified", added: 4, removed: 2, via: "edit" },
    ]);
  });

  it("leaves files no edit tool named when the turn ran no command", () => {
    const { files } = turnFiles([{ path: "notes.md", change: "modified" }], [], work({}));
    assert.deepStrictEqual(files, []);
  });

  it("credits a command with any file when the agent worked in the folder alone", () => {
    const { files } = turnFiles(
      [{ path: "out/gen.ts", change: "added" }],
      [],
      work({ commands: ["python scripts/build.py"] }),
    );
    assert.deepStrictEqual(files, [{ path: "out/gen.ts", change: "added", via: "command" }]);
  });

  it("credits a command beside other agents only with the files it names", () => {
    const { files } = turnFiles(
      [
        { path: "src/data.ts", change: "modified" },
        { path: "test.txt", change: "added" },
        { path: "other.ts", change: "modified" },
        { path: "theirs.ts", change: "modified" },
      ],
      [],
      work({
        commands: ["cat > test.txt <<'EOF'\nhi\nEOF", "sed -i s/a/b/ a.ts", "theirs.ts"],
        shared: true,
        namedByOthers: new Set(["theirs.ts"]),
      }),
    );
    // `a.ts` names neither `data.ts` nor `other.ts`; another agent's edit tool named `theirs.ts`.
    assert.deepStrictEqual(
      files.map((file) => file.path),
      ["test.txt"],
    );
  });

  it("names a file by its path with either slash", () => {
    const { files } = turnFiles(
      [{ path: "src/deep/index.ts", change: "modified" }],
      [],
      work({ commands: ["Set-Content src\\deep\\index.ts 'x'"], shared: true }),
    );
    assert.strictEqual(files.length, 1);
  });

  it("lists so many files and counts the rest", () => {
    const differing = Array.from({ length: MAX_TURN_FILES + 5 }, (_, index) => ({
      path: `f${String(index).padStart(4, "0")}.ts`,
      change: "added" as const,
    }));
    const { files, more } = turnFiles(differing, [], work({ commands: ["npm run codegen"] }));
    assert.strictEqual(files.length, MAX_TURN_FILES);
    assert.strictEqual(more, 5);
  });
});

describe("folder activity", () => {
  it("knows who else worked in the folder meanwhile, and what their edit tools named", () => {
    const activity = new FolderActivity();
    activity.begin(a, 100);
    activity.begin(b, 150);
    activity.name(a, 160, "mine.ts");
    activity.name(b, 170, "theirs.ts");
    activity.end(b, 150, 180);
    assert.isTrue(activity.shared(a, 100, 200));
    assert.isFalse(activity.shared(a, 190, 200));
    assert.deepStrictEqual([...activity.namedBy(a, 100, 200, false)], ["mine.ts"]);
    assert.deepStrictEqual([...activity.namedBy(a, 100, 200, true)], ["theirs.ts"]);
  });

  it("counts a turn still running as working", () => {
    const activity = new FolderActivity();
    activity.begin(b, 0);
    activity.begin(a, 10);
    activity.end(a, 10, 20);
    assert.isTrue(activity.shared(a, 10, 20));
  });
});

describe("commands", () => {
  it("reads the command a tool call runs", () => {
    assert.strictEqual(commandOf("Bash", { command: "ls" }), "ls");
    assert.strictEqual(commandOf("exec_command", { cmd: ["bash", "-lc", "ls"] }), "bash -lc ls");
    assert.strictEqual(commandOf("shell", {}), "shell");
    assert.isUndefined(commandOf("Read", { file_path: "a.ts" }));
    assert.isUndefined(commandOf("Edit", "a.ts"));
  });
});
