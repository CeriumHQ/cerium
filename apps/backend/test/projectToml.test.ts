import { describe, expect, it } from "@effect/vitest";

import { editProjectFile, readProjectFile, tomlString } from "../src/projectToml.ts";

// What a project's `.cerium.toml` is read for, and that writing Cerium's two sections back leaves
// the team's own file as it was.

describe("readProjectFile", () => {
  it("reads the scripts and the named actions in file order", () => {
    const file = readProjectFile(
      '[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n\n[actions]\ntest = "bun test"\nlint = "bun run lint"\n',
    );
    expect(file.scripts).toEqual({ setup: "bun install", run: "bun run dev" });
    expect(file.actions).toEqual([
      { name: "test", command: "bun test" },
      { name: "lint", command: "bun run lint" },
    ]);
  });

  it("reads a command with quotes in it, as a literal or an escaped string", () => {
    const file = readProjectFile('[scripts]\nrun = \'echo "hi"\'\nsetup = "echo \\"hi\\" \\\\ \\u00e9"\n');
    expect(file.scripts).toEqual({ run: 'echo "hi"', setup: 'echo "hi" \\ é' });
  });

  it("keeps a # inside a command and drops the comment after it", () => {
    expect(readProjectFile("[scripts]\nrun = 'make #1' # the first\n").scripts).toEqual({ run: "make #1" });
  });

  it("reads quoted action names and leaves out the ones with no command", () => {
    expect(readProjectFile('[actions]\n"Run migrations" = "bun run migrate"\nempty = ""\n').actions).toEqual([
      { name: "Run migrations", command: "bun run migrate" },
    ]);
  });

  it("takes only the two top-level sections, not their subsections or other tables", () => {
    const file = readProjectFile(
      '[profile]\nrun = "wrong"\n[scripts.more]\nsetup = "wrong"\n[scripts]\nrun = "right"\n[[actions]]\ntest = "wrong"\n',
    );
    expect(file.scripts).toEqual({ run: "right" });
    expect(file.actions).toEqual([]);
  });

  it("is not fooled by a header inside a multi-line string", () => {
    const file = readProjectFile(
      '[notes]\ntext = """\n[scripts]\nrun = "wrong"\n"""\n[scripts]\nrun = "right"\n',
    );
    expect(file.scripts).toEqual({ run: "right" });
  });

  it("reads a file with a byte-order mark and Windows line endings", () => {
    expect(readProjectFile('\uFEFF[scripts]\r\nsetup = "bun install"\r\n').scripts).toEqual({
      setup: "bun install",
    });
  });

  it("distinguishes quoted keys containing spaces or dots from actual tables", () => {
    const text =
      '["scr ipts"]\nrun = "keep"\n["scripts.more"]\nrun = "also keep"\n["scripts"]\nrun = "right"\n';
    expect(readProjectFile(text).scripts).toEqual({ run: "right" });
    expect(editProjectFile(text, { scripts: { run: "new" } })).toBe(
      text.replace('run = "right"', 'run = "new"'),
    );
  });

  it("keeps tolerant duplicate handling when a file is invalid", () => {
    const text = '[scripts]\nrun = "first"\nrun = "last"\n';
    expect(readProjectFile(text).scripts).toEqual({ run: "last" });
    expect(editProjectFile(text, { scripts: { run: "new" } })).toBe('[scripts]\nrun = "new"\n');
  });
});

describe("tomlString", () => {
  it("quotes plainly when nothing needs escaping, and falls back to a literal string", () => {
    expect(tomlString("bun run dev")).toBe('"bun run dev"');
    expect(tomlString('node -e "x"')).toBe("'node -e \"x\"'");
    expect(tomlString("copy C:\\a\\b")).toBe("'copy C:\\a\\b'");
  });

  it("escapes what a literal string can't hold", () => {
    expect(tomlString('it\'s "x"')).toBe('"it\'s \\"x\\""');
    expect(tomlString("a\nb\tc")).toBe('"a\\nb\\tc"');
  });

  it("reads back as written", () => {
    for (const command of [
      "bun run dev",
      "echo \"a\" && echo 'b'",
      "C:\\tools\\run.cmd --x",
      "a\nb",
      "ü #1",
    ]) {
      expect(readProjectFile(`[scripts]\nrun = ${tomlString(command)}\n`).scripts["run"]).toBe(command);
    }
  });
});

