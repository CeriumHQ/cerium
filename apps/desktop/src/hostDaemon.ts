import {
  isDaemonRunning,
  readRuntimeConnection,
  readRuntimeStatus,
  type RuntimeConnection,
} from "@cerium/backend/runtime";
import type { Channel } from "@cerium/protocol";
import { RPC_VERSION, TUNNEL_HELLO } from "@cerium/rpc";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SYSTEMD_UNIT = "cerium-host.service";
const LAUNCHD_LABEL = "app.cerium.host";
const WINDOWS_TASK = "Cerium Host";

const PROBE_TIMEOUT_MS = 3_000;
const STARTUP_WAIT_MS = 4_000;
const STARTUP_POLL_MS = 150;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

export interface HostServiceInfo {
  readonly installed: boolean;
  readonly dataDirectory: string;
  readonly candidateDirectories: ReadonlyArray<string>;
  readonly launcher?: readonly [string, string];
}

export type RpcCompatibility = "compatible" | "hostOutdated" | "desktopOutdated";

export type HostDiscoveryResult =
  | {
      readonly kind: "ready";
      readonly connection: RuntimeConnection;
      readonly serviceInstalled: boolean;
    }
  | {
      readonly kind: "incompatible";
      readonly direction: "hostOutdated" | "desktopOutdated";
      readonly dataDirectory: string;
      readonly version: string;
      readonly hostRpcVersion?: number;
      readonly expectedRpcVersion: number;
      readonly channel?: Channel;
      readonly serviceInstalled: boolean;
    }
  | {
      readonly kind: "unreachable";
      readonly dataDirectory: string;
      readonly connection?: RuntimeConnection;
      readonly serviceInstalled: boolean;
    }
  | {
      readonly kind: "serviceStopped";
      readonly dataDirectory: string;
      readonly serviceInstalled: true;
    }
  | {
      readonly kind: "absent";
    };

export const defaultHostDataDirectory = (home = homedir()): string => resolve(join(home, ".cerium"));

const unescapeXml = (value: string): string =>
  value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

const extractArgsMetadata = (
  argv: ReadonlyArray<string>,
): { readonly dataDirectory?: string; readonly launcher?: readonly [string, string] } => {
  let dataDirectory: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--data-dir=")) dataDirectory = resolve(arg.slice("--data-dir=".length));
    else if (arg === "--data-dir" && argv[i + 1]) dataDirectory = resolve(argv[++i]!);
  }
  const runIndex = argv.indexOf("run");
  const launcher =
    runIndex >= 2 && argv[0] && argv[1]
      ? ([argv[0], argv[1]] as const)
      : argv.length >= 2 && argv[0] && argv[1] && !argv[1].startsWith("-")
        ? ([argv[0], argv[1]] as const)
        : undefined;
  return {
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(launcher === undefined ? {} : { launcher }),
  };
};

/** Parses `ExecStart=...` from a systemd unit written by `cerium-host service install`. */
export const parseSystemdService = (
  content: string,
): { readonly dataDirectory?: string; readonly launcher?: readonly [string, string] } => {
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith("ExecStart="))
    ?.trimStart()
    .slice("ExecStart=".length)
    .trim();
  if (!line) return {};
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let token = "";
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          const next = line[++i]!;
          token += next === "n" ? "\n" : next === "r" ? "\r" : next;
        } else {
          token += line[i]!;
        }
        i++;
      }
      if (line[i] === '"') i++;
    } else {
      while (i < line.length && !/\s/.test(line[i]!)) token += line[i++]!;
    }
    args.push(token.replaceAll("%%", "%").replaceAll("$$", "$"));
  }
  return extractArgsMetadata(args);
};

/** Parses `ProgramArguments` from a macOS LaunchAgent plist written by `cerium-host service install`. */
export const parseLaunchdService = (
  content: string,
): { readonly dataDirectory?: string; readonly launcher?: readonly [string, string] } => {
  const match = content.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match?.[1]) return {};
  const args: string[] = [];
  for (const item of match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    if (item[1] !== undefined) args.push(unescapeXml(item[1]));
  }
  return extractArgsMetadata(args);
};

const parseWindowsCommandLine = (command: string): Array<string> => {
  const args: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i++;
    if (i >= command.length) break;
    let token = "";
    let quoted = false;
    while (i < command.length) {
      const ch = command[i]!;
      if (!quoted && /\s/.test(ch)) break;
      if (ch === "\\") {
        let count = 0;
        while (command[i] === "\\") {
          count++;
          i++;
        }
        if (command[i] === '"') {
          token += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            token += '"';
            i++;
          } else {
            quoted = !quoted;
            i++;
          }
        } else {
          token += "\\".repeat(count);
        }
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        i++;
        continue;
      }
      token += ch;
      i++;
    }
    args.push(token);
  }
  return args;
};

