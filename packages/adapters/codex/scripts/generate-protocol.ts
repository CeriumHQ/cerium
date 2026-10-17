// Regenerates src/protocol from the user's installed Codex (`codex app-server generate-ts`), so the
// adapter is typed against the exact app-server protocol it was tested with. Stable surface only:
// Cerium uses no experimental methods.
//
// Usage: node packages/adapters/codex/scripts/generate-protocol.ts [path-to-codex]
// Then run `node_modules/.bin/vp check --fix packages/adapters/codex` to format the output.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const executable = process.argv[2] ?? "codex";
const out = join(import.meta.dirname, "..", "src", "protocol");

rmSync(out, { recursive: true, force: true });
execFileSync(executable, ["app-server", "generate-ts", "--out", out], { stdio: "inherit" });

// The generator writes extensionless relative imports (`./X`, `./v2`); the repo resolves modules as
// `nodenext`, which needs the file itself (`./X.ts`, `./v2/index.ts`). Generated code is not linted
// (e.g. `CodexErrorInfo` unions string literals with `string`).
const files = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });

for (const file of files(out)) {
  const source = readFileSync(file, "utf8");
  const rewritten = source.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (match: string, open: string, specifier: string, close: string) => {
      if (specifier.endsWith(".ts")) return match;
      const isDirectory = existsSync(join(dirname(file), specifier, "index.ts"));
      return `${open}${specifier}${isDirectory ? "/index.ts" : ".ts"}${close}`;
    },
  );
  writeFileSync(file, `/* oxlint-disable */\n${rewritten}`);
}

const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
console.log(`Generated ${files(out).length} files from ${version} into ${out}`);