describe("editProjectFile", () => {
  it("makes the file when there is none", () => {
    expect(editProjectFile("", { scripts: { setup: "bun install", run: "bun run dev" } })).toBe(
      '[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n',
    );
  });

  it("adds the scripts section to a file that has other sections, leaving them as they are", () => {
    const text = '# Team config\n[package]\nname = "x" # keep\n\n\n';
    expect(editProjectFile(text, { scripts: { run: "bun run dev" } })).toBe(
      '# Team config\n[package]\nname = "x" # keep\n\n[scripts]\nrun = "bun run dev"\n',
    );
  });

  it("replaces a command in place, keeping its comment, its neighbours and the other keys", () => {
    const text =
      '[scripts]\n# what a worktree needs\nsetup = "npm install" # slow\nteardown = "rm -rf node_modules"\nrun = "npm start"\n\n[other]\nrun = "kept"\n';
    expect(editProjectFile(text, { scripts: { setup: "bun install", run: "bun run dev" } })).toBe(
      '[scripts]\n# what a worktree needs\nsetup = "bun install" # slow\nteardown = "rm -rf node_modules"\nrun = "bun run dev"\n\n[other]\nrun = "kept"\n',
    );
  });

  it("adds a missing command after the section's last one, not after its trailing blank lines", () => {
    expect(
      editProjectFile('[scripts]\nsetup = "bun install"\n\n[other]\nx = 1\n', {
        scripts: { run: "bun run dev" },
      }),
    ).toBe('[scripts]\nsetup = "bun install"\nrun = "bun run dev"\n\n[other]\nx = 1\n');
  });

  it("takes out a command the user cleared, and the section when nothing is left in it", () => {
    expect(
      editProjectFile('[a]\nx = 1\n\n[scripts]\nrun = "bun run dev"\n', { scripts: { run: null } }),
    ).toBe("[a]\nx = 1\n");
    expect(
      editProjectFile('[scripts]\nsetup = "a"\nrun = "b"\n\n[a]\nx = 1\n', { scripts: { run: null } }),
    ).toBe('[scripts]\nsetup = "a"\n\n[a]\nx = 1\n');
    expect(editProjectFile('[scripts]\n# why\nrun = "b"\n', { scripts: { run: null } })).toBe(
      "[scripts]\n# why\n",
    );
  });

  it("leaves the file alone when there is nothing to put in a missing section", () => {
    const text = "[a]\nx = 1\n";
    expect(editProjectFile(text, { scripts: { run: null }, actions: [] })).toBe(text);
  });

  it("writes the actions as the whole section, in place", () => {
    const text = '[scripts]\nrun = "x"\n\n[actions]\n# checks\ntest = "bun test"\nold = "gone"\n';
    expect(
      editProjectFile(text, {
        scripts: {},
        actions: [
          { name: "test", command: "bun run test" },
          { name: "Run migrations", command: "bun run migrate" },
        ],
      }),
    ).toBe(
      '[scripts]\nrun = "x"\n\n[actions]\n# checks\ntest = "bun run test"\n"Run migrations" = "bun run migrate"\n',
    );
  });

  it("removes the actions section when the last action goes", () => {
    expect(
      editProjectFile('[actions]\ntest = "bun test"\n\n[a]\nx = 1\n', { scripts: {}, actions: [] }),
    ).toBe("[a]\nx = 1\n");
  });

  it("keeps Windows line endings and a byte-order mark", () => {
    const text = '\uFEFF[package]\r\nname = "x"\r\n';
    expect(editProjectFile(text, { scripts: { run: "go run ." } })).toBe(
      '\uFEFF[package]\r\nname = "x"\r\n\r\n[scripts]\r\nrun = "go run ."\r\n',
    );
  });

  it("writes commands the file can read back, quotes and backslashes included", () => {
    const edited = editProjectFile("", {
      scripts: { setup: "echo \"a\" && echo 'b'", run: "C:\\tools\\run.cmd" },
      actions: [{ name: "t", command: 'bun test --grep "x y"' }],
    });
    expect(readProjectFile(edited)).toEqual({
      scripts: { setup: "echo \"a\" && echo 'b'", run: "C:\\tools\\run.cmd" },
      actions: [{ name: "t", command: 'bun test --grep "x y"' }],
    });
  });

  it("replaces a multi-line value whole", () => {
    const text = '[scripts]\nrun = """\nbun run dev\n"""\nsetup = "a"\n';
    expect(editProjectFile(text, { scripts: { run: "bun run dev" } })).toBe(
      '[scripts]\nrun = "bun run dev"\nsetup = "a"\n',
    );
  });

  it("refuses a file that sets its scripts inline, which a section of its own would repeat", () => {
    expect(() => editProjectFile('scripts = { run = "x" }\n', { scripts: { run: "y" } })).toThrow(
      /inline|without/,
    );
  });
});