/** Parses `CERIUM_HOST_SERVICE_COMMAND` from the Windows VBS launcher written by `cerium-host`. */
export const parseWindowsService = (
  content: string,
): { readonly dataDirectory?: string; readonly launcher?: readonly [string, string] } => {
  const match = content.match(/env\("CERIUM_HOST_SERVICE_COMMAND"\)\s*=\s*"((?:[^"]|"")*)"/);
  if (!match?.[1]) return {};
  const command = match[1].replaceAll('""', '"');
  return extractArgsMetadata(parseWindowsCommandLine(command));
};

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const readUtf16OrUtf8 = (file: string): string | undefined => {
  try {
    const raw = readFileSync(file);
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
    return raw.toString("utf8");
  } catch {
    return undefined;
  }
};

const servicePaths = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) => ({
  systemd: join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "systemd", "user", SYSTEMD_UNIT),
  launchd: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  windowsVbs: join(home, ".cerium-service", "service.vbs"),
  platform,
});

export interface InspectHostServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly checkWindowsTask?: () => boolean;
}

/** Detects whether `cerium-host` is installed as a native OS service and which data directory it uses. */
export const inspectHostService = (options: InspectHostServiceOptions = {}): HostServiceInfo => {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const paths = servicePaths(platform, home, env);

  let installed = false;
  let parsed: { readonly dataDirectory?: string; readonly launcher?: readonly [string, string] } = {};
  if (platform === "linux") {
    const content = readText(paths.systemd);
    if (content !== undefined) {
      installed = true;
      parsed = parseSystemdService(content);
    }
  } else if (platform === "darwin") {
    const content = readText(paths.launchd);
    if (content !== undefined) {
      installed = true;
      parsed = parseLaunchdService(content);
    }
  } else if (platform === "win32") {
    installed =
      options.checkWindowsTask !== undefined
        ? options.checkWindowsTask()
        : spawnSync("schtasks", ["/Query", "/TN", WINDOWS_TASK], {
            stdio: "ignore",
            windowsHide: true,
          }).status === 0;
    if (installed) {
      const content = readUtf16OrUtf8(paths.windowsVbs);
      if (content !== undefined) parsed = parseWindowsService(content);
    }
  }

  const override = env["CERIUM_HOST_DATA_DIR"]?.trim();
  const defaultDir = defaultHostDataDirectory(home);
  if (override) {
    const resolved = resolve(override);
    return {
      installed,
      dataDirectory: resolved,
      candidateDirectories: [resolved],
      ...(parsed.launcher === undefined ? {} : { launcher: parsed.launcher }),
    };
  }
  const dataDirectory = parsed.dataDirectory ?? defaultDir;
  const candidateDirectories = dataDirectory === defaultDir ? [dataDirectory] : [dataDirectory, defaultDir];
  return {
    installed,
    dataDirectory,
    candidateDirectories,
    ...(parsed.launcher === undefined ? {} : { launcher: parsed.launcher }),
  };
};

export const checkRpcCompatibility = (
  hostRpcVersion: number | undefined,
  expectedRpcVersion = RPC_VERSION,
): RpcCompatibility => {
  if (hostRpcVersion === expectedRpcVersion) return "compatible";
  if (hostRpcVersion === undefined || hostRpcVersion < expectedRpcVersion) return "hostOutdated";
  return "desktopOutdated";
};

