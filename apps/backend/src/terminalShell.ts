// What a terminal runs and with what: the shell it picks on each platform and the environment it
// gets. Plain functions of what they're told about the machine, so they can be tested anywhere.

/** A shell to start. */
export interface ShellChoice {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  /** Its name as a tab shows it. */
  readonly name: string;
}

/** What the choice depends on; `exists` says whether a file is there. */
export interface ShellHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (file: string) => boolean;
}

const separatorOf = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");
const joinPath = (platform: NodeJS.Platform, folder: string, file: string) => {
  const slash = platform === "win32" ? "\\" : "/";
  return folder.endsWith(slash) || folder.endsWith("/") ? `${folder}${file}` : `${folder}${slash}${file}`;
};

/** Where `program` is on PATH, when it is. */
export const onPath = (host: ShellHost, program: string): string | undefined => {
  const path = host.env["PATH"] ?? host.env["Path"] ?? "";
  for (const folder of path.split(separatorOf(host.platform))) {
    if (folder === "") continue;
    const candidate = joinPath(host.platform, folder.replace(/^"|"$/g, ""), program);
    if (host.exists(candidate)) return candidate;
  }
  return undefined;
};

/** How a shell's file is named in a tab. */
export const shellName = (file: string): string => {
  const base = (file.split(/[\\/]/).at(-1) ?? file).replace(/\.exe$/i, "");
  switch (base.toLowerCase()) {
    case "pwsh":
      return "PowerShell";
    case "powershell":
      return "Windows PowerShell";
    case "cmd":
      return "Command Prompt";
    default:
      return base === "" ? "Shell" : base;
  }
};

/**
 * The shell a terminal starts. On Windows, PowerShell 7 when it is installed, else Windows
 * PowerShell, else the command prompt. Elsewhere, the user's `$SHELL`, else zsh on a Mac and bash
 * where there is one; a Mac's shells start as login shells, as Terminal.app starts them.
 */
export const chooseShell = (host: ShellHost): ShellChoice => {
  const { platform, env } = host;
  if (platform === "win32") {
    const pwsh =
      onPath(host, "pwsh.exe") ??
      [env["ProgramFiles"], env["ProgramW6432"]]
        .flatMap((root) => (root ? [`${root}\\PowerShell\\7\\pwsh.exe`] : []))
        .find((candidate) => host.exists(candidate));
    if (pwsh !== undefined) return { file: pwsh, args: ["-NoLogo"], name: "PowerShell" };
    const root = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
    const windowsPowerShell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (host.exists(windowsPowerShell)) {
      return { file: windowsPowerShell, args: ["-NoLogo"], name: "Windows PowerShell" };
    }
    const cmd = env["ComSpec"] ?? `${root}\\System32\\cmd.exe`;
    return { file: cmd, args: [], name: "Command Prompt" };
  }
  const own = env["SHELL"];
  const file =
    own !== undefined && own !== "" && host.exists(own)
      ? own
      : ((platform === "darwin" ? ["/bin/zsh", "/bin/bash"] : ["/bin/bash"]).find((candidate) =>
          host.exists(candidate),
        ) ?? "/bin/sh");
  return { file, args: platform === "darwin" ? ["-l"] : [], name: shellName(file) };
};

/** Variables the shell must not inherit: they would make programs it starts act as part of Cerium. */
const WITHHELD = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_ENABLE_LOGGING"]);

/**
 * A harness's own command, such as `claude auth login`, run as the installed `executable` with the
 * words after the program's name. A Windows script shim runs through `cmd`, which is what starts one.
 */
export const commandChoice = (
  platform: NodeJS.Platform,
  executable: string,
  command: string,
): ShellChoice => {
  const [name = executable, ...args] = command.trim().split(/\s+/);
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    return { file: "cmd.exe", args: ["/d", "/c", executable, ...args], name };
  }
  return { file: executable, args, name };
};

/**
 * A project script, such as `bun install` or `bun run dev`, run as one shell of the kind the thread's
 * own terminals use: `command` goes through the chosen shell (`-Command`, `/c` or `-c`), so its words
 * and its pipes work as the user typed them.
 */
export const scriptChoice = (shell: ShellChoice, command: string): ShellChoice => {
  const name = (shell.file.split(/[\\/]/).at(-1) ?? shell.file).replace(/\.exe$/i, "").toLowerCase();
  switch (name) {
    case "pwsh":
    case "powershell":
      return { ...shell, args: ["-NoLogo", "-Command", command] };
    case "cmd":
      return { ...shell, args: ["/d", "/c", command] };
    default:
      return { ...shell, args: [...shell.args, "-c", command] };
  }
};

/** What a program Cerium starts for the user inherits of the backend's environment. */
export const inheritedEnv = (base: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !WITHHELD.has(key)) env[key] = value;
  }
  return env;
};

/** What a terminal's shell runs with: the backend's environment, set up for a terminal emulator. */
export const terminalEnv = (
  base: Readonly<Record<string, string | undefined>>,
  version: string,
): Record<string, string> => {
  return {
    ...inheritedEnv(base),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Cerium",
    TERM_PROGRAM_VERSION: version,
  };
};

/**
 * The exit code a shell ended with. A shell a signal ended counts as 128 plus the signal, as shells
 * themselves report it.
 */
export const exitCodeOf = (exit: {
  readonly exitCode: number;
  readonly signal?: number | undefined;
}): number => (exit.signal !== undefined && exit.signal > 0 ? 128 + exit.signal : Math.trunc(exit.exitCode));

/** The arguments that make `taskkill` end a process and everything it started. */
export const taskkillArgs = (pid: number): ReadonlyArray<string> => ["/pid", String(pid), "/T", "/F"];

/** The Windows build a ConPTY terminal runs on, from `os.release()` ("10.0.26300"); none elsewhere. */
export const windowsBuild = (platform: NodeJS.Platform, release: string): number | undefined => {
  if (platform !== "win32") return undefined;
  const build = Number(release.split(".")[2]);
  return Number.isInteger(build) && build > 0 ? build : undefined;
};
