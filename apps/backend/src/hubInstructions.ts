import type { HubInstructions } from "@cerium/harness";
import {
  HUB_CANONICAL_INSTRUCTIONS,
  hubInstructionStatus,
  type HubInstructionFile,
  type HubInstructionOutcome,
  type ProviderId,
} from "@cerium/protocol";
import { CeriumError, type HubInstructionSync } from "@cerium/rpc";
import { Effect, Semaphore } from "effect";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_BYTES = 128 * 1024;
const MAX_LINKS = 4;
const MISSING = "missing";

type Definitions = ReadonlyArray<readonly [ProviderId, HubInstructions]>;

interface Location {
  readonly path: string;
  readonly providers: ReadonlyArray<ProviderId>;
  readonly primary: boolean;
  readonly supplemental: boolean;
  readonly imports: boolean;
  readonly problem?: string;
}

interface Snapshot {
  readonly revision: string;
  readonly content?: string;
  readonly reference?: string;
  readonly problem?: string;
  readonly mode?: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const stat = (file: string) =>
  fs.lstat(file).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });

const digest = (parts: ReadonlyArray<string | number>) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const identity = (info: Stats) => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
const sameFile = (a: Stats, b: Stats) => identity(a).join(":") === identity(b).join(":");
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const within = (root: string, file: string) => {
  const part = relative(root, file);
  return part !== "" && part !== ".." && !part.startsWith("../") && !path.isAbsolute(part);
};

async function projectRoot(project: string) {
  if (!path.isAbsolute(project)) throw new Error("Choose an absolute project folder.");
  const root = await fs.realpath(project);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("The project must be a folder.");
  return root;
}

/** Project instruction locations may be links. Their containing folders must stay in the project. */
async function checkParents(root: string, file: string, create = false) {
  if (!within(root, file)) throw new Error("The instruction path is outside the project.");
  let folder = root;
  for (const part of relative(root, file).split("/").slice(0, -1)) {
    folder = path.join(folder, part);
    if (create) {
      await fs.mkdir(folder).catch((error: unknown) => {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST")
          throw error;
      });
    }
    const info = await stat(folder);
    if (info === undefined) return false;
    if (!info.isDirectory()) throw new Error("An instruction folder is a symlink or is not a directory.");
  }
  return true;
}

/** Standalone imports are references. A document that also gives instructions stays a document. */
const importedPath = (content: string) =>
  /^@((?:[.\w/-]|\\ )+\.(?:md|markdown))$/i.exec(content.trim())?.[1]?.replaceAll("\\ ", " ");

async function readText(file: string, info: Stats) {
  if (!info.isFile()) throw new Error("This instruction path is not a regular file.");
  if (info.size > MAX_BYTES) throw new Error("Instruction files can be at most 128 KiB.");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(opened, info)) {
      throw new Error("The instruction file changed while it was being read. Read again.");
    }
    const bytes = Buffer.alloc(Math.min(opened.size + 1, MAX_BYTES + 1));
    const { bytesRead } = await handle.read({ buffer: bytes });
    if (bytesRead !== opened.size || !sameFile(await handle.stat(), opened)) {
      throw new Error("The instruction file changed while it was being read. Read again.");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead),
      );
    } catch {
      throw new Error("The instruction file must be UTF-8 text.");
    }
    if (content.includes("\0")) throw new Error("The instruction file must be UTF-8 text.");
    return content;
  } finally {
    await handle.close();
  }
}

async function snapshot(
  root: string,
  file: string,
  catalog: ReadonlyMap<string, Location>,
  seen: ReadonlyArray<string> = [],
): Promise<Snapshot> {
  try {
    if (seen.includes(file) || seen.length > MAX_LINKS) {
      throw new Error("The instruction reference is circular or has too many links.");
    }
    if (!(await checkParents(root, file))) return { revision: MISSING };
    const info = await stat(file);
    if (info === undefined) return { revision: MISSING };
    const symlink = info.isSymbolicLink();
    const content = symlink ? await fs.readlink(file) : await readText(file, info);
    const revision = digest([...identity(info), content]);
    const link = symlink
      ? content
      : catalog.get(relative(root, file))?.imports
        ? importedPath(content)
        : undefined;
    if (link === undefined) return { revision, content, mode: info.mode };
    const target = path.resolve(path.dirname(file), link);
    if (!within(root, target)) throw new Error("The instruction reference points outside the project.");
    if (!catalog.has(relative(root, target)) && !/\.(?:md|markdown|mdc)$/i.test(target)) {
      throw new Error("The instruction reference must point to a project Markdown file.");
    }
    const resolved = await snapshot(root, target, catalog, [...seen, file]);
    const reference = resolved.reference ?? relative(root, target);
    const linkedRevision = digest([revision, resolved.revision]);
    if (resolved.content === undefined) {
      return {
        revision: linkedRevision,
        reference,
        problem: resolved.problem ?? "The instruction reference is broken.",
      };
    }
    return { revision: linkedRevision, reference, content: resolved.content, mode: info.mode };
  } catch (error) {
    return { revision: "unavailable", problem: messageOf(error) };
  }
}

