import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const commands = ["login", "logout", "run", "status", "service", "update"] as const;
const actions = ["install", "uninstall", "start", "stop", "restart", "logs"] as const;
type Command = (typeof commands)[number];
export type ServiceAction = (typeof actions)[number];
type Channel = "stable" | "nightly" | "dev";

const definitions = {
  "data-dir": { type: "string" },
  "relay-url": { type: "string" },
  name: { type: "string" },
  "no-browser": { type: "boolean" },
  channel: { type: "string" },
  version: { type: "string" },
  json: { type: "boolean" },
  check: { type: "boolean" },
  follow: { type: "boolean", short: "f" },
} as const;

const options: Record<Command, (keyof typeof definitions)[]> = {
  login: ["name", "no-browser", "data-dir", "relay-url"],
  logout: ["data-dir", "relay-url"],
  run: ["data-dir", "relay-url", "name", "channel"],
  status: ["data-dir", "relay-url", "json"],
  service: ["data-dir", "relay-url", "name", "channel", "follow"],
  update: ["channel", "version", "check"],
};

export const help = `Usage: cerium-host <command> [options]

  login    [--name <label>] [--no-browser] [--data-dir <dir>] [--relay-url <url>]
  logout   [--data-dir <dir>] [--relay-url <url>]
  run      [--name <label>] [--channel stable|nightly|dev] [--data-dir <dir>] [--relay-url <url>]
  status   [--json] [--data-dir <dir>] [--relay-url <url>]
  service  install|uninstall|start|stop|restart|logs [-f|--follow] [--data-dir <dir>] [--relay-url <url>] [--name <label>]
  update   [--channel stable|nightly] [--version <v>] [--check]

  -h, --help      Show this help
  -v, --version   Print the installed version`;

const oneOf = <T extends string>(list: readonly T[], text: string | undefined): text is T =>
  list.some((item) => item === text);

export function parse(argv: string[]) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h") || argv[0] === "help")
    return { command: "help" } as const;
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version"))
    return { command: "version" } as const;
  const [command, ...rest] = argv;
  if (!oneOf(commands, command)) throw new Error(`Unknown command "${command}". See cerium-host --help.`);
  const action = command === "service" ? rest.shift() : undefined;
  if (command === "service" && !oneOf(actions, action))
    throw new Error(`Choose a service action: ${actions.join(", ")}.`);
  const allowed = Object.fromEntries(options[command].map((key) => [key, definitions[key]]));
  const { values } = parseArgs({ args: rest, options: allowed, strict: true });
  if (values["follow"] === true && action !== "logs")
    throw new Error("--follow is only supported with cerium-host service logs.");
  const string = (key: keyof typeof definitions) => {
    const value = values[key];
    if (typeof value !== "string") return undefined;
    if (!value.trim() || /\p{Cc}/u.test(value)) throw new Error(`Invalid value for --${key}.`);
    return value;
  };
  const channel = string("channel");
  if (
    channel &&
    !oneOf<Channel>(command === "update" ? ["stable", "nightly"] : ["stable", "nightly", "dev"], channel)
  )
    throw new Error(`Unsupported channel "${channel}".`);
  const name = string("name")?.trim();
  if (name && name.length > 64) throw new Error("Device names can contain up to 64 characters.");
  const relay = string("relay-url");
  let relayUrl: string | undefined;
  if (relay !== undefined) {
    const url = new URL(relay);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("--relay-url must be an HTTP or HTTPS URL without credentials, a query or a fragment.");
    relayUrl = url.href.replace(/\/+$/, "");
  }
  return {
    command,
    action: oneOf(actions, action) ? action : undefined,
    dataDirectory: resolve(string("data-dir") ?? join(homedir(), ".cerium")),
    relayUrl,
    name,
    channel: channel as Channel | undefined,
    version: string("version"),
    json: values["json"] === true,
    check: values["check"] === true,
    noBrowser: values["no-browser"] === true,
    follow: values["follow"] === true,
  } as const;
}
