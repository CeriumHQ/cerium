import { baseName, knownExtension, knownFileName } from "../../components/fileIcons/index.ts";

/** A file or folder an agent named in inline code. */
export interface PathReference {
  /** As written, without a line suffix or trailing separator. */
  readonly path: string;
  readonly folder: boolean;
  /** `:42` or `#L42` after the path. */
  readonly line?: number;
}

/** Characters that never appear in the paths agents cite, but do in code. */
const NOT_A_PATH = /[\s*?<>|"'`{}=,;!$%^&+]/;
const URL = /^[a-z][a-z\d+.-]*:\/\//i;
const ROOTED = /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[a-z]:[\\/])/i;
const LINE = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;

const isAbsolute = (path: string) => /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(path);

/** `path` on disk, when it can be told: absolute already, or relative to the thread's folder. */
export const resolvePath = (path: string, folder: string | undefined): string | undefined => {
  if (isAbsolute(path)) return path;
  if (folder === undefined) return undefined;
  const separator = folder.includes("\\") ? "\\" : "/";
  const relative = path.replace(/^\.[\\/]/, "").replaceAll(/[\\/]/g, separator);
  return `${folder.replace(/[\\/]+$/, "")}${separator}${relative}`;
};

const comparable = (path: string) => {
  const forward = path.replaceAll("\\", "/").replace(/\/+$/, "");
  // Windows paths don't care about case.
  return /^[a-z]:\//i.test(forward) || forward.startsWith("//") ? forward.toLowerCase() : forward;
};

/**
 * `location` (absolute) relative to `folder`, with forward slashes as mentions and agents write
 * them; undefined when it isn't inside the folder, or is the folder itself.
 */
export const relativePath = (location: string, folder: string | undefined): string | undefined => {
  if (folder === undefined) return undefined;
  const root = comparable(folder);
  if (!comparable(location).startsWith(`${root}/`)) return undefined;
  const relative = location
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .slice(root.length + 1)
    .replace(/^\/+/, "");
  // `../` climbs back out.
  if (relative === "" || relative.split("/").includes("..")) return undefined;
  return relative;
};

/**
 * Whether inline code names a file or folder, as agents write them: `CONTRIBUTING.md`, `.agents/`,
 * `apps/ui/src/App.tsx:42`. Code that merely contains dots or slashes (`Effect.gen`, `react-dom/client`,
 * `@cerium/protocol`, `scripts/_*`) stays code.
 */
export const pathReference = (code: string): PathReference | undefined => {
  const text = code.trim();
  if (text === "" || text.length > 300 || NOT_A_PATH.test(text) || URL.test(text)) return undefined;
  // Package names and flags.
  if (/^[@-]/.test(text)) return undefined;

  const lineMatch = LINE.exec(text);
  const bare = lineMatch ? text.slice(0, lineMatch.index) : text;
  const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined;
  const withLine = (reference: PathReference): PathReference =>
    line === undefined ? reference : { ...reference, line };

  if (/[\\/]$/.test(bare)) {
    const path = bare.replace(/[\\/]+$/, "");
    // `/` alone, or something like `and/`.
    if (path === "" || !/[\w.]/.test(path)) return undefined;
    return { path, folder: true };
  }

  const name = baseName(bare);
  if (name === "" || (name.startsWith(".") === false && !/[a-z\d]/i.test(name))) return undefined;
  if (knownExtension(name) !== undefined || knownFileName(name))
    return withLine({ path: bare, folder: false });

  // Without an extension, only an unmistakable path counts: rooted, or at least three segments deep.
  const segments = bare.split(/[\\/]/).filter(Boolean);
  if (ROOTED.test(bare) || segments.length >= 3) return withLine({ path: bare, folder: !name.includes(".") });
  return undefined;
};