async function listFolder(
  root: string,
  folder: string,
  suffix: string,
  recursive: boolean,
): Promise<string[]> {
  const full = path.join(root, folder);
  if (!(await checkParents(root, full))) return [];
  const info = await stat(full);
  if (info === undefined) return [];
  if (!info.isDirectory()) throw new Error("The rules folder is a symlink or is not a directory.");
  const files: string[] = [];
  for (const entry of await fs.readdir(full, { withFileTypes: true })) {
    const child = `${folder}/${entry.name}`;
    if (entry.isDirectory() && recursive) files.push(...(await listFolder(root, child, suffix, recursive)));
    if (!entry.isDirectory() && entry.name.endsWith(suffix)) files.push(child);
  }
  return files;
}

async function catalogOf(root: string, definitions: Definitions, includeRules: boolean) {
  const catalog = new Map<string, Location>();
  const add = (location: Location) => {
    const existing = catalog.get(location.path);
    catalog.set(
      location.path,
      existing === undefined
        ? location
        : {
            ...existing,
            providers: [...new Set([...existing.providers, ...location.providers])],
            primary: existing.primary || location.primary,
            supplemental: existing.supplemental && location.supplemental,
            imports: existing.imports || location.imports,
          },
    );
  };
  add({
    path: HUB_CANONICAL_INSTRUCTIONS,
    providers: [],
    primary: true,
    supplemental: false,
    imports: false,
  });
  for (const [provider, definition] of definitions) {
    for (const file of definition.files) {
      add({
        path: file.path,
        providers: [provider],
        primary: file.primary === true,
        supplemental: file.supplemental === true,
        imports: file.imports === true,
      });
    }
    if (!includeRules) continue;
    for (const folder of definition.folders ?? []) {
      const rule = { providers: [provider], primary: false, supplemental: true, imports: false };
      try {
        for (const file of await listFolder(root, folder.path, folder.suffix, folder.recursive === true)) {
          add({ ...rule, path: file });
        }
      } catch (error) {
        add({ ...rule, path: folder.path, problem: messageOf(error) });
      }
    }
  }
  return catalog;
}

async function inspect(root: string, location: Location, catalog: ReadonlyMap<string, Location>) {
  const current =
    location.problem === undefined
      ? await snapshot(root, path.join(root, location.path), catalog)
      : { revision: "unavailable", problem: location.problem };
  return {
    path: location.path,
    providers: location.providers,
    supplemental: location.supplemental,
    ...current,
  };
}

function expectRevision(file: HubInstructionFile, revision: string, allowReference = false) {
  if (file.revision !== revision)
    throw new Error(`${file.path} changed. Read again to review the latest version.`);
  if (file.problem !== undefined && !(allowReference && file.reference !== undefined)) {
    throw new Error(`${file.path}: ${file.problem}`);
  }
}

const referenceSource = (file: string): Location => ({
  path: file,
  providers: [],
  primary: false,
  supplemental: false,
  imports: false,
});

function canExposeReference(file: string, catalog: ReadonlyMap<string, Location>, definitions: Definitions) {
  return (
    !catalog.has(file) &&
    /\.(?:md|markdown)$/i.test(file) &&
    !file.endsWith(".local.md") &&
    !definitions.some(([, definition]) =>
      definition.folders?.some((folder) => file.startsWith(`${folder.path}/`)),
    )
  );
}

type Write = { readonly text: string } | { readonly symlink: string };

async function writeInstruction(
  root: string,
  file: HubInstructionFile & Snapshot,
  value: Write,
  recheck: () => Promise<void>,
) {
  const destination = path.join(root, file.path);
  await checkParents(root, destination, true);
  // An exclusive create handles new links. For text, stage the whole file before installing it.
  if ("symlink" in value && file.revision === MISSING) {
    await recheck();
    await fs.symlink(value.symlink, destination, "file");
    return;
  }
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), ".cerium-instructions-"));
  const temporary = path.join(staging, path.basename(destination));
  try {
    if ("symlink" in value) {
      await fs.symlink(value.symlink, temporary, "file");
    } else {
      await fs.writeFile(temporary, value.text, { flag: "wx" });
      if (file.mode !== undefined && file.reference === undefined)
        await fs.chmod(temporary, file.mode & 0o777);
    }
    await recheck();
    if (file.revision === MISSING) await fs.link(temporary, destination);
    else await fs.rename(temporary, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

const run = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => new CeriumError({ message: messageOf(error) }) });