/** Verifies that a local RPC endpoint accepts this token and answers an Effect RPC ping. */
export const probeRpcEndpoint = (
  url: string,
  token: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> =>
  new Promise((resolveProbe) => {
    let settled = false;
    let socket: WebSocket | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close(1000);
      } catch {
        // Ignore close errors during probe cleanup.
      }
      resolveProbe(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    } catch {
      finish(false);
      return;
    }
    socket.addEventListener("open", () => {
      try {
        socket?.send(TUNNEL_HELLO);
      } catch {
        finish(false);
      }
    });
    socket.addEventListener("message", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
  });

const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export interface DiscoverHostDaemonOptions {
  readonly service?: HostServiceInfo;
  readonly expectedRpcVersion?: number;
  readonly startupWaitMs?: number;
  readonly pollMs?: number;
  readonly probe?: (url: string, token: string) => Promise<boolean>;
}

/**
 * Checks whether a live `cerium-host` daemon is running (or installed as a stopped service).
 * Returns `"absent"` for desktop-only installations with no running or installed host service.
 */
export const discoverHostDaemon = async (
  options: DiscoverHostDaemonOptions = {},
): Promise<HostDiscoveryResult> => {
  const service = options.service ?? inspectHostService();
  const expectedRpcVersion = options.expectedRpcVersion ?? RPC_VERSION;
  const startupWaitMs = options.startupWaitMs ?? STARTUP_WAIT_MS;
  const pollMs = options.pollMs ?? STARTUP_POLL_MS;
  const probe = options.probe ?? probeRpcEndpoint;

  for (const directory of service.candidateDirectories) {
    if (!isDaemonRunning(directory)) continue;

    let connection = readRuntimeConnection(directory);
    if (connection === undefined && startupWaitMs > 0) {
      const deadline = Date.now() + startupWaitMs;
      while (connection === undefined && Date.now() < deadline && isDaemonRunning(directory)) {
        await wait(pollMs);
        connection = readRuntimeConnection(directory);
      }
    }

    if (connection === undefined) {
      if (!isDaemonRunning(directory)) continue;
      const runtime = readRuntimeStatus(directory);
      if (runtime !== undefined) {
        return {
          kind: "incompatible",
          direction: "hostOutdated",
          dataDirectory: directory,
          version: runtime.version,
          expectedRpcVersion,
          serviceInstalled: service.installed,
        };
      }
      return {
        kind: "unreachable",
        dataDirectory: directory,
        serviceInstalled: service.installed,
      };
    }

    const compatibility = checkRpcCompatibility(connection.rpcVersion, expectedRpcVersion);
    if (compatibility !== "compatible") {
      return {
        kind: "incompatible",
        direction: compatibility,
        dataDirectory: directory,
        version: connection.version,
        hostRpcVersion: connection.rpcVersion,
        expectedRpcVersion,
        channel: connection.channel,
        serviceInstalled: service.installed,
      };
    }

    if (await probe(connection.url, connection.token)) {
      return { kind: "ready", connection, serviceInstalled: service.installed };
    }
    if (isDaemonRunning(directory)) {
      await wait(Math.min(250, pollMs));
      const fresh = readRuntimeConnection(directory);
      if (fresh !== undefined) {
        const freshCompatibility = checkRpcCompatibility(fresh.rpcVersion, expectedRpcVersion);
        if (freshCompatibility !== "compatible") {
          return {
            kind: "incompatible",
            direction: freshCompatibility,
            dataDirectory: directory,
            version: fresh.version,
            hostRpcVersion: fresh.rpcVersion,
            expectedRpcVersion,
            channel: fresh.channel,
            serviceInstalled: service.installed,
          };
        }
        if (await probe(fresh.url, fresh.token)) {
          return { kind: "ready", connection: fresh, serviceInstalled: service.installed };
        }
      }
    }
    return {
      kind: "unreachable",
      dataDirectory: directory,
      connection,
      serviceInstalled: service.installed,
    };
  }

  if (service.installed) {
    return { kind: "serviceStopped", dataDirectory: service.dataDirectory, serviceInstalled: true };
  }
  return { kind: "absent" };
};

const runAsync = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<{
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}> =>
  new Promise((resolveRun) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolveRun({
            ok: false,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            error: stderr?.trim() || stdout?.trim() || error.message,
          });
          return;
        }
        resolveRun({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

/** Starts the installed native `cerium-host` OS service asynchronously. */
export const startHostService = async (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (platform === "linux") {
    const result = await runAsync("systemctl", ["--user", "start", SYSTEMD_UNIT], { env });
    if (!result.ok) throw new Error(result.error || "Couldn't start cerium-host.service.");
    return;
  }
  if (platform === "darwin") {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Couldn't determine user id for launchctl.");
    const domain = `gui/${uid}`;
    const address = `${domain}/${LAUNCHD_LABEL}`;
    const plist = servicePaths(platform, home, env).launchd;
    const loaded = await runAsync("launchctl", ["print", address], { env });
    const start = loaded.ok
      ? await runAsync("launchctl", ["kickstart", "-k", address], { env })
      : await runAsync("launchctl", ["bootstrap", domain, plist], { env });
    if (!start.ok) throw new Error(start.error || "Couldn't start the Cerium Host LaunchAgent.");
    return;
  }
  if (platform === "win32") {
    const result = await runAsync("schtasks", ["/Run", "/TN", WINDOWS_TASK], { env });
    if (!result.ok) throw new Error(result.error || "Couldn't start the Cerium Host scheduled task.");
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
};

/** Locates the command and base arguments for running `cerium-host` on this machine. */
export const findHostUpdaterCommand = (
  service: HostServiceInfo,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly exists?: (path: string) => boolean;
  } = {},
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (service.launcher && exists(service.launcher[0]) && exists(service.launcher[1])) {
    return { command: service.launcher[0], args: [service.launcher[1]] };
  }
  const installRoot =
    env["CERIUM_HOST_DIR"] ||
    (platform === "win32"
      ? join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "CeriumHost")
      : join(home, ".local", "share", "cerium-host"));
  const standaloneNode = join(installRoot, "runtime", platform === "win32" ? "node.exe" : "bin/node");
  const standaloneScript = join(installRoot, "bin", "standalone.mjs");
  if (exists(standaloneNode) && exists(standaloneScript)) {
    return { command: standaloneNode, args: [standaloneScript] };
  }
  return { command: platform === "win32" ? "cerium-host.cmd" : "cerium-host", args: [] };
};

/** Runs `cerium-host update` locally to bring an outdated host daemon up to date. */
export const updateHostDaemon = async (options: {
  readonly service: HostServiceInfo;
  readonly channel?: Channel;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly ok: boolean; readonly output: string }> => {
  const { command, args } = findHostUpdaterCommand(options.service, {
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const updateArgs = [...args, "update", ...(options.channel === "nightly" ? ["--channel=nightly"] : [])];
  const result = await runAsync(command, updateArgs, {
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: UPDATE_TIMEOUT_MS,
  });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (!result.ok) {
    return {
      ok: false,
      output: output || result.error || "Run `cerium-host update` in a terminal to update Cerium Host.",
    };
  }
  return { ok: true, output };
};
