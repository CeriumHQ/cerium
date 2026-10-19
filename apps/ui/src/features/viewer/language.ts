// Which of Shiki's grammars a file is written in, by its name. Plain functions, so the worker and the
// tests share them.

/** Files known by their whole name rather than an extension. */
const byName: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  cmakelists: "cmake",
  "cmakelists.txt": "cmake",
  justfile: "just",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
  brewfile: "ruby",
  procfile: "shellscript",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "dotenv",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
  "go.mod": "go",
  "go.sum": "txt",
  "bun.lock": "jsonc",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".oxlintrc.json": "jsonc",
};

/** Extensions whose grammar goes by another name. */
const byExtension: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  htm: "html",
  xhtml: "html",
  svg: "xml",
  xaml: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  plist: "xml",
  yml: "yaml",
  py: "python",
  pyi: "python",
  pyw: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  fs: "fsharp",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  cmd: "bat",
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  cc: "cpp",
  cxx: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  jl: "julia",
  pl: "perl",
  pm: "perl",
  tf: "terraform",
  tfvars: "terraform",
  gql: "graphql",
  conf: "ini",
  cfg: "ini",
  properties: "properties",
  lock: "txt",
  log: "log",
  txt: "txt",
  jsonl: "jsonl",
  json5: "json5",
  webmanifest: "json",
  "code-workspace": "jsonc",
};

/**
 * The grammar for `path`, among `known` (Shiki's languages and their aliases); "txt" when none fits,
 * which shows the text uncoloured.
 */
export const languageOf = (path: string, known: (id: string) => boolean): string => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const named = byName[name] ?? (name.startsWith(".env.") ? "dotenv" : undefined);
  if (named !== undefined) return named;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return "txt";
  const extension = name.slice(dot + 1);
  const mapped = byExtension[extension] ?? extension;
  return known(mapped) ? mapped : "txt";
};