/** One snapshot and compare-and-check workflow for all harnesses, serialized across Hub requests. */
export const makeHubInstructions = Effect.fn("Hub.makeInstructions")(function* (definitions: Definitions) {
  const lock = yield* Semaphore.make(1);

  const read = (project: string) =>
    lock.withPermit(
      run(async () => {
        const root = await projectRoot(project);
        const catalog = await catalogOf(root, definitions, true);
        const files: HubInstructionFile[] = [];
        const references = new Set<string>();
        for (const location of catalog.values()) {
          const { mode: _mode, ...file } = await inspect(root, location, catalog);
          if (location.primary || file.revision !== MISSING) files.push(file);
          if (!location.supplemental && file.reference !== undefined && file.problem === undefined) {
            references.add(file.reference);
          }
        }
        for (const file of references) {
          if (!canExposeReference(file, catalog, definitions)) continue;
          const { mode: _mode, ...current } = await inspect(root, referenceSource(file), catalog);
          if (current.content !== undefined && current.reference === undefined)
            files.push({ ...current, sourceOnly: true });
        }
        return files.sort((a, b) => a.path.localeCompare(b.path));
      }),
    );

  const sync = ({ project, source, targets, mode }: HubInstructionSync) =>
    lock.withPermit(
      run(async () => {
        const root = await projectRoot(project);
        const catalog = await catalogOf(root, definitions, false);
        const sourceLocation = catalog.get(source.path) ?? referenceSource(source.path);
        if (canExposeReference(source.path, catalog, definitions)) {
          for (const location of catalog.values()) {
            if (location.supplemental) continue;
            const current = await inspect(root, location, catalog);
            if (current.reference === source.path && current.problem === undefined) {
              catalog.set(source.path, sourceLocation);
              break;
            }
          }
        }
        const locationOf = (file: string) => {
          const location = catalog.get(file);
          if (location === undefined || location.supplemental) {
            throw new Error(`${file} is not a shared project instruction path.`);
          }
          return location;
        };
        const readFile = (file: string) => inspect(root, locationOf(file), catalog);
        const check = async (file: string, revision: string, allowReference = false) =>
          expectRevision(await readFile(file), revision, allowReference);

        const canonical = await readFile(source.path);
        expectRevision(canonical, source.revision);
        if (canonical.reference !== undefined)
          throw new Error("Choose the file that supplies the instructions.");
        const text = source.content ?? canonical.content;
        if (text === undefined) throw new Error("Enter instructions to create the canonical file.");
        const bytes = Buffer.from(text, "utf8");
        if (bytes.length > MAX_BYTES || text.includes("\0") || bytes.toString("utf8") !== text) {
          throw new Error("Instructions must be UTF-8 text of at most 128 KiB.");
        }
        if (locationOf(source.path).imports && importedPath(text) !== undefined) {
          throw new Error("Choose the imported file as the canonical file.");
        }

        // Validate the full batch before saving the source or touching any destination.
        const seen = new Set([source.path]);
        const destinations = [];
        for (const target of targets) {
          if (seen.has(target.path)) throw new Error(`${target.path} is already in this sync.`);
          seen.add(target.path);
          const file = await readFile(target.path);
          expectRevision(file, target.revision, true);
          const status = hubInstructionStatus(file, canonical);
          if (status === "diverged" && target.replace !== true) {
            throw new Error(
              `${target.path} differs from the canonical file. Approve its replacement to sync it.`,
            );
          }
          destinations.push({ file, status });
        }

        let savedRevision = canonical.revision;
        if (text !== canonical.content) {
          await writeInstruction(root, canonical, { text }, () => check(source.path, canonical.revision));
          const saved = await readFile(source.path);
          if (saved.content !== text || saved.reference !== undefined || saved.problem !== undefined) {
            throw new Error(`${source.path} changed after it was saved. Read again before syncing.`);
          }
          savedRevision = saved.revision;
        }

        const outcomes: HubInstructionOutcome[] = [];
        for (const { file, status } of destinations) {
          // Matching links already see the new source. Keep them even when syncing copies.
          if (
            status === "linked" ||
            (mode === "copy" && file.content === text && file.reference === undefined)
          ) {
            outcomes.push({ path: file.path, result: "unchanged" });
            continue;
          }
          const from = path.dirname(path.join(root, file.path));
          const target = relative(from, path.join(root, source.path));
          const importText = `@${target.replaceAll(" ", "\\ ")}\n`;
          const location = locationOf(file.path);
          // Prefer native Claude imports where the other readers can load the canonical file directly.
          const native =
            location.imports &&
            (location.providers.every((provider) => provider === "claude") ||
              (file.path === "CLAUDE.md" && source.path === HUB_CANONICAL_INSTRUCTIONS)) &&
            importedPath(importText) !== undefined;
          const value = mode === "copy" ? { text } : native ? { text: importText } : { symlink: target };
          try {
            if (mode === "copy" && location.imports && importedPath(text) !== undefined) {
              throw new Error("This harness would interpret the copy as an import. Sync it as a link.");
            }
            await writeInstruction(root, file, value, async () => {
              await check(source.path, savedRevision);
              await check(file.path, file.revision, true);
            });
            outcomes.push({ path: file.path, result: mode === "copy" ? "copied" : "linked" });
          } catch (error) {
            outcomes.push({ path: file.path, result: "skipped", problem: messageOf(error) });
          }
        }
        return outcomes;
      }).pipe(Effect.uninterruptible),
    );

  return { read, sync };
});
